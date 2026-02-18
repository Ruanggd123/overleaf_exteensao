#!/usr/bin/env python3
"""
Overleaf Hybrid Compiler - Servidor LaTeX
Roda em: Railway/Render (cloud) ou Localhost (desenvolvimento)
Free tier: Railway ($5/mês grátis) ou Render (750h/mês grátis)
"""

import os
import sys
import io
import shutil
import tempfile
import zipfile
import subprocess
import traceback
import json
import hashlib
from pathlib import Path
from functools import wraps
from datetime import datetime

from flask import Flask, request, send_file, jsonify, render_template_string
from flask_cors import CORS
from pdf2docx import Converter

# ═══════════════════════════════════════════════════════════════════
#  Configuration (Auto-detecta ambiente)
# ═══════════════════════════════════════════════════════════════════

IS_CLOUD = os.environ.get('RAILWAY_ENVIRONMENT') or os.environ.get('RENDER')
PORT = int(os.environ.get('PORT', '8765'))
HOST = '0.0.0.0'

# LaTeX Configuration
SUPPORTED_ENGINES = ['pdflatex', 'xelatex', 'lualatex']
DEFAULT_ENGINE = os.environ.get('LATEX_ENGINE', 'pdflatex')
BIBTEX_CMD = os.environ.get('BIBTEX_CMD', 'bibtex')
COMPILE_TIMEOUT = int(os.environ.get('COMPILE_TIMEOUT', '300'))

# Security
AUTH_TOKEN = os.environ.get('AUTH_TOKEN')  # Obrigatório em produção cloud
MAX_REQUEST_SIZE = int(os.environ.get('MAX_REQUEST_SIZE', '50'))  # MB

# Cache/Persistence
if IS_CLOUD:
    # Cloud: usa /tmp (ephemeral) ou volume persistente se configurado
    CACHE_DIR = os.environ.get('PERSISTENT_STORAGE', '/tmp/latex-cache')
else:
    # Local: pasta persistente no projeto
    CACHE_DIR = os.path.join(os.path.dirname(__file__), 'cache')

os.makedirs(CACHE_DIR, exist_ok=True)

app = Flask(__name__)
CORS(app, resources={
    r"/*": {
        "origins": "*",  # Em produção, restrinja via AUTH_TOKEN
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Authorization", "Content-Type"]
    }
})

app.config['MAX_CONTENT_LENGTH'] = MAX_REQUEST_SIZE * 1024 * 1024

# ═══════════════════════════════════════════════════════════════════
#  Security & Error Handling
# ═══════════════════════════════════════════════════════════════════

@app.errorhandler(Exception)
def handle_exception(e):
    tb = traceback.format_exc()
    print(f'[ERROR] {e}')
    print(tb)
    return jsonify({
        'error': f'Erro interno: {str(e)}',
        'log': tb[-3000:] if os.environ.get('DEBUG') else 'Erro interno do servidor'
    }), 500

@app.errorhandler(413)
def handle_too_large(e):
    return jsonify({'error': f'Arquivo muito grande (limite: {MAX_REQUEST_SIZE}MB).'}), 413

