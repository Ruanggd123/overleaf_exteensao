# Installer & Launcher for Overleaf Pro Compiler
# Execute como Administrador para melhores resultados

Write-Host "Verificando ambiente para Overleaf Pro Extension..." -ForegroundColor Cyan

# 1. Check Python
try {
    $pythonVersion = python --version 2>&1
    if ($pythonVersion -match "Python 3") {
        Write-Host "Python encontrado: $pythonVersion" -ForegroundColor Green
    } else {
        Write-Host "Python não encontrado! Por favor instale Python 3.8+ e adicione ao PATH." -ForegroundColor Red
        Pause
        Exit
    }
} catch {
    Write-Host "Erro ao verificar Python. Certifique-se de que está instalado." -ForegroundColor Red
    Pause
    Exit
}

# 2. Install Dependencies
Write-Host "Instalando dependências..." -ForegroundColor Yellow
try {
    pip install -r server/requirements.txt
    Write-Host "Dependências instaladas." -ForegroundColor Green
} catch {
    Write-Host "Falha ao instalar dependências via pip." -ForegroundColor Red
}

# 3. Create Shortcut (Optional, simple launcher)
$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$Home\Desktop\Iniciar Overleaf Pro.lnk")
$Shortcut.TargetPath = "$PWD\server\start_server.bat"
$Shortcut.Save()
Write-Host "Atalho criado na Área de Trabalho." -ForegroundColor Green

# 4. Start Server
Write-Host "Iniciando Servidor..." -ForegroundColor Cyan
Start-Process -FilePath "$PWD\server\start_server.bat"

Write-Host "Instalação Completa! O servidor está rodando." -ForegroundColor Green
Write-Host "Se a página chrome://extensions não estiver aberta, carregue a pasta 'extension' como 'Sem compactação' (Unpacked)." -ForegroundColor Gray
Pause
