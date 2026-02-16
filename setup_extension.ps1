# Installer for Overleaf Pro Extension (Cloud Version)
# Run as Administrator to register extensions in Chrome/Edge

$ExtensionPath = "$PWD\extension"
$ChromePolicyKey = "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist"
$EdgePolicyKey = "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist"

Write-Host "Configurando Extensão Overleaf Pro Cloud..." -ForegroundColor Cyan

# 1. Ensure Policy Keys exist
if (!(Test-Path $ChromePolicyKey)) { New-Item -Path $ChromePolicyKey -Force | Out-Null }
if (!(Test-Path $EdgePolicyKey)) { New-Item -Path $EdgePolicyKey -Force | Out-Null }

# 2. Add Extension ID to Allowlist (if packed)
# If unpacked, we can't easily force install without enterprise policy blocking it usually.
# However, we can help the user load it.

Write-Host "Como a extensão está em modo de desenvolvedor (Unpacked), o Windows não permite instalação silenciosa total sem domínio." -ForegroundColor Yellow
Write-Host "Mas vamos facilitar o processo!" -ForegroundColor Green

# 3. Create a clean folder in Program Files (optional, but good for persistence)
$InstallDir = "$env:ProgramFiles\OverleafProExtension"
if (!(Test-Path $InstallDir)) { New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null }

Write-Host "Copiando arquivos para $InstallDir..." -ForegroundColor Cyan
Copy-Item -Path "$ExtensionPath\*" -Destination $InstallDir -Recurse -Force

# 4. Open Chrome to Extensions Page
Write-Host "Abrindo Chrome na página de extensões..." -ForegroundColor Green
Start-Process "chrome" "chrome://extensions"

Write-Host "Instructions:" -ForegroundColor Cyan
Write-Host "1. Ative o 'Modo do desenvolvedor' (Developer mode) no canto superior direito."
Write-Host "2. Clique em 'Carregar sem compactação' (Load unpacked)."
Write-Host "3. Selecione a pasta: $InstallDir"
Write-Host ""
Write-Host "Pressione ENTER quando terminar."
Read-Host

Write-Host "Instalação concluída!" -ForegroundColor Green
