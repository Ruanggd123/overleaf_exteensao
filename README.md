# 📄 Overleaf Local Compiler

Extensão de navegador (Chrome/Edge) que compila projetos do Overleaf usando um compilador LaTeX local, **bypassando as limitações do plano gratuito** quando o servidor do Overleaf está sobrecarregado.

---

## 📐 Arquitetura

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Overleaf      │────▶│  Extensão        │────▶│  Servidor local  │
│   (Navegador)   │     │  (content.js)    │     │  (Flask + LaTeX) │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                               │                          │
                               │                          ▼
                               │                   ┌──────────────┐
                               └──────────────────▶│  PDF gerado  │
                                                   │  (download)  │
                                                   └──────────────┘
```

**Fluxo:**
1. A extensão extrai os arquivos `.tex` do projeto aberto no Overleaf
2. Envia para o servidor Flask local (porta 8765)
3. O servidor compila com `pdflatex`/`xelatex`/`lualatex`
4. O PDF é baixado automaticamente no navegador

---

## 🔧 Pré-requisitos

### 1. Compilador LaTeX

Você precisa de um compilador LaTeX instalado:

| Sistema  | Opção recomendada |
|----------|-------------------|
| **Windows** | [MiKTeX](https://miktex.org/download) |
| **Linux**   | `sudo apt install texlive-full` |
| **macOS**   | `brew install --cask mactex` |

> **Dica:** Após instalar, verifique se o comando funciona no terminal:
> ```
> pdflatex --version
> ```

### 2. Python 3.8+

Instale o [Python](https://www.python.org/downloads/) se ainda não tiver.

---

## 🚀 Instalação

### Passo 1 — Instalar dependências do servidor

```bash
cd server
pip install -r requirements.txt
```

### Passo 2 — Gerar ícones da extensão

```bash
cd extension
python generate_icons.py
```

Isso cria os arquivos `icons/icon16.png`, `icons/icon48.png` e `icons/icon128.png`.

### Passo 3 — Carregar a extensão no navegador

1. Abra `chrome://extensions/` (Chrome) ou `edge://extensions/` (Edge)
2. Ative o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **"Carregar sem compactação"** / **"Load unpacked"**
4. Selecione a pasta `extension/`
5. A extensão deve aparecer na barra de extensões ✅

---

## ▶️ Como Usar

### 1. Inicie o servidor

```bash
cd server
python latex_server.py
```

Você verá:
```
╔══════════════════════════════════════════════════╗
║       Overleaf Local Compiler — Servidor        ║
╠══════════════════════════════════════════════════╣
║  🌐 URL:     http://localhost:8765              ║
║  📄 Motor:   pdflatex                           ║
║  ✅ Motores: pdflatex, xelatex, lualatex       ║
╚══════════════════════════════════════════════════╝
```

### 2. Abra seu projeto no Overleaf

Navegue até `https://www.overleaf.com/project/...`

### 3. Compile!

- Um botão verde flutuante **"Compilar Localmente"** aparecerá no canto inferior direito
- Clique nele para extrair e compilar o projeto
- O PDF será baixado automaticamente

### 4. Configurações

- Clique no ⚙ no botão flutuante para alterar:
  - **URL do servidor** (padrão: `http://localhost:8765`)
  - **Motor LaTeX** (`pdflatex`, `xelatex` ou `lualatex`)
- Ou acesse pelo popup da extensão na barra de ferramentas

---

## 📡 API do Servidor

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/status` | GET | Health check — retorna motores disponíveis |
| `/compile` | POST | Compila arquivos enviados como JSON |
| `/compile-zip` | POST | Compila projeto enviado como ZIP |

### Exemplo: `/compile`

```json
POST /compile
Content-Type: application/json

{
  "files": {
    "main.tex": "\\documentclass{article}\n\\begin{document}\nHello!\n\\end{document}",
    "refs.bib": "..."
  },
  "mainFile": "main.tex",
  "engine": "pdflatex"
}
```

---

## ❓ Solução de Problemas

| Problema | Solução |
|----------|---------|
| Botão não aparece no Overleaf | Recarregue a página (F5). Verifique se a extensão está ativa. |
| "Servidor offline" | Certifique-se de que `python latex_server.py` está rodando. |
| "Motor LaTeX não encontrado" | Instale MiKTeX/TeX Live e reinicie o terminal. |
| Pacote LaTeX não encontrado | Instale via `tlmgr install nome-do-pacote` ou pelo MiKTeX Console. |
| Timeout na compilação | Aumente `COMPILE_TIMEOUT` no servidor (env var). |
| Fontes não encontradas | Use `xelatex` ou `lualatex` ao invés de `pdflatex`. |
| Erro CORS no console | O servidor já usa `flask-cors`. Verifique se a URL está correta. |

---

## 📁 Estrutura do Projeto

```
extensao_tcc/
├── extension/               # Extensão do navegador
│   ├── manifest.json        # Configuração MV3
│   ├── content.js           # Script injetado no Overleaf
│   ├── background.js        # Service worker
│   ├── popup.html           # Popup da extensão
│   ├── popup.js             # Lógica do popup
│   ├── styles.css           # Estilos injetados
│   ├── generate_icons.py    # Gerador de ícones
│   └── icons/               # Ícones da extensão (gerados)
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── server/                  # Servidor de compilação
│   ├── latex_server.py      # Servidor Flask
│   └── requirements.txt     # Dependências Python
└── README.md                # Este arquivo
```

---

## 📝 Licença

Projeto acadêmico — uso livre.
