# Use Python 3.10 Slim (Debian-based)
FROM python:3.10-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive

# Install System Dependencies & TeX Live
# texlive-latex-base: Basic LaTeX
# texlive-latex-recommended: Common packages
# latexmk: Build tool
# build-essential: For compiling some python packages if needed
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    latexmk \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set work directory
WORKDIR /app

# Install Python Dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Application Code
COPY . .

# Expose Port (Render uses $PORT, default 8765)
ENV PORT=8765
EXPOSE $PORT

# Start Command using Gunicorn for production stability
# Workers = 1 (Free tier RAM limit)
# Timeout = 300s (LaTeX can be slow)
CMD gunicorn -w 1 -b 0.0.0.0:$PORT --timeout 300 latex_server:app
