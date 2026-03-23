#!/usr/bin/env python3
"""
Servidor LaTeX para Cloud (Cloud Run/AWS ECS) com conversão para Word

Endpoints:
  POST /compile      — Compila arquivos .tex enviados como JSON
  POST /compile-zip  — Compila projeto enviado como ZIP
  POST /compile-delta — Compila apenas mudanças (delta)
  POST /convert/word — Converte PDF para DOCX usando LibreOffice/pandoc
  GET  /status       — Health check
  GET  /             — Página de status/landing

Deploy:
  - Google Cloud Run: gcloud run deploy --source .
  - AWS ECS: Use o Dockerfile com Fargate
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
from pathlib import Path
from functools import wraps

from flask import Flask, request, send_file, jsonify, render_template_string
from flask_cors import CORS

# ═══════════════════════════════════════════════════════════════════
#  Configuration (Local Optimized)
# ═══════════════════════════════════════════════════════════════════

SUPPORTED_ENGINES = ['pdflatex', 'xelatex', 'lualatex']
DEFAULT_ENGINE = os.environ.get('LATEX_ENGINE', 'pdflatex')
BIBTEX_CMD = 'bibtex'
COMPILE_TIMEOUT = int(os.environ.get('COMPILE_TIMEOUT', '300'))
PORT = int(os.environ.get('PORT', '8765'))
MAX_REQUEST_SIZE = int(os.environ.get('MAX_REQUEST_SIZE', '50'))  # MB

app = Flask(__name__)
CORS(app, resources={
    r"/*": {
        "origins": "*",  # Em produção, restrinja para seus domínios
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Authorization", "Content-Type"]
    }
})

# Limitar tamanho do upload
app.config['MAX_CONTENT_LENGTH'] = MAX_REQUEST_SIZE * 1024 * 1024

# Cache para projetos (para compilação delta)
project_cache = {}  # projectId -> {files, timestamp}

# Cache para projetos (para compilação delta)
project_cache = {}  # projectId -> {files, timestamp}

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

# ═══════════════════════════════════════════════════════════════════
#  Utility Functions (Mesmas funções, otimizadas para cloud)
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

def compile_project(directory, main_file, engine=None, project_id=None):
    """
    Pipeline de compilação LaTeX otimizado para cloud.
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
    env['TEXMFVAR'] = '/tmp/texmf-var'  # Evita problemas de permissão
    
    full_log = ''
    print(f'[Cloud Compile] Engine: {engine}, Main: {main_file}')
    
    try:
        # Passo 1
        print('[Cloud Compile] Pass 1...')
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
            print('[Cloud Compile] Running BibTeX...')
            rb = subprocess.run(
                [BIBTEX_CMD, bib_base], cwd=work_dir, capture_output=True,
                text=True, timeout=60, env=env,
            )
            full_log += '\n--- BibTeX ---\n' + rb.stdout + '\n' + rb.stderr
            needs_rerun = True
        
        # Passos 2 e 3
        if needs_rerun:
            for i in range(2):
                print(f'[Cloud Compile] Pass {i + 2}...')
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
            return {
                'success': True, 
                'pdf_path': actual_pdf, 
                'log': full_log
            }
        else:
            print('[Local Compile] [ERR] PDF não gerado')
            return {'success': False, 'log': full_log}
            
    except subprocess.TimeoutExpired:
        return {'success': False, 'log': f'Timeout ({COMPILE_TIMEOUT}s) expirado.'}
    except Exception as e:
        return {'success': False, 'log': f'Erro: {str(e)}'}

# ═══════════════════════════════════════════════════════════════════
#  PDF to Word Conversion
# ═══════════════════════════════════════════════════════════════════

