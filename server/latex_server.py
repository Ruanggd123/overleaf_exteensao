import os
import sys
import subprocess
import tempfile
import shutil
import uuid
import logging
import json
import time
import zipfile
import io
import traceback
import threading
from pathlib import Path
import requests
import firebase_admin
from firebase_admin import credentials, auth, db
from flask import Flask, request, jsonify, send_file, render_template, make_response
from flask_cors import CORS

# Configuração de Logs
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Inicializar Flask
app = Flask(__name__, template_folder='templates')
CORS(app)

# ==================================================================================
#  ROUTES
# ==================================================================================

@app.route('/register', methods=['GET'])
def register_page():
    return render_template('register.html')

@app.route('/api/status', methods=['GET'])
def server_status():
    return jsonify({
        'status': 'online', 
        'mode': 'hybrid-saas',
        'version': '2.1.0'
    })

@app.route('/', methods=['GET'])
def root_status():
    return jsonify({'message': 'Overleaf Pro Server Running'})


# ==================================================================================
#  FIREBASE ADMIN SETUP (SaaS Logic Local)
# ==================================================================================
FIREBASE_INITIALIZED = False
db = None
auth = None



def initialize_firebase():
    global FIREBASE_INITIALIZED, db, auth
    
    try:
        import firebase_admin
        from firebase_admin import credentials, auth as firebase_auth_module, db as rtdb_module
        import base64
        import json
        
        cred_path = Path("serviceAccountKey.json")
        cred = None

        # Credential Loading Logic:
        # 1. Local JSON File (Best for Local Dev)
        if cred_path.exists():
            cred = credentials.Certificate(str(cred_path))
            logger.info("[OK] Firebase credentials loaded from JSON file")
            
        # 2. Environment Variable (Best for Cloud)
        elif os.environ.get('FIREBASE_CREDENTIALS'):
            try:
                cred_dict = json.loads(os.environ.get('FIREBASE_CREDENTIALS'))
                cred = credentials.Certificate(cred_dict)
                logger.info("[OK] Firebase credentials loaded from ENV")
            except Exception as e:
                logger.error(f"[ERROR] Failed to parse FIREBASE_CREDENTIALS env var: {e}")

        # 3. Base64 Encoded File (Legacy/Bypass)
        elif Path("firebase_secret.encoded").exists():
            try:
                with open("firebase_secret.encoded", "r") as f:
                    b64_str = f.read().strip()
                json_str = base64.b64decode(b64_str).decode('utf-8')
                cred_dict = json.loads(json_str)
                cred = credentials.Certificate(cred_dict)
                logger.info("[OK] Firebase credentials loaded from Encoded file")
            except Exception as e:
                logger.error(f"Failed to decode secret: {e}")

        if cred:
            # Check if already initialized to avoid error
            if not firebase_admin._apps:
                firebase_admin.initialize_app(cred, {
                    'databaseURL': 'https://extensao-asdsadas1q-default-rtdb.firebaseio.com'
                })
            
            db = rtdb_module # Usando Realtime Database
            auth = firebase_auth_module 
            FIREBASE_INITIALIZED = True
            logger.info("[OK] Firebase Admin (RTDB) initialized successfully!")
        else:
            logger.warning("[WARNING] No valid credentials found. SaaS mode disabled.")
            FIREBASE_INITIALIZED = False
            
    except ImportError:
        logger.error("[ERROR] firebase-admin not installed. SaaS mode disabled.")
        FIREBASE_INITIALIZED = False
    except Exception as e:
        logger.error(f"[ERROR] Error initializing Firebase: {str(e)}")
        FIREBASE_INITIALIZED = False

initialize_firebase()

# ==================================================================================
#  CONFIGURAÇÕES DO SERVIDOR
# ==================================================================================
PORT = int(os.environ.get('PORT', 8765))
COMPILE_TIMEOUT = int(os.environ.get('COMPILE_TIMEOUT', 300))
MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500MB
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH
PROJECTS_CACHE_DIR = Path("projects_cache")
PROJECTS_CACHE_DIR.mkdir(exist_ok=True)

