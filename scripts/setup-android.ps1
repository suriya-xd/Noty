# ============================================================================
# GitVault - Android Toolchain Setup (Windows PowerShell)
# ============================================================================
Write-Host ">>> Checking GitVault Android Prerequisites..." -ForegroundColor Cyan

# 1. Check Java JDK (17+)
if (Get-Command java -ErrorAction SilentlyContinue) {
    $javaVer = (java -version 2>&1 | Select-Object -First 1)
    Write-Host "[OK] Java is installed: $javaVer" -ForegroundColor Green
} else {
    Write-Host "[!] Java not found. Android builds require JDK 17+." -ForegroundColor Red
    Write-Host "    Download OpenJDK 17 or Eclipse Temurin from: https://adoptium.net/" -ForegroundColor Yellow
}

# 2. Check ANDROID_HOME and SDK
$androidHome = $env:ANDROID_HOME
if (-not $androidHome -and (Test-Path "$env:LOCALAPPDATA\Android\Sdk")) {
    $androidHome = "$env:LOCALAPPDATA\Android\Sdk"
    $env:ANDROID_HOME = $androidHome
}

if ($androidHome -and (Test-Path $androidHome)) {
    Write-Host "[OK] ANDROID_HOME found: $androidHome" -ForegroundColor Green
} else {
    Write-Host "[!] ANDROID_HOME not set. Install Android Studio or command-line tools." -ForegroundColor Red
    Write-Host "    Default location: %LOCALAPPDATA%\Android\Sdk" -ForegroundColor Yellow
}

# 3. Check Android NDK
$ndkDir = $env:NDK_HOME
if (-not $ndkDir -and $androidHome) {
    $potentialNdk = Get-ChildItem (Join-Path $androidHome "ndk") -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($potentialNdk) {
        $ndkDir = $potentialNdk.FullName
        $env:NDK_HOME = $ndkDir
    }
}

if ($ndkDir -and (Test-Path $ndkDir)) {
    Write-Host "[OK] Android NDK detected: $ndkDir" -ForegroundColor Green
} else {
    Write-Host "[!] Android NDK not found. In Android Studio SDK Manager, install 'NDK (Side by side)'." -ForegroundColor Yellow
}

# 4. Check Rust Android cross-compilation targets
if (Get-Command rustup -ErrorAction SilentlyContinue) {
    Write-Host "`n>>> Adding Rust Android cross-compilation targets..." -ForegroundColor Cyan
    rustup target add aarch64-linux-android
    rustup target add armv7-linux-androideabi
    rustup target add x86_64-linux-android
    Write-Host "[OK] Rust Android targets configured." -ForegroundColor Green
} else {
    Write-Host "[!] rustup not found in PATH to register Android targets." -ForegroundColor Yellow
}

Write-Host "`n>>> Android toolchain check complete!" -ForegroundColor Green
Write-Host "To initialize Android target: npm run android:init" -ForegroundColor Cyan
Write-Host "To build Android APK:         npm run android:build" -ForegroundColor Cyan
