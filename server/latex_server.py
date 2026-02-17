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
import base64

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
        'mode': 'hybrid-saas' if FIREBASE_INITIALIZED else 'offline-local',
        'version': '2.2.0'
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
            logger.warning("[WARNING] No valid credentials found. Switching to OFFLINE MODE (No Auth/Credits).")
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

# ==================================================================================
#  SISTEMA DE CRÉDITOS (NOVO)
# ==================================================================================

# Planos com Créditos Iniciais (Mensal ou Único)
PLANS = {
    'free': {'initialCredits': 10, 'name': 'Gratuito'},
    'basic': {'initialCredits': 100, 'name': 'Básico'},
    'pro': {'initialCredits': 1000, 'name': 'Profissional'},
    'unlimited': {'initialCredits': 999999, 'name': 'Ilimitado'}
}

# ==================================================================================
#  MIDDLEWARES & HELPERS
# ==================================================================================

def check_auth(f):
    """Decorator para verificar JWT do Firebase em endpoints protegidos."""
    def wrapper(*args, **kwargs):
        # --- OFFLINE/LOCAL DEV MODE ---
        if not FIREBASE_INITIALIZED:
            # Bypass auth check completely for local dev
            logger.info("Bypassing auth check (Offline Mode)")
            request.user = {'uid': 'local_dev_user', 'email': 'local@dev.com'}
            return f(*args, **kwargs)
        # ------------------------------
        
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


def get_user_credits(uid):
    """Retorna créditos restantes do usuário."""
    try:
        # Estrutura: users/{uid}/credits
        ref = db.reference(f'users/{uid}/credits')
        current_credits = ref.get()
        
        if current_credits is None:
            # Se não tiver, define inicial do plano Free (migração)
            current_credits = PLANS['free']['initialCredits']
            ref.set(current_credits)
            
        return int(current_credits)
    except Exception as e:
        logger.error(f"Erro ao buscar créditos: {e}")
        return 0

def consume_credit(uid):
    """Consome 1 crédito. Retorna True se sucesso, False se sem saldo."""
    if not FIREBASE_INITIALIZED:
        return True, 999999 # Always succeed in offline mode

    try:
        ref = db.reference(f'users/{uid}/credits')
        
        def transaction_deduct(current_val):
            if current_val is None:
                return PLANS['free']['initialCredits'] - 1
            
            if current_val > 0:
                return current_val - 1
            else:
                return -1 # Sinal de sem crédito (abort transaction logic custom)
        
        current = ref.get()
        if current is None:
            current = PLANS['free']['initialCredits']
            
        if current > 0:
             ref.set(current - 1)
             return True, current - 1
        else:
             return False, 0
             
    except Exception as e:
        logger.error(f"Erro ao consumir crédito: {e}")
        return False, 0

# ==================================================================================
#  API ENDPOINTS (SaaS)
# ==================================================================================