def require_auth(f):
    """Decorator para exigir autenticação em cloud."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if IS_CLOUD and AUTH_TOKEN:
            auth = request.headers.get('Authorization')
            if not auth or auth != f'Bearer {AUTH_TOKEN}':
                return jsonify({'error': 'Unauthorized - Token inválido'}), 401
        return f(*args, **kwargs)
    return decorated_function

# ═══════════════════════════════════════════════════════════════════
#  Utility Functions
# ═══════════════════════════════════════════════════════════════════

def detect_available_engines():
    """Detecta motores LaTeX disponíveis."""
    available = []
    for eng in SUPPORTED_ENGINES:
        if shutil.which(eng):
            available.append(eng)
    return available

def find_main_file(directory):
    """Encontra arquivo .tex principal."""
    tex_files = list(Path(directory).rglob('*.tex'))
    
    if not tex_files:
        return None
    
    # Prioridade: main.tex na raiz
    for f in tex_files:
        if f.name.lower() == 'main.tex' and f.parent == Path(directory):
            return str(f.relative_to(directory))
    
    # Qualquer main.tex
    for f in tex_files:
        if f.name.lower() == 'main.tex':
            return str(f.relative_to(directory))
    
    # Arquivo com \documentclass
    for f in tex_files:
        try:
            content = f.read_text(encoding='utf-8', errors='ignore')
            if '\\documentclass' in content:
                return str(f.relative_to(directory))
        except Exception:
            continue
    
    # Fallback: primeiro .tex
    return str(tex_files[0].relative_to(directory))

def get_project_cache_dir(project_id):
    """Retorna diretório de cache para um projeto."""
    if not project_id:
        return None
    # Hash para evitar path traversal
    safe_id = hashlib.sha256(project_id.encode()).hexdigest()[:16]
    return os.path.join(CACHE_DIR, safe_id)

def compile_project(directory, main_file, engine=None, project_id=None):
    """
    Pipeline de compilação LaTeX.
    """
    engine = engine if engine in SUPPORTED_ENGINES else DEFAULT_ENGINE
    
    if not shutil.which(engine):
        return {
            'success': False,
            'log': f'Motor LaTeX "{engine}" não encontrado.',
        }
    
    main_path = os.path.join(directory, main_file)
    if not os.path.isfile(main_path):
        return {
            'success': False,
            'log': f'Arquivo principal não encontrado: {main_file}',
        }
    
    work_dir = os.path.dirname(main_path) or directory
    main_basename = os.path.basename(main_file)
    
    base_cmd = [engine, '-interaction=nonstopmode', '-file-line-error',
                '-enable-installer', main_basename]
    
    env = os.environ.copy()
    env['MIKTEX_ENABLEINSTALLER'] = 't'
    env['TEXMFVAR'] = '/tmp/texmf-var'
    
    full_log = ''
    print(f'[Compile] Engine: {engine}, Main: {main_file}, Project: {project_id}')
    
    try:
        # Passo 1
        print('[Compile] Pass 1...')
        r1 = subprocess.run(
            base_cmd, cwd=work_dir, capture_output=True, text=True,
            timeout=COMPILE_TIMEOUT, env=env,
        )
        full_log += r1.stdout + '\n' + r1.stderr
        
        needs_bib = False
        needs_rerun = 'Rerun to get cross-references right' in r1.stdout
        
        aux_path = os.path.join(work_dir, os.path.splitext(main_basename)[0] + '.aux')
        if os.path.isfile(aux_path):
            try:
                aux_content = open(aux_path, 'r', encoding='utf-8', errors='ignore').read()
                needs_bib = '\\citation' in aux_content or '\\bibdata' in aux_content
            except Exception:
                pass
        
        # BibTeX
        if needs_bib and shutil.which(BIBTEX_CMD):
            bib_base = os.path.splitext(main_basename)[0]
            print('[Compile] Running BibTeX...')
            rb = subprocess.run(
                [BIBTEX_CMD, bib_base], cwd=work_dir, capture_output=True,
                text=True, timeout=60, env=env,
            )
            full_log += '\n--- BibTeX ---\n' + rb.stdout + '\n' + rb.stderr
            needs_rerun = True
        
        # Passos 2 e 3
        if needs_rerun:
            for i in range(2):
                print(f'[Compile] Pass {i + 2}...')
                ri = subprocess.run(
                    base_cmd, cwd=work_dir, capture_output=True, text=True,
                    timeout=COMPILE_TIMEOUT, env=env,
                )
                full_log += f'\n--- Pass {i + 2} ---\n' + ri.stdout + '\n' + ri.stderr
                if 'Rerun to get cross-references right' not in ri.stdout:
                    break
        
        # Verificar resultado
        actual_pdf = os.path.join(work_dir, os.path.splitext(main_basename)[0] + '.pdf')
        if os.path.isfile(actual_pdf):
            size_mb = os.path.getsize(actual_pdf) / (1024 * 1024)
            print(f'[Compile] [OK] PDF gerado ({size_mb:.1f} MB)')
            return {
                'success': True, 
                'pdf_path': actual_pdf, 
                'log': full_log
            }
        else:
            print('[Compile] [ERR] PDF não gerado')
            return {'success': False, 'log': full_log}
            
    except subprocess.TimeoutExpired:
        return {'success': False, 'log': f'Timeout ({COMPILE_TIMEOUT}s) expirado.'}
    except Exception as e:
        return {'success': False, 'log': f'Erro: {str(e)}'}

# ═══════════════════════════════════════════════════════════════════
#  Endpoints
# ═══════════════════════════════════════════════════════════════════

LANDING_PAGE = """
<!DOCTYPE html>
<html>
<head>
    <title>Overleaf Hybrid Compiler</title>
    <style>
        body { 
            font-family: system-ui, -apple-system, sans-serif; 
            max-width: 800px; 
            margin: 50px auto; 
            padding: 20px;
            background: #0f172a;
            color: #e2e8f0;
        }
        .status { 
            padding: 20px; 
            border-radius: 12px; 
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            border: 1px solid #475569;
        }
        .ok { color: #22c55e; }
        .warning { color: #f59e0b; }
        code { 
            background: #1e293b; 
            padding: 2px 6px; 
            border-radius: 4px;
            font-family: 'JetBrains Mono', monospace;
        }
        .env-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 10px;
        }
        .env-cloud { background: #3b82f6; color: white; }
        .env-local { background: #10b981; color: white; }
        h1 { margin-bottom: 8px; }
        .subtitle { color: #94a3b8; margin-bottom: 24px; }
    </style>
</head>
<body>
    <h1>🚀 Overleaf Hybrid Compiler</h1>
    <div class="subtitle">Compilador LaTeX para Overleaf - Online & Local</div>
    
    <div class="status">
        <span class="env-badge {{ 'env-cloud' if is_cloud else 'env-local' }}">
            {{ '☁️ MODO CLOUD' if is_cloud else '🖥️ MODO LOCAL' }}
        </span>
        
        <h2>Status do Servidor</h2>
        <p><strong>Status:</strong> <span class="ok">✓ Online</span></p>
        <p><strong>Motores disponíveis:</strong> {{ engines|join(', ') }}</p>
        <p><strong>Versão:</strong> 2.1.0-hybrid</p>
        <p><strong>Cache:</strong> <code>{{ cache_dir }}</code></p>
    </div>
    
    <h2>Endpoints</h2>
    <ul>
        <li><code>GET /status</code> - Health check</li>
        <li><code>POST /compile</code> - Compilar arquivos JSON</li>
        <li><code>POST /compile-zip</code> - Compilar ZIP</li>
    </ul>
    
    <h2>Configuração Extensão Chrome</h2>
    <p>URL do servidor: <code>{{ server_url }}</code></p>
    {% if auth_token %}
    <p>Token de acesso: <code>{{ auth_token[:8] }}...</code> (configurado)</p>
    {% else %}
    <p class="warning">⚠️ Sem token de autenticação (apenas local)</p>
    {% endif %}
</body>
</html>
"""

@app.route('/')
def index():
    """Página inicial com status."""
    engines = detect_available_engines()
    server_url = request.host_url.rstrip('/')
    
    return render_template_string(
        LANDING_PAGE,
        is_cloud=IS_CLOUD,
        engines=engines,
        cache_dir=CACHE_DIR,
        server_url=server_url,
        auth_token=AUTH_TOKEN
    )

@app.route('/status', methods=['GET'])
def status():
    """Health check endpoint."""
    engines = detect_available_engines()
    return jsonify({
        'status': 'ok',
        'engines': engines,
        'default_engine': DEFAULT_ENGINE,
        'compile_timeout': COMPILE_TIMEOUT,
        'is_cloud': bool(IS_CLOUD),
        'version': '2.1.0-hybrid',
        'timestamp': datetime.utcnow().isoformat()
    })

@app.route('/compile', methods=['POST'])
@require_auth
def compile_latex():
    """Compilar arquivos .tex enviados como JSON."""
    data = request.get_json(force=True)
    files = data.get('files', {})
    main_file = data.get('mainFile', 'main.tex')
    engine = data.get('engine', DEFAULT_ENGINE)
    project_id = data.get('projectId')
    
    if not files:
        return jsonify({'error': 'Nenhum arquivo recebido.'}), 400
    
    # Determinar diretório de trabalho
    if project_id:
        work_dir = get_project_cache_dir(project_id)
        os.makedirs(work_dir, exist_ok=True)
    else:
        work_dir = tempfile.mkdtemp(dir='/tmp' if IS_CLOUD else None, prefix='olc_')
    
    try:
        # Escrever arquivos
        for filename, content in files.items():
            filepath = os.path.join(work_dir, filename)
            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
        
        result = compile_project(work_dir, main_file, engine, project_id)
        
        if result['success']:
            with open(result['pdf_path'], 'rb') as f:
                pdf_data = io.BytesIO(f.read())
            
            response = send_file(
                pdf_data,
                mimetype='application/pdf',
                as_attachment=True,
                download_name='output.pdf'
            )
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        else:
            return jsonify({
                'error': 'Compilação falhou.',
                'log': result['log'][-5000:]
            }), 500
            
    finally:
        # Cleanup se não estiver usando cache persistente
        if not project_id and not IS_CLOUD:
            shutil.rmtree(work_dir, ignore_errors=True)

@app.route('/compile-zip', methods=['POST'])
@require_auth
def compile_zip():
    """Compilar projeto enviado como ZIP."""
    if 'project' not in request.files:
        return jsonify({'error': 'Nenhum arquivo ZIP recebido.'}), 400
    
    zip_file = request.files['project']
    engine = request.form.get('engine', DEFAULT_ENGINE)
    project_id = request.form.get('projectId')
    
    if project_id:
        work_dir = get_project_cache_dir(project_id)
        os.makedirs(work_dir, exist_ok=True)
    else:
        work_dir = tempfile.mkdtemp(dir='/tmp' if IS_CLOUD else None, prefix='olc_zip_')
    
    try:
        with zipfile.ZipFile(zip_file, 'r') as z:
            z.extractall(work_dir)
    except zipfile.BadZipFile:
        return jsonify({'error': 'Arquivo ZIP inválido.'}), 400
    
    main_file = find_main_file(work_dir)
    if not main_file:
        return jsonify({'error': 'Nenhum arquivo .tex encontrado no ZIP.'}), 400
    
    result = compile_project(work_dir, main_file, engine, project_id)
    
    if result['success']:
        with open(result['pdf_path'], 'rb') as f:
            pdf_data = io.BytesIO(f.read())
        
        response = send_file(
            pdf_data,
            mimetype='application/pdf',
            as_attachment=True,
            download_name='output.pdf'
        )
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    else:
        return jsonify({
            'error': 'Compilação falhou.',
            'log': result['log'][-5000:]
        }), 500

@app.route('/compile-delta', methods=['POST'])
@require_auth
def compile_delta():
    """Compilar usando atualização incremental (delta)."""
    project_id = request.form.get('projectId')
    engine = request.form.get('engine', DEFAULT_ENGINE)
    
    if not project_id:
        return jsonify({'error': 'Project ID obrigatório para compilação incremental.'}), 400

    work_dir = get_project_cache_dir(project_id)
    
    # Se o diretório não existe, o cache foi limpo ou nunca existiu.
    # Retorna 410 Gone para o cliente saber que deve enviar o ZIP completo.
    if not os.path.isdir(work_dir):
        return jsonify({'error': 'CACHE_MISS', 'message': 'Cache não encontrado. Envie ZIP completo.'}), 410

    try:
        # 1. Processar Deletes
        deleted_files_json = request.form.get('deleted_files')
        if deleted_files_json:
            try:
                deleted_files = json.loads(deleted_files_json)
                for filename in deleted_files:
                    # Garantir segurança do path
                    safe_filename = os.path.normpath(filename)
                    if safe_filename.startswith('..') or os.path.isabs(safe_filename):
                        continue
                        
                    file_path = os.path.join(work_dir, safe_filename)
                    if os.path.exists(file_path):
                        if os.path.isdir(file_path):
                            shutil.rmtree(file_path)
                        else:
                            os.remove(file_path)
                        print(f'[Delta] Deleted: {filename}')
            except json.JSONDecodeError:
                print('[Delta] Erro ao decodificar deleted_files')

        # 2. Processar Updates (Delta ZIP)
        if 'delta_zip' in request.files:
            delta_zip = request.files['delta_zip']
            # Se o ZIP não estiver vazio (tamanho > 0 ou valid zip header)
            # JSZip vazio tem ~22 bytes. 
            delta_zip.seek(0, os.SEEK_END)
            size = delta_zip.tell()
            delta_zip.seek(0)
            
            if size > 22: # header vazio zip
                try:
                    with zipfile.ZipFile(delta_zip, 'r') as z:
                        z.extractall(work_dir)
                        print(f'[Delta] Extracted {len(z.namelist())} updated files.')
                except zipfile.BadZipFile:
                    return jsonify({'error': 'Arquivo Delta ZIP inválido.'}), 400
        
        # 3. Compilar
        main_file = find_main_file(work_dir)
        if not main_file:
            return jsonify({'error': 'Nenhum arquivo .tex encontrado no projeto.'}), 400
        
        result = compile_project(work_dir, main_file, engine, project_id)
        
        if result['success']:
            with open(result['pdf_path'], 'rb') as f:
                pdf_data = io.BytesIO(f.read())
            
            response = send_file(
                pdf_data,
                mimetype='application/pdf',
                as_attachment=True,
                download_name='output.pdf'
            )
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        else:
            return jsonify({
                'error': 'Compilação falhou.',
                'log': result['log'][-5000:]
            }), 500

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'Erro processando delta: {str(e)}'}), 500

# ═══════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════
#  Additional Features: PDF to Word
# ═══════════════════════════════════════════════════════════════════

@app.route('/convert/word', methods=['POST'])
def convert_to_word():
    """
    Converte PDF para Word.
    Recebe um arquivo PDF via form-data 'pdf'.
    Retorna o arquivo .docx convertido.
    """
    if 'pdf' not in request.files:
        return jsonify({'error': 'Arquivo PDF não enviado.'}), 400
        
    pdf_file = request.files['pdf']
    if pdf_file.filename == '':
        return jsonify({'error': 'Nome de arquivo vazio.'}), 400

    # Criar diretório temporário para a conversão
    with tempfile.TemporaryDirectory() as temp_dir:
        input_path = os.path.join(temp_dir, 'input.pdf')
        output_path = os.path.join(temp_dir, 'documento.docx')
        
        try:
            # Salvar PDF
            pdf_file.save(input_path)
            
            # Converter
            cv = Converter(input_path)
            cv.convert(output_path)
            cv.close()
            
            # Streaming do arquivo de volta
            return_data = io.BytesIO()
            with open(output_path, 'rb') as f:
                return_data.write(f.read())
            return_data.seek(0)
            
            return send_file(
                return_data,
                as_attachment=True,
                download_name='documento.docx',
                mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            )
            
        except Exception as e:
            traceback.print_exc()
            return jsonify({'error': f'Erro na conversão: {str(e)}'}), 500

if __name__ == '__main__':
    engines = detect_available_engines()
    
    print('╔════════════════════════════════════════════════════════════╗')
    print('║     Overleaf Hybrid Compiler v2.1                        ║')
    print('╠════════════════════════════════════════════════════════════╣')
    print(f'  Ambiente:  {"☁️ CLOUD" if IS_CLOUD else "🖥️ LOCAL"}')
    print(f'  Port:      {PORT}')
    print(f'  Engine:    {DEFAULT_ENGINE}')
    print(f'  Motores:   {", ".join(engines) if engines else "NENHUM!"}')
    print(f'  Timeout:   {COMPILE_TIMEOUT}s')
    print(f'  Max Size:  {MAX_REQUEST_SIZE}MB')
    print(f'  Auth:      {"Ativo" if AUTH_TOKEN else "Desativado"}')
    print(f'  Cache:     {CACHE_DIR}')
    print('╚════════════════════════════════════════════════════════════╝')
    
    if not engines:
        print('⚠️  AVISO: Nenhum motor LaTeX encontrado!')
        if IS_CLOUD:
            print('   Verifique se o Dockerfile está correto.')
        else:
            print('   Instale MiKTeX (Windows) ou TeX Live (Linux/Mac).')
    
    app.run(host=HOST, port=PORT, debug=False)
