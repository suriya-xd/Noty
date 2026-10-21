#!/usr/bin/env bash
# ============================================================================
# GitVault - Build Android APK (macOS / Linux)
# ============================================================================
set -euo pipefail

if [ -z "${ANDROID_HOME:-}" ]; then
    echo "[!] ANDROID_HOME is not set. Please export ANDROID_HOME."
    exit 1
fi

if [ -z "${NDK_HOME:-}" ]; then
    NDK_CANDIDATE=$(ls -d "${ANDROID_HOME}/ndk/"* 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$NDK_CANDIDATE" ]; then
        export NDK_HOME="$NDK_CANDIDATE"
    else
        echo "[!] NDK_HOME not set and no NDK directory found in ${ANDROID_HOME}/ndk"
        exit 1
    fi
fi

echo "Using ANDROID_HOME: ${ANDROID_HOME}"
echo "Using NDK_HOME:     ${NDK_HOME}"

echo ">>> Building frontend..."
npm run build

echo ">>> Building Android APK (aarch64)..."
npx tauri android build --apk --target aarch64-linux-android

echo "[✓] Android APK generated successfully!"