# Planos
PLANS = {
    'free': {'compilationsPerDay': 5, 'name': 'Gratuito'},
    'basic': {'compilationsPerDay': 50, 'name': 'Básico'},
    'pro': {'compilationsPerDay': 500, 'name': 'Profissional'},
    'unlimited': {'compilationsPerDay': 999999, 'name': 'Ilimitado'}
}

# ==================================================================================
#  MIDDLEWARES & HELPERS
# ==================================================================================

def check_auth(f):
    """Decorator para verificar JWT do Firebase em endpoints protegidos."""
    def wrapper(*args, **kwargs):
        if not FIREBASE_INITIALIZED:
            return jsonify({'error': 'Servidor não configurado para SaaS (falta serviceAccountKey.json)'}), 503
        
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Token não fornecido'}), 401
        
        token = auth_header.split('Bearer ')[1]
        try:
            decoded_token = auth.verify_id_token(token)
            request.user = decoded_token
            return f(*args, **kwargs)
        except Exception as e:
            logger.error(f"Auth falhou: {e}")
            return jsonify({'error': 'Token inválido'}), 401
    
    wrapper.__name__ = f.__name__
    return wrapper

def get_user_subscription(uid):
    """Busca assinatura ativa do RTDB."""
    try:
        # Estrutura simplificada: users/{uid}/subscription
        ref = db.reference(f'users/{uid}/subscription')
        sub_data = ref.get()
        
        if sub_data and sub_data.get('status') == 'active':
             # Check expiration
             expires_at = sub_data.get('expiresAt')
             # Simple checking if needed, or trust DB
             return sub_data

        return {'plan': 'free', 'status': 'expired'}
    except Exception as e:
        logger.error(f"Erro ao buscar assinatura: {e}")
        return {'plan': 'free', 'status': 'error'}

def check_daily_limit(uid, plan_name):
    """Verifica e incrementa uso diário."""
    try:
        today = time.strftime('%Y-%m-%d')
        limit = PLANS.get(plan_name, PLANS['free'])['compilationsPerDay']
        
        ref = db.reference(f'dailyUsage/{uid}_{today}')
        usage_data = ref.get()
        
        current_usage = 0
        if usage_data:
            current_usage = usage_data.get('count', 0)
        
        if current_usage >= limit:
            return False, limit, current_usage
            
        return True, limit, current_usage
    except Exception as e:
        logger.error(f"Erro ao verificar limite: {e}")
        # Em caso de erro no banco, permite (fail open) ou nega? Vamos permitir por segurança do UX
        return True, 5, 0

def increment_usage(uid):
    """Incrementa contador de uso."""
    try:
        today = time.strftime('%Y-%m-%d')
        ref = db.reference(f'dailyUsage/{uid}_{today}')
        
        # Transactional increment
        def increment_tx(current_val):
            if current_val is None:
                return {'count': 1, 'date': today, 'userId': uid, 'lastUsed': int(time.time() * 1000)}
            current_val['count'] = (current_val.get('count', 0) + 1)
            current_val['lastUsed'] = int(time.time() * 1000)
            return current_val

        ref.transaction(increment_tx)
    except Exception as e:
        logger.error(f"Erro ao incrementar uso: {e}")

# ==================================================================================
#  API ENDPOINTS (SaaS)
# ==================================================================================