def convert_pdf_to_word(pdf_path):
    """
    Converte PDF para DOCX usando LibreOffice ou pandoc.
    Tenta múltiplas estratégias em ordem de preferência.
    """
    output_dir = os.path.dirname(pdf_path)
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    docx_path = os.path.join(output_dir, f"{base_name}.docx")
    
    # Estratégia 1: LibreOffice (melhor qualidade para LaTeX)
    if shutil.which('libreoffice'):
        try:
            print(f'[Convert] Tentando LibreOffice...')
            cmd = [
                'libreoffice', 
                '--headless', 
                '--convert-to', 'docx',
                '--outdir', output_dir,
                pdf_path
            ]
            result = subprocess.run(
                cmd, 
                capture_output=True, 
                text=True, 
                timeout=60
            )
            if result.returncode == 0 and os.path.isfile(docx_path):
                print(f'[Convert] LibreOffice sucesso: {docx_path}')
                return docx_path
            else:
                print(f'[Convert] LibreOffice falhou: {result.stderr}')
        except Exception as e:
            print(f'[Convert] LibreOffice erro: {e}')
    
    # Estratégia 2: Pandoc (se disponível)
    if shutil.which('pandoc'):
        try:
            print(f'[Convert] Tentando pandoc...')
            # Pandoc funciona melhor com LaTeX direto, mas tentamos PDF
            cmd = [
                'pandoc',
                '-f', 'pdf',
                '-t', 'docx',
                '-o', docx_path,
                pdf_path
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60
            )
            if result.returncode == 0 and os.path.isfile(docx_path):
                print(f'[Convert] Pandoc sucesso: {docx_path}')
                return docx_path
            else:
                print(f'[Convert] Pandoc falhou: {result.stderr}')
        except Exception as e:
            print(f'[Convert] Pandoc erro: {e}')
    
    # Estratégia 3: pdf2docx (biblioteca Python)
    try:
        from pdf2docx import Converter
        print(f'[Convert] Tentando pdf2docx...')
        cv = Converter(pdf_path)
        cv.convert(docx_path, start=0, end=None)
        cv.close()
        if os.path.isfile(docx_path):
            print(f'[Convert] pdf2docx sucesso: {docx_path}')
            return docx_path
    except ImportError:
        print('[Convert] pdf2docx não instalado')
    except Exception as e:
        print(f'[Convert] pdf2docx erro: {e}')
    
    return None

# ═══════════════════════════════════════════════════════════════════
#  Endpoints
# ═══════════════════════════════════════════════════════════════════

LANDING_PAGE = """
<!DOCTYPE html>
<html>
<head>
    <title>Overleaf Cloud Compiler</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        .status { padding: 20px; border-radius: 8px; background: #f0f9ff; border: 1px solid #0ea5e9; }
        .ok { color: #059669; }
        code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>🚀 Overleaf Cloud Compiler</h1>
    <div class="status">
        <h2>Status do Servidor</h2>
        <p><strong>Status:</strong> <span class="ok">✓ Online (Local)</span></p>
        <p><strong>Motores disponíveis:</strong> {{ engines|join(', ') }}</p>
        <p><strong>Versão:</strong> 2.2.0-local</p>
    </div>
    <h2>Endpoints</h2>
    <ul>
        <li><code>GET /status</code> - Health check</li>
        <li><code>POST /compile</code> - Compilar arquivos JSON</li>
        <li><code>POST /compile-zip</code> - Compilar ZIP</li>
        <li><code>POST /compile-delta</code> - Compilação incremental (delta)</li>
        <li><code>POST /convert/word</code> - Converter PDF para DOCX</li>
    </ul>
    <p><em>Para uso com a extensão Chrome, configure a URL deste servidor.</em></p>
</body>
</html>
"""

@app.route('/')
def index():
    """Página inicial com status."""
    engines = detect_available_engines()
    return render_template_string(LANDING_PAGE, engines=engines)

@app.route('/status', methods=['GET'])
def status():
    """Health check endpoint."""
    engines = detect_available_engines()
    return jsonify({
        'status': 'ok',
        'engines': engines,
        'default_engine': DEFAULT_ENGINE,
        'compile_timeout': COMPILE_TIMEOUT,
        'version': '2.2.0-local',
        'features': ['compile', 'compile-zip', 'compile-delta', 'convert-word']
    })

@app.route('/compile', methods=['POST'])
def compile_latex():
    """Compilar arquivos .tex enviados como JSON."""
    
    data = request.get_json(force=True)
    files = data.get('files', {})
    main_file = data.get('mainFile', 'main.tex')
    engine = data.get('engine', DEFAULT_ENGINE)
    project_id = data.get('projectId')
    
    if not files:
        return jsonify({'error': 'Nenhum arquivo recebido.'}), 400
    
    # Usar diretório temporário em /tmp (escrita permitida em Cloud Run)
    with tempfile.TemporaryDirectory(dir='/tmp', prefix='olc_') as work_dir:
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
            
            # Adicionar headers CORS
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        else:
            return jsonify({
                'error': 'Compilação falhou.',
                'log': result['log'][-5000:],  # Aumentado para cloud
                'public_url': result.get('public_url')
            }), 500

@app.route('/compile-zip', methods=['POST'])
def compile_zip():
    """Compilar projeto enviado como ZIP."""
    
    if 'project' not in request.files:
        return jsonify({'error': 'Nenhum arquivo ZIP recebido.'}), 400
    
    zip_file = request.files['project']
    engine = request.form.get('engine', DEFAULT_ENGINE)
    project_id = request.form.get('projectId')
    
    with tempfile.TemporaryDirectory(dir='/tmp', prefix='olc_zip_') as tmp_dir:
        extract_dir = os.path.join(tmp_dir, 'project')
        os.makedirs(extract_dir, exist_ok=True)
        
        try:
            with zipfile.ZipFile(zip_file, 'r') as z:
                z.extractall(extract_dir)
        except zipfile.BadZipFile:
            return jsonify({'error': 'Arquivo ZIP inválido.'}), 400
        
        main_file = find_main_file(extract_dir)
        if not main_file:
            return jsonify({'error': 'Nenhum arquivo .tex encontrado no ZIP.'}), 400
        
        result = compile_project(extract_dir, main_file, engine, project_id)
        
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
                'log': result['log'][-5000:],
                'public_url': result.get('public_url')
            }), 500

