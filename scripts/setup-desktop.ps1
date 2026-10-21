# ============================================================================
# GitVault - Desktop Toolchain Setup (Windows PowerShell)
# ============================================================================
Write-Host ">>> Checking GitVault Desktop Prerequisites..." -ForegroundColor Cyan

# 1. Check Node.js
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVer = (node -v).Trim()
    Write-Host "[OK] Node.js is installed: $nodeVer" -ForegroundColor Green
} else {
    Write-Host "[!] Node.js not found. Please install Node.js 20+ from https://nodejs.org/" -ForegroundColor Red
}

# 2. Check Rust & Cargo
if (Get-Command cargo -ErrorAction SilentlyContinue) {
    $cargoVer = (cargo --version).Trim()
    Write-Host "[OK] Cargo is installed: $cargoVer" -ForegroundColor Green
} else {
    Write-Host "[!] Rust/Cargo not found in PATH." -ForegroundColor Yellow
    Write-Host "    To install Rust, download and run rustup from: https://win.rustup.rs/" -ForegroundColor Yellow
}

# 3. Check Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    $gitVer = (git --version).Trim()
    Write-Host "[OK] Git is installed: $gitVer" -ForegroundColor Green
} else {
    Write-Host "[!] Git not found. Please install Git for Windows: https://git-scm.com/" -ForegroundColor Red
}

# 4. Check MSVC C++ Build Tools
$programFilesX86 = [System.Environment]::GetFolderPath("ProgramFilesX86")
$vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $cppInstalled = & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64
    if ($cppInstalled) {
        Write-Host "[OK] Visual Studio C++ Build Tools detected." -ForegroundColor Green
    } else {
        Write-Host "[!] Visual Studio detected but C++ build tools component may be missing." -ForegroundColor Yellow
    }
} else {
    Write-Host "[i] Tip: If cargo fails linking, install 'Desktop development with C++' via Visual Studio Installer." -ForegroundColor Gray
}

# 5. Check npm packages
Write-Host "`n>>> Checking npm dependencies..." -ForegroundColor Cyan
npm list --depth=0

Write-Host "`n>>> Desktop toolchain setup check complete!" -ForegroundColor Green
Write-Host "To run in development mode: npm run tauri dev" -ForegroundColor Cyan
Write-Host "To build release bundle:    npm run desktop:build" -ForegroundColor Cyan
