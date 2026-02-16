@echo off
chcp 65001 >nul
title Criador de Pacote para Clientes Overleaf Pro
color 0B

echo ========================================================
echo      CRIANDO PACOTE PARA DISTRIBUICAO (CLIENTES)
echo ========================================================
echo.

set "PACOTE=Pacote_Para_Clientes"

:: 1. Limpa versão anterior
if exist "%PACOTE%" rd /s /q "%PACOTE%"
mkdir "%PACOTE%"

:: 2. Copia a extensão
echo [1/3] Copiando extensão...
mkdir "%PACOTE%\extension"
:: Exclui arquivos desnecessários da extensão se houver (ex: .git, node_modules)
xcopy "extension" "%PACOTE%\extension" /E /I /Y /Q

:: 3. Copia o instalador Bat
echo [2/3] Copiando instalador...
copy "instalar_extensao.bat" "%PACOTE%\"

:: 4. Cria Instruções
echo [3/3] Criando instruções...
(
echo ========================================================
echo      COMO INSTALAR A EXTENSAO OVERLEAF PRO
echo ========================================================
echo.
echo 1. Se voce recebeu este arquivo ZIPado, extraia tudo primeiro.
echo 2. De dois cliques no arquivo "instalar_extensao.bat".
echo 3. Siga as instrucoes na tela preta.
echo.
echo ========================================================
) > "%PACOTE%\LEIA_ME.txt"

echo.
echo ========================================================
echo                 SUCESSO!
echo ========================================================
echo A pasta "%PACOTE%" foi criada.
echo.
echo O QUE FAZER AGORA:
echo 1. Entre na pasta "%PACOTE%".
echo 2. Selecione tudo e crie um arquivo ZIP (ou zipe a pasta inteira).
echo 3. Envie esse ZIP para seus usuarios/clientes.
echo.
echo ELES SO PRECISAM DISSO PARA USAR.
echo ========================================================
pause