@app.route('/compile-delta', methods=['POST'])
def compile_delta():
    """
    Compilação incremental: aplica mudanças (delta) a um projeto existente.
    """
    
    if 'delta_zip' not in request.files:
        return jsonify({'error': 'Nenhum delta ZIP recebido.'}), 400
    
    delta_file = request.files['delta_zip']
    deleted_files = json.loads(request.form.get('deleted_files', '[]'))
    project_id = request.form.get('projectId', '')
    engine = request.form.get('engine', DEFAULT_ENGINE)
    
    if not project_id:
        return jsonify({'error': 'projectId é obrigatório para compilação delta.'}), 400
    
    # Verificar se temos o projeto em cache
    if project_id not in project_cache:
        return jsonify({'error': 'CACHE_MISS', 'message': 'Projeto não encontrado no cache.'}), 410
    
    cache_info = project_cache[project_id]
    project_dir = cache_info['directory']
    
    # Verificar se diretório ainda existe
    if not os.path.exists(project_dir):
        del project_cache[project_id]
        return jsonify({'error': 'CACHE_MISS', 'message': 'Diretório de cache não existe mais.'}), 410
    
    try:
        # Aplicar deleções
        for filepath in deleted_files:
            full_path = os.path.join(project_dir, filepath)
            if os.path.exists(full_path):
                os.remove(full_path)
                print(f'[Delta] Deletado: {filepath}')
        
        # Aplicar atualizações do delta
        with zipfile.ZipFile(delta_file, 'r') as z:
            z.extractall(project_dir)
        
        # Recompilar
        main_file = cache_info.get('main_file') or find_main_file(project_dir)
        if not main_file:
            return jsonify({'error': 'Nenhum arquivo .tex encontrado.'}), 400
        
        # Atualizar cache
        project_cache[project_id]['main_file'] = main_file
        project_cache[project_id]['timestamp'] = os.time()
        
        result = compile_project(project_dir, main_file, engine, project_id)
        
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
        return jsonify({'error': f'Erro ao aplicar delta: {str(e)}'}), 500

@app.route('/convert/word', methods=['POST'])
def convert_word():
    """
    Converte PDF para DOCX.
    Recebe arquivo PDF, retorna DOCX.
    """
    
    if 'pdf' not in request.files:
        return jsonify({'error': 'Nenhum arquivo PDF recebido.'}), 400
    
    pdf_file = request.files['pdf']
    
    with tempfile.TemporaryDirectory(dir='/tmp', prefix='olc_convert_') as tmp_dir:
        pdf_path = os.path.join(tmp_dir, 'input.pdf')
        pdf_file.save(pdf_path)
        
        # Converter
        docx_path = convert_pdf_to_word(pdf_path)
        
        if docx_path and os.path.isfile(docx_path):
            with open(docx_path, 'rb') as f:
                docx_data = io.BytesIO(f.read())
            
            response = send_file(
                docx_data,
                mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                as_attachment=True,
                download_name='documento.docx'
            )
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        else:
            return jsonify({
                'error': 'Conversão falhou. Verifique se LibreOffice ou pandoc estão instalados.'
            }), 500

# ═══════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    engines = detect_available_engines()
    
    print('╔════════════════════════════════════════════════════════════╗')
    print('║     Overleaf Cloud Compiler v2.1                          ║')
    print('╠════════════════════════════════════════════════════════════╣')
    print(f'  Port:      {PORT}')
    print(f'  Engine:    {DEFAULT_ENGINE}')
    print(f'  Motores:   {", ".join(engines) if engines else "NENHUM!"}')
    print(f'  Timeout:   {COMPILE_TIMEOUT}s')
    print(f'  Max Size:  {MAX_REQUEST_SIZE}MB')
    print(f'  Auth:      Desativado')
    print(f'  Mode:      Local')
    print('╚════════════════════════════════════════════════════════════╝')
    
    if not engines:
        print('⚠️  AVISO: Nenhum motor LaTeX encontrado!')
        print('   Certifique-se de que o Dockerfile está usando texlive/texlive:latest-full')
    
    # Em produção, não use debug=True
    app.run(host='0.0.0.0', port=PORT, debug=False)