@app.route('/api/auth/sync', methods=['POST'])
@check_auth
def api_auth_sync():
    """Sincroniza usuário e cria trial se necessário."""
    try:
        # --- OFFLINE MODE ---
        if not FIREBASE_INITIALIZED:
           return jsonify({'message': 'Sincronizado (Offline Mock)', 'isNew': False})
        # --------------------

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
                'credits': PLANS['free']['initialCredits'], # Novo: Créditos Iniciais
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
    """Retorna dados do usuário e créditos."""
    try:
        # --- OFFLINE MODE ---
        if not FIREBASE_INITIALIZED:
             return jsonify({
                'user': {'email': 'local@dev.com'},
                'subscription': {
                    'plan': 'local-dev',
                    'status': 'active',
                    'credits': 999999,
                    'dailyLimit': 999999,
                    'dailyUsed': 0,
                    'dailyRemaining': 999999
                }
            })
        # --------------------

        uid = request.user['uid']
        user_ref = db.reference(f'users/{uid}')
        user_data = user_ref.get()
        
        if not user_data:
            return jsonify({'error': 'Usuário não encontrado'}), 404
            
        sub = user_data.get('subscription', {'plan': 'free', 'status': 'expired'})
        plan = sub.get('plan', 'free')
        
        # Busca créditos
        credits = user_data.get('credits', 0)
        
        return jsonify({
            'user': {'email': user_data.get('email')},
            'subscription': {
                'plan': plan,
                'status': sub.get('status'),
                'credits': credits, # Novo campo
                # Campos antigos para compatibilidade (opcional)
                'dailyLimit': credits, 
                'dailyUsed': 0,
                'dailyRemaining': credits
            }
        })
    except Exception as e:
        logger.error(f"Erro /user/me: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/subscription/purchase', methods=['POST'])
@check_auth
def api_purchase():
    """Simula compra de pacotes de créditos/plano."""
    try:
        if not FIREBASE_INITIALIZED:
            return jsonify({'success': True, 'message': 'Offline Mock Purchase'})

        uid = request.user['uid']
        plan = request.json.get('plan', 'pro')
        
        credits_to_add = PLANS.get(plan, PLANS['free'])['initialCredits']
        
        user_ref = db.reference(f'users/{uid}')
        # Transactional add
        def add_credits(current_val):
            if current_val is None: return {'credits': credits_to_add}
            # Se for dict (nó user), atualiza credits
            current_credits = current_val.get('credits', 0)
            current_val['credits'] = current_credits + credits_to_add
            
            # Atualiza subscription metadata
            current_val['plan'] = plan
            current_val['subscription'] = {
                'plan': plan,
                'status': 'active',
                'paymentMethod': 'simulated_credit_pack'
            }
            return current_val

        user_ref.transaction(add_credits)
        
        return jsonify({
            'success': True, 
            'message': f'Pacote {plan} ativado! +{credits_to_add} créditos.'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/compile', methods=['POST'])
@check_auth
def api_compile():
    """API de Compilação Protegida (SaaS) com Créditos."""
    uid = request.user['uid']
    
    # 1. Tentar Consumir Crédito (ignorado se offline)
    success, new_balance = consume_credit(uid)
    
    if not success:
        return jsonify({
            'error': 'Você está sem créditos. Adquira mais para continuar compilando.',
            'code': 'NO_CREDITS' # Código específico para o frontend
        }), 403
        
    # 2. Encaminhar para lógica real de compilação
    return compile_real_logic()

@app.route('/api/sync', methods=['POST'])
# @check_auth # Start open for ease of use, can enable later
def api_sync_files():
    """Receives individual files and saves them to a local folder."""
    try:
        data = request.json
        project_id = data.get('projectId', 'unknown_project')
        files = data.get('files', {}) # { "path/to/file.tex": "content" }
        binary_files = data.get('binaryFiles', {}) # { "path/to/image.png": "base64_string" }
        
        # Determine target directory
        # We can use a 'Synced_Projects' folder in the server directory, or user home
        # For now, let's put it in "Synced_Projects" relative to where server runs
        target_dir = Path("Synced_Projects") / project_id
        target_dir.mkdir(parents=True, exist_ok=True)
        
        saved_count = 0
        
        # Save Text Files
        for rel_path, content in files.items():
            safe_path = Path(rel_path)
            if safe_path.is_absolute() or '..' in str(safe_path):
                continue # Security check
                
            file_path = target_dir / safe_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)
            saved_count += 1
            
        # Save Binary Files
        for rel_path, b64_content in binary_files.items():
            safe_path = Path(rel_path)
            if safe_path.is_absolute() or '..' in str(safe_path):
                continue
                
            file_path = target_dir / safe_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                # Remove header if present (e.g. "data:image/png;base64,...")
                if ',' in b64_content:
                    b64_content = b64_content.split(',')[1]
                
                with open(file_path, 'wb') as f:
                    f.write(base64.b64decode(b64_content))
                saved_count += 1
            except Exception as bin_err:
                logger.error(f"Error saving binary {rel_path}: {bin_err}")
            
        logger.info(f"Synced {saved_count} files for project {project_id}")
        return jsonify({'success': True, 'message': f'Synced {saved_count} files to {target_dir.absolute()}'})

    except Exception as e:
        logger.error(f"Sync error: {e}")
        return jsonify({'error': str(e)}), 500

# ==================================================================================
#  LÓGICA DE COMPILAÇÃO (Herdada da v2)
# ==================================================================================

def compile_real_logic():
    """Lógica ROBUSTA de compilação (BibTeX + Multi-pass) integrada à API."""
    try:
        # Check if JSON or Form Data
        is_json = request.is_json
        
        main_file = 'main.tex'
        engine = 'pdflatex'
        project_id = 'temp_project'
        files_data = {}
        binary_files_data = {}
        
        if is_json:
            data = request.json
            files_data = data.get('files', {})
            binary_files_data = data.get('binaryFiles', {})
            main_file = data.get('mainFile', 'main.tex')
            engine = data.get('engine', 'pdflatex')
            project_id = data.get('projectId', 'temp_project')
        else:
            # Fallback for Form Data
            if 'source_zip' in request.files:
                return jsonify({'error': 'Please use JSON format with individual files. ZIP upload is deprecated in this mode.'}), 415
            
            data = request.form
            main_file = data.get('mainFile', 'main.tex')
            engine = data.get('engine', 'pdflatex')

        # Use temp directory for compilation
        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = Path(temp_dir)
            
            # 1. Write Text Files
            for filename, content in files_data.items():
                file_path = work_dir / filename
                if file_path.is_absolute(): continue
                file_path.parent.mkdir(parents=True, exist_ok=True)
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(content)

            # 2. Write Binary Files
            for filename, b64_content in binary_files_data.items():
                file_path = work_dir / filename
                if file_path.is_absolute(): continue
                file_path.parent.mkdir(parents=True, exist_ok=True)
                try:
                    if ',' in b64_content:
                        b64_content = b64_content.split(',')[1]
                    with open(file_path, 'wb') as f:
                        f.write(base64.b64decode(b64_content))
                except Exception as e:
                    logger.error(f"Error writing binary file {filename}: {e}")

            # 3. Ensure we have a main file
            if not (work_dir / main_file).exists():
                 # Auto-detect
                 tex_files = list(work_dir.glob('**/*.tex'))
                 found = False
                 for tex_file in tex_files:
                     try:
                         content = tex_file.read_text(encoding='utf-8', errors='ignore')
                         if '\\documentclass' in content:
                             main_file = str(tex_file.relative_to(work_dir))
                             found = True
                             break
                     except:
                         pass
                 
                 if not found and tex_files:
                      main_file = str(tex_files[0].relative_to(work_dir))
                      found = True

                 if not found:
                     return jsonify({'error': f'Main file "{main_file}" not found and auto-detection failed.'}), 400

            # 4. Compilation Pipeline
            full_log = ""
            
            # Setup Command
            base_cmd = [
                engine,
                '-interaction=nonstopmode',
                '-file-line-error',
                '-output-directory', str(work_dir),
                main_file
            ]
            
            if os.name == 'nt':
                 # Avoid interactive prompts on Windows
                 os.environ['MIKTEX_ENABLEINSTALLER'] = 't' # Try to auto-install packages

            logger.info(f"Compiling {main_file} with {engine}...")

            # --- Pass 1 ---
            try:
                r1 = subprocess.run(
                    base_cmd,
                    cwd=str(work_dir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=COMPILE_TIMEOUT,
                    encoding='latin-1', errors='replace' # Use latin-1 for broad compatibility
                )
                full_log += f"--- Pass 1 ---\n{r1.stdout}\n{r1.stderr}\n"
            except subprocess.TimeoutExpired:
                 return jsonify({'error': 'Compilation timed out (Pass 1)'}), 408

            # --- Check BibTeX ---
            aux_file = work_dir / (Path(main_file).stem + '.aux')
            needs_bib = False
            if aux_file.exists():
                try:
                    aux_content = aux_file.read_text(encoding='latin-1', errors='ignore')
                    if '\\citation' in aux_content or '\\bibdata' in aux_content:
                        needs_bib = True
                except: pass

            if needs_bib:
                logger.info("Running BibTeX...")
                try:
                    rb = subprocess.run(
                        ['bibtex', Path(main_file).stem],
                        cwd=str(work_dir),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=30,
                        encoding='latin-1', errors='replace'
                    )
                    full_log += f"--- BibTeX ---\n{rb.stdout}\n{rb.stderr}\n"
                except FileNotFoundError:
                    full_log += "\n[WARN] BibTeX not found/installed.\n"
                except Exception as e:
                    full_log += f"\n[WARN] BibTeX error: {e}\n"

            # --- Pass 2 & 3 (if needed) ---
            # We always run at least one more pass if we ran bibtex, or if requested
            # For robustness, let's run Pass 2 always, and Pass 3 if "Rerun" in logs
            
            logger.info("Running Pass 2...")
            r2 = subprocess.run(
                base_cmd,
                cwd=str(work_dir),
                stdout=subprocess.PIPE, 
                stderr=subprocess.PIPE,
                timeout=COMPILE_TIMEOUT,
                encoding='latin-1', errors='replace'
            )
            full_log += f"--- Pass 2 ---\n{r2.stdout}\n{r2.stderr}\n"

            # Check for Rerun
            if 'Rerun to get cross-references right' in r2.stdout or 'There were undefined references' in r2.stdout:
                logger.info("Running Pass 3 (Rerun requested)...")
                r3 = subprocess.run(
                    base_cmd,
                    cwd=str(work_dir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=COMPILE_TIMEOUT,
                    encoding='latin-1', errors='replace'
                )
                full_log += f"--- Pass 3 ---\n{r3.stdout}\n{r3.stderr}\n"

            # 5. Return Result
            pdf_filename = Path(main_file).stem + '.pdf'
            pdf_path = work_dir / pdf_filename

            if pdf_path.exists():
                return send_file(
                    io.BytesIO(pdf_path.read_bytes()),
                    mimetype='application/pdf',
                    as_attachment=True,
                    download_name='output.pdf'
                )
            else:
                return jsonify({'error': 'Compilation failed (No PDF generated)', 'logs': full_log}), 400

    except Exception as e:
        logger.error(f"Server Error: {e}")
        return jsonify({'error': f"Internal Server Error: {str(e)}"}), 500

# ==================================================================================
#  ROTAS LEGADAS (v2 sem auth ou para backward compatibility)
# ==================================================================================

if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 8765))
    print(f"[STARTED] Servidor Python Iniciado na porta {port}")
    if FIREBASE_INITIALIZED:
        print("[SECURE] Modo SaaS Híbrido: ATIVO (Firebase Conectado)")
    else:
        print("[WARNING] Modo SaaS Híbrido: INATIVO (Falta serviceAccountKey.json)")
    app.run(host='0.0.0.0', port=port)
