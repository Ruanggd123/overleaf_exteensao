@echo off
rem Definindo o codepage para suporte a caracteres especiais (UTF-8)
chcp 65001 >nul
title Instalador Overleaf Pro Cloud
color 0A

echo ========================================================
echo      INSTALADOR EXTENSAO OVERLEAF PRO (CLOUD)
echo ========================================================
echo.

:: 1. Define o local de instalação (Pasta do Usuário)
set "ORIGEM=%~dp0extension"
set "DESTINO=%USERPROFILE%\OverleafProExtension"

echo [1/3] Copiando arquivos para: %DESTINO%
if not exist "%DESTINO%" mkdir "%DESTINO%"
xcopy "%ORIGEM%" "%DESTINO%" /E /I /Y /Q

if %errorlevel% neq 0 (
    color 0C
    echo.
    echo [ERRO] Nao foi possivel copiar os arquivos.
    echo Verifique se a pasta 'extension' esta junto com este arquivo.
    pause
    exit /b
)

echo.
echo [2/3] Arquivos copiados com sucesso!
echo.
echo [3/3] Abrindo o Chrome para finalizar...
echo.
echo ========================================================
echo                 INSTRUCOES FINAIS
echo ========================================================
echo 1. No Chrome, ative o "Modo do desenvolvedor" (Canto superior direito).
echo 2. Clique no botao "Carregar sem compactacao".
echo 3. Selecione a pasta: 
echo    %DESTINO%
echo.
echo ========================================================

:: Abre a página de extensões
start chrome "chrome://extensions"

pause
