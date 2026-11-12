# ============================================================================
# Noetic - Build Android APK Release (PowerShell)
# ============================================================================
Write-Host ">>> Building Noetic Android Release APK..." -ForegroundColor Cyan

# 1. Resolve Android SDK and NDK
if (-not $env:ANDROID_HOME -and (Test-Path "$env:LOCALAPPDATA\Android\Sdk")) {
    $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
}

if (-not $env:NDK_HOME -and $env:ANDROID_HOME) {
    $ndkCandidate = Get-ChildItem (Join-Path $env:ANDROID_HOME "ndk") -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($ndkCandidate) {
        $env:NDK_HOME = $ndkCandidate.FullName
    }
}

if (-not $env:ANDROID_HOME) {
    Write-Host "[!] ANDROID_HOME is not set. Please set ANDROID_HOME before building." -ForegroundColor Red
    exit 1
}

if (-not $env:NDK_HOME) {
    Write-Host "[!] NDK_HOME is not set. Android NDK is required for compiling libgit2." -ForegroundColor Red
    exit 1
}

Write-Host "Using ANDROID_HOME: $env:ANDROID_HOME" -ForegroundColor Gray
Write-Host "Using NDK_HOME:     $env:NDK_HOME" -ForegroundColor Gray

# 2. Build frontend bundle
Write-Host "`n>>> Building frontend with Vite..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Frontend build failed." -ForegroundColor Red
    exit 1
}

# 3. Build APK with Tauri
Write-Host "`n>>> Building Android APK via Tauri v2 CLI..." -ForegroundColor Cyan
npx tauri android build --apk --target aarch64
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Android build failed. See Gradle / NDK logs above." -ForegroundColor Red
    exit 1
}

# Gradle names its output app-<abi>-<type>.apk; keep a copy under the app's own name.
$apkDir = "src-tauri/gen/android/app/build/outputs/apk"
$outDir = "src-tauri/gen/android/app/build/outputs/noetic"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Get-ChildItem -Path $apkDir -Recurse -Filter *.apk | ForEach-Object {
    $name = $_.BaseName -replace '^app-', ''
    Copy-Item $_.FullName (Join-Path $outDir "Noetic-$name.apk") -Force
}

Write-Host "`n[OK] Android APK successfully built!" -ForegroundColor Green
Write-Host "APK output located in: $outDir" -ForegroundColor Cyan
