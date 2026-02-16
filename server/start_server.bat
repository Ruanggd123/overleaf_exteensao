@echo off
title Servidor Overleaf Pro
echo Iniciando Servidor Local de Compilacao...
cd /d "%~dp0"
python latex_server.py
pause
