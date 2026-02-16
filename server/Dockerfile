# Use Python 3.10 Slim
FROM python:3.10-slim

# Install System Dependencies & TeX Live
# texlive-latex-base: Minimal LaTeX
# texlive-fonts-recommended: Standard fonts
# texlive-latex-extra: Common packages
# texlive-lang-portuguese: Portuguese language support
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-lang-portuguese \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set work directory
WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Application Code
COPY . .

# Expose Port
# Render sets PORT env var automatically
ENV PORT=8765
EXPOSE $PORT

# Start Command
# Using 4 workers for better concurrency on free tier (if threads allow)
# Timeout 300s for long compilations
CMD gunicorn -w 2 -b 0.0.0.0:$PORT --timeout 300 latex_server:app
