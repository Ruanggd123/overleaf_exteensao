import os
import sys
import subprocess
import tempfile
import shutil
import logging
import json
import time
import zipfile
import io
import traceback
import threading
from pathlib import Path
from flask import Flask, request, jsonify, send_file, make_response
from flask_cors import CORS

# Configuração de Logs
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("server.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# ==================================================================================
#  FIREBASE ADMIN SETUP (SaaS Logic Local)
# ==================================================================================
FIREBASE_INITIALIZED = False
db = None
auth = None

try:
    import firebase_admin
    from firebase_admin import credentials, firestore, auth
    import base64
    
    # Credential Loading Logic:
    # 1. Environment Variable (Best for Cloud)
    # 2. Local JSON File (Best for Local Dev)
    # 3. Base64 Encoded File (Bypass for quick repo deployment)
    
    cred = None
    
    # Check Env Var
    if os.environ.get('FIREBASE_CREDENTIALS'):
        cred_dict = json.loads(os.environ.get('FIREBASE_CREDENTIALS'))
        cred = credentials.Certificate(cred_dict)
        logger.info("✅ Firebase credentials loaded from ENV")
        
    # Check Local JSON
    elif Path("serviceAccountKey.json").exists():
        cred = credentials.Certificate("serviceAccountKey.json")
        logger.info("✅ Firebase credentials loaded from JSON file")
        
    # Check Encoded File (Bypass)
    elif Path("firebase_secret.encoded").exists():
        try:
            with open("firebase_secret.encoded", "r") as f:
                b64_str = f.read().strip()
            json_str = base64.b64decode(b64_str).decode('utf-8')
            cred_dict = json.loads(json_str)
            cred = credentials.Certificate(cred_dict)
            logger.info("✅ Firebase credentials loaded from Encoded file")
        except Exception as e:
            logger.error(f"Failed to decode secret: {e}")

    if cred:
        firebase_admin.initialize_app(cred)
        db = firestore.client()
        FIREBASE_INITIALIZED = True
        logger.info("✅ Firebase Admin initialized successfully!")
    else:
        logger.warning("⚠️ No valid credentials found. SaaS mode disabled.")
        
except ImportError:
    logger.error("❌ firebase-admin not installed.")
except Exception as e:
    logger.error(f"❌ Error initializing Firebase: {str(e)}")

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
    """Busca assinatura ativa do Firestore."""
    try:
        # Busca assinatura
        subs_ref = db.collection('subscriptions')
        query = subs_ref.where('userId', '==', uid)\
                        .where('status', '==', 'active')\
                        .order_by('expiresAt', direction=firestore.Query.DESCENDING)\
                        .limit(1)
        docs = list(query.stream())
        
        sub_data = {'plan': 'free', 'status': 'expired'}
        if docs:
            d = docs[0].to_dict()
            sub_data = {
                'plan': d.get('plan', 'free'),
                'status': d.get('status'),
                'expiresAt': d.get('expiresAt')
            }
            
        return sub_data
    except Exception as e:
        logger.error(f"Erro ao buscar assinatura: {e}")
        return {'plan': 'free', 'status': 'error'}

def check_daily_limit(uid, plan_name):
    """Verifica e incrementa uso diário."""
    try:
        today = time.strftime('%Y-%m-%d')
        limit = PLANS.get(plan_name, PLANS['free'])['compilationsPerDay']
        
        usage_ref = db.collection('dailyUsage').document(f"{uid}_{today}")
        usage_doc = usage_ref.get()
        
        current_usage = 0
        if usage_doc.exists:
            current_usage = usage_doc.to_dict().get('count', 0)
        
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
        usage_ref = db.collection('dailyUsage').document(f"{uid}_{today}")
        # Set com merge para criar se não existir
        usage_ref.set({
            'userId': uid,
            'date': today,
            'count': firestore.INCREMENT(1),
            'lastUsed': firestore.SERVER_TIMESTAMP
        }, merge=True)
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
        
        user_ref = db.collection('users').document(uid)
        user_doc = user_ref.get()
        
        is_new = False
        if not user_doc.exists:
            is_new = True
            # Criar usuário
            user_ref.set({
                'email': email,
                'plan': 'free',
                'createdAt': firestore.SERVER_TIMESTAMP,
                'lastLogin': firestore.SERVER_TIMESTAMP,
                'hardwareFingerprint': hardware_id
            })
            
            # Criar Trial
            from datetime import datetime, timedelta
            expires = datetime.utcnow() + timedelta(days=1)
            db.collection('subscriptions').add({
                'userId': uid,
                'plan': 'free',
                'status': 'active',
                'isTrial': True,
                'startedAt': firestore.SERVER_TIMESTAMP,
                'expiresAt': expires
            })
        else:
            user_ref.update({'lastLogin': firestore.SERVER_TIMESTAMP})
            
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
        user_doc = db.collection('users').document(uid).get()
        if not user_doc.exists:
            return jsonify({'error': 'Usuário não encontrado'}), 404
            
        user_data = user_doc.to_dict()
        sub = get_user_subscription(uid)
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
        
        # Desativa anteriores
        old_subs = db.collection('subscriptions')\
                     .where('userId', '==', uid)\
                     .where('status', '==', 'active').get()
        for doc in old_subs:
            doc.reference.update({'status': 'cancelled'})
            
        # Cria nova
        from datetime import datetime, timedelta
        expires = datetime.utcnow() + timedelta(days=30)
        
        db.collection('subscriptions').add({
            'userId': uid,
            'plan': plan,
            'status': 'active',
            'startedAt': firestore.SERVER_TIMESTAMP,
            'expiresAt': expires,
            'paymentMethod': 'simulated_local'
        })
        
        db.collection('users').document(uid).update({'plan': plan})
        
        return jsonify({
            'success': True, 
            'message': f'Plano {plan} ativado (Simulação Local)!'
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
            project_cache_path = PROJECTS_CACHE_DIR / project_id
            if not project_cache_path.exists():
                project_cache_path.mkdir(parents=True)
                
            # Escrever arquivos no cache e copiar para temp
            for filename, content in files.items():
                file_path = project_cache_path / filename
                file_path.parent.mkdir(parents=True, exist_ok=True)
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(content)
            
            # Copiar tudo do cache para work_dir
            shutil.copytree(project_cache_path, work_dir, dirs_exist_ok=True)
            
            # Compilar
            cmd = [
                engine,
                '-interaction=nonstopmode',
                '-file-line-error',
                '-output-directory', str(work_dir),
                main_file
            ]
            
            # MiKTeX auto-install check
            if os.name == 'nt':
                 cmd.insert(1, '-enable-installer')
            
            result = subprocess.run(
                cmd,
                cwd=str(work_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=COMPILE_TIMEOUT
            )
            
            pdf_filename = Path(main_file).stem + '.pdf'
            pdf_path = work_dir / pdf_filename
            
            if pdf_path.exists():
                with open(pdf_path, 'rb') as f:
                    pdf_content = f.read()
                
                response = make_response(pdf_content)
                response.headers['Content-Type'] = 'application/pdf'
                response.headers['Content-Disposition'] = f'inline; filename={pdf_filename}'
                return response
            else:
                log_content = result.stdout.decode('latin-1', errors='ignore')
                return jsonify({'error': 'Compilation failed', 'logs': log_content}), 400
                
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Compilation timed out'}), 504
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# ==================================================================================
#  ROTAS LEGADAS (v2 sem auth ou para backward compatibility)
# ==================================================================================
# Para simplificar, desativaremos o /compile antigo se o modo SaaS estiver on,
# ou deixamos ativo mas sem verificar auth (não recomendado para hibrido).
# Vamos redirecionar /compile "raw" para a autenciada se tiver header.

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'online', 'mode': 'hybrid-saas' if FIREBASE_INITIALIZED else 'local-legacy'})

if __name__ == '__main__':
    print(f"🚀 Servidor Python Iniciado na porta {PORT}")
    if FIREBASE_INITIALIZED:
        print("🔒 Modo SaaS Híbrido: ATIVO (Firebase Conectado)")
    else:
        print("⚠️ Modo SaaS Híbrido: INATIVO (Falta serviceAccountKey.json)")
    app.run(host='0.0.0.0', port=PORT)
