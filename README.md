# ⚡ Overleaf Ultra-Lite: Local Compiler

[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![LaTeX: Support](https://img.shields.io/badge/LaTeX-Full%20Support-green.svg)](https://www.latex-project.org/)

> **A sua compilação no Overleaf, agora na velocidade da luz.** 🚀
> Esta versão foi cirurgicamente limpa para remover Docker, logins e complicações. Foco total em performance local.

---

## ✨ O que é isso?

Este projeto é uma ponte mágica entre o seu navegador e o seu computador. Ele permite que você use o **Overleaf** mas compile o seu PDF usando o processador da sua máquina, ignorando as filas e limitações da nuvem gratuita.

- **Zero Docker**: Esqueça contêineres pesados. Use apenas Python puro.
- **Zero Login**: Sem tokens, sem senhas. Você manda, ele compila.
- **Delta Sync**: Apenas as mudanças são enviadas. Piscou, compilou.
- **PDF ➡️ Word**: Converta seus trabalhos acadêmicos para `.docx` instantaneamente.

---

## 🛠️ Pré-requisitos (O Essencial)

Para que a mágica aconteça, você precisa de três ingredientes:

1.  **[Python 3.8+](https://www.python.org/downloads/)**: A linguagem que move o nosso servidor.
2.  **Distribuição LaTeX**: Você precisa de um motor de compilação no seu PC:
    - **[MiKTeX](https://miktex.org/download)** (Recomendado para Windows - instale e deixe no PATH).
    - **[TeX Live](https://www.tug.org/texlive/)** (Alternativa clássica).
3.  **[Google Chrome](https://www.google.com/chrome/)** ou navegadores baseados em Chromium (Edge, Brave, etc).

---

## 🚀 Como Começar? (Quick Start)

### 1️⃣ Prepare o Servidor (O Cérebro)
Abra o seu terminal (CMD ou PowerShell) e siga estes passos:

```bash
# Entre na pasta do projeto
cd server

# Instale os ajudantes necessários
pip install -r requirements.txt

# Inicie o servidor
python latex_server.py
```
*Se ver a mensagem `✓ Online (Local)` em `http://localhost:8765`, você está no caminho certo!*

### 2️⃣ Instale a Extensão (A Ponte)
1. No Chrome, acesse `chrome://extensions/`.
2. Ative o **Modo do Desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta `extension`.

---

## 🎮 Como Usar?

1.  Abra qualquer projeto no [Overleaf](https://www.overleaf.com).
2.  Clique no ícone da nossa extensão (o raio ⚡ no menu do Chrome).
3.  Garanta que o status esteja **Online**.
4.  O botão de compilação da extensão aparecerá na interface do Overleaf. Clique e veja a mágica!

---

## 💡 Dicas Profissionais

- **Motor LaTeX**: Se você usa fontes específicas ou pacotes modernos, escolha entre `pdflatex`, `xelatex` ou `lualatex` no popup da extensão.
- **Conversão Word**: Se você tiver o [LibreOffice](https://www.libreoffice.org/) ou [Pandoc](https://pandoc.org/) instalado, a conversão de PDF para Word será muito mais precisa!

---

## 📜 Licença

Distribuído sob a licença MIT. Sinta-se livre para usar, modificar e compartilhar!

---
<p align="center">
  Criado com ❤️ por <a href="https://github.com/Ruanggd123">Ruanggd123</a>
</p>
