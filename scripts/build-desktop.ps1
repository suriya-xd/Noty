# ============================================================================
# GitVault - Build Desktop Release Bundle (Windows / Desktop)
# ============================================================================
Write-Host ">>> Building GitVault Desktop Production Release..." -ForegroundColor Cyan

# 1. Build frontend bundle
Write-Host ">>> Building frontend with Vite..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Frontend build failed." -ForegroundColor Red
    exit 1
}

# 2. Build Tauri desktop bundle
Write-Host "`n>>> Building Tauri native desktop installer..." -ForegroundColor Cyan
npx tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Tauri build failed. Check cargo/MSVC errors above." -ForegroundColor Red
    exit 1
}

Write-Host "`n[OK] Desktop production build succeeded!" -ForegroundColor Green
Write-Host "Installer output located in: src-tauri/target/release/bundle/" -ForegroundColor Cyan