@app.route('/api/auth/sync', methods=['POST'])
@check_auth
def api_auth_sync():
    """Sincroniza usuário e cria trial se necessário."""
    try:
        uid = request.user['uid']
        email = request.user.get('email')
        data = request.json or {}
        hardware_id = data.get('hardwareId')
        
        user_ref = db.reference(f'users/{uid}')
        user_data = user_ref.get()
        
        is_new = False
        if not user_data:
            is_new = True
            
            # Setup Trial Dates
            from datetime import datetime, timedelta
            expires = (datetime.utcnow() + timedelta(days=1)).isoformat()
            
            # Create User + Subscription Atomically
            user_ref.set({
                'email': email,
                'plan': 'free',
                'createdAt': int(time.time() * 1000),
                'lastLogin': int(time.time() * 1000),
                'hardwareFingerprint': hardware_id,
                'subscription': {
                    'plan': 'free',
                    'status': 'active',
                    'isTrial': True,
                    'startedAt': int(time.time() * 1000),
                    'expiresAt': expires
                }
            })
        else:
            user_ref.update({'lastLogin': int(time.time() * 1000)})
            
        return jsonify({'message': 'Sincronizado', 'isNew': is_new})
        
    except Exception as e:
        logger.error(f"Erro /auth/sync: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/user/me', methods=['GET'])
@check_auth
def api_user_me():
    """Retorna dados do usuário e limtes."""
    try:
        uid = request.user['uid']
        user_ref = db.reference(f'users/{uid}')
        user_data = user_ref.get()
        
        if not user_data:
            return jsonify({'error': 'Usuário não encontrado'}), 404
            
        sub = user_data.get('subscription', {'plan': 'free', 'status': 'expired'})
        plan = sub.get('plan', 'free')
        
        allowed, limit, used = check_daily_limit(uid, plan)
        
        return jsonify({
            'user': {'email': user_data.get('email')},
            'subscription': {
                'plan': plan,
                'status': sub.get('status'),
                'dailyLimit': limit,
                'dailyUsed': used,
                'dailyRemaining': max(0, limit - used)
            }
        })
    except Exception as e:
        logger.error(f"Erro /user/me: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/subscription/purchase', methods=['POST'])
@check_auth
def api_purchase():
    """Simula compra."""
    try:
        uid = request.user['uid']
        plan = request.json.get('plan', 'pro')
        
        # Lógica de Compra:
        # Atualiza diretamente o nó subscription do usuário
        
        from datetime import datetime, timedelta
        expires = (datetime.utcnow() + timedelta(days=30)).isoformat()
        
        user_ref = db.reference(f'users/{uid}')
        
        # Atualiza plano no root do usuário e no obj subscription
        user_ref.update({
            'plan': plan,
            'subscription': {
                'plan': plan,
                'status': 'active', # Auto-aprovado!
                'startedAt': int(time.time() * 1000),
                'expiresAt': expires,
                'paymentMethod': 'simulated_local'
            }
        })
        
        return jsonify({
            'success': True, 
            'message': f'Plano {plan} ativado (Auto-Aprovado)!'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/compile', methods=['POST'])
@check_auth
def api_compile():
    """API de Compilação Protegida (SaaS)."""
    uid = request.user['uid']
    
    # 1. Verificar Limites
    sub = get_user_subscription(uid)
    allowed, limit, used = check_daily_limit(uid, sub.get('plan', 'free'))
    
    if not allowed:
        return jsonify({
            'error': f'Limite diário atingido ({limit}). Faça upgrade.',
            'code': 'DAILY_LIMIT'
        }), 403
        
    # 2. Registrar Uso
    increment_usage(uid)
    
    # 3. Encaminhar para lógica real de compilação
    # Como já estamos no servidor Python, chamamos a função local!
    return compile_real_logic()

# ==================================================================================
#  LÓGICA DE COMPILAÇÃO (Herdada da v2)
# ==================================================================================

def compile_real_logic():
    """Lógica original de compilação refatorada para ser chamada pela rota."""
    try:
        data = request.json
        files = data.get('files', {})
        main_file = data.get('mainFile', 'main.tex')
        engine = data.get('engine', 'pdflatex')
        project_id = data.get('projectId', 'temp_project')
        
        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = Path(temp_dir)
            
            # Setup Cache/Arquivos (Simplificado para brevidade)
            if is_zip:
                # Save and extract ZIP
                zip_path = work_dir / "project.zip"
                uploaded_file.save(zip_path)
                with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                    zip_ref.extractall(work_dir)
                
                # Auto-detect main file if default doesn't exist
                if not (work_dir / main_file).exists():
                    # Try to find a .tex file with \documentclass
                    tex_files = list(work_dir.glob('**/*.tex'))
                    for tex_file in tex_files:
                        try:
                            content = tex_file.read_text(encoding='utf-8', errors='ignore')
                            if '\\documentclass' in content:
                                main_file = str(tex_file.relative_to(work_dir))
                                break
                        except:
                            pass
            else:
                # Write individual files from JSON
                for filename, content in files_data.items():
                    file_path = work_dir / filename
                    file_path.parent.mkdir(parents=True, exist_ok=True)
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(content)

            # Ensure we have a main file
            if not (work_dir / main_file).exists():
                 return jsonify({'error': f'Main file "{main_file}" not found in project.'}), 400

            # Run LaTeX
            pdf_filename = Path(main_file).stem + '.pdf'
            
            # Helper to run command
            def run_latex():
                cmd = [
                    engine,
                    '-interaction=batchmode',
                    '-file-line-error',
                    '-output-directory', str(work_dir),
                    main_file
                ]
                # MiKTeX auto-install check
                if os.name == 'nt':
                    cmd.insert(1, '-enable-installer')
                return subprocess.run(
                    cmd,
                    cwd=str(work_dir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=COMPILE_TIMEOUT
                )

            # Run twice for references (bibtex handling could be added here)
            result = run_latex()
            
            # Simple BibTeX handling: if .aux exists, try running bibtex
            aux_file = work_dir / (Path(main_file).stem + '.aux')
            if aux_file.exists():
                subprocess.run(['bibtex', Path(main_file).stem], cwd=str(work_dir), timeout=10)
                run_latex() # Re-run latex after bibtex
                result = run_latex() # Final run

            pdf_path = work_dir / pdf_filename

            if pdf_path.exists():
                # Read PDF logs just in case or for debug
                with open(pdf_path, 'rb') as f:
                    pdf_data = f.read()
                
                # Update stats (async/fire-and-forget ideally, but here sync is fine)
                # update_usage_stats(user_id) 

                return send_file(
                    io.BytesIO(pdf_data),
                    mimetype='application/pdf',
                    as_attachment=True,
                    download_name='output.pdf'
                )
            else:
                # Look for log file
                log_file = work_dir / (Path(main_file).stem + '.log')
                log_content = ""
                if log_file.exists():
                    with open(log_file, 'r', encoding='latin-1', errors='ignore') as f:
                        log_content = f.read()
                else:
                    log_content = result.stdout.decode('latin-1', errors='ignore') + "\n" + result.stderr.decode('latin-1', errors='ignore')
                
                return jsonify({'error': 'Compilation failed', 'logs': log_content}), 400

    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Compilation timed out'}), 408
    except Exception as e:
        print(f"Server Error: {e}")
        return jsonify({'error': str(e)}), 500

# ==================================================================================
#  ROTAS LEGADAS (v2 sem auth ou para backward compatibility)
# ==================================================================================
# Para simplificar, desativaremos o /compile antigo se o modo SaaS estiver on,
# ou deixamos ativo mas sem verificar auth (não recomendado para hibrido).
# Vamos redirecionar /compile "raw" para a autenciada se tiver header.

# Duplicatas removidas.


if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 8765))
    print(f"[STARTED] Servidor Python Iniciado na porta {port}")
    if FIREBASE_INITIALIZED:
        print("[SECURE] Modo SaaS Híbrido: ATIVO (Firebase Conectado)")
    else:
        print("[WARNING] Modo SaaS Híbrido: INATIVO (Falta serviceAccountKey.json)")
    app.run(host='0.0.0.0', port=port)
