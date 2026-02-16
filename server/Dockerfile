FROM python:3.9-slim

# Install TeX Live (Essential for LaTeX compilation)
# -y means yes to prompts, --no-install-recommends to keep image smaller
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-fonts-extra \
    texlive-latex-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install gunicorn

# Copy server code
COPY . .

# Expose port (Render uses environment variable PORT, default 8765)
EXPOSE 8765

# Run with Gunicorn for production
# CMD ["python", "latex_server.py"] # Local dev
CMD gunicorn --bind 0.0.0.0:$PORT latex_server:app
