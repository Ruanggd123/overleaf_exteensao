# Dockerfile para Overleaf Hybrid Compiler
# Usa TeX Live minimal + instalação on-demand de pacotes

FROM debian:bookworm-slim

# Evita prompts interativos
ENV DEBIAN_FRONTEND=noninteractive
ENV MIKTEX_ENABLEINSTALLER=t
ENV TEXMFVAR=/tmp/texmf-var

# Instala dependências
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    wget \
    git \
    # TeX Live essencial
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-fonts-extra \
    texlive-xetex \
    texlive-luatex \
    texlive-bibtex-extra \
    biber \
    latexmk \
    # Ferramentas úteis
    poppler-utils \
    ghostscript \
    # Limpeza
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Cria ambiente Python
WORKDIR /app
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia aplicação
COPY latex_server.py .

# Porta exposta
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/status || exit 1

# Comando de inicialização
CMD ["python3", "latex_server.py"]
