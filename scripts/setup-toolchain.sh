#!/usr/bin/env bash
# ============================================================================
# GitVault - Cross-Platform Toolchain Setup (macOS / Linux)
# ============================================================================
set -euo pipefail

echo ">>> Checking GitVault Toolchain (macOS / Linux)..."

# 1. Node.js
if command -v node >/dev/null 2>&1; then
    echo "[✓] Node.js is installed: $(node -v)"
else
    echo "[!] Node.js not found. Please install Node.js 20+."
    exit 1
fi

# 2. Rust
if command -v cargo >/dev/null 2>&1; then
    echo "[✓] Cargo is installed: $(cargo --version)"
else
    echo "[!] Rust/Cargo not found. Installing via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# 3. Android Targets (for mobile build)
if command -v rustup >/dev/null 2>&1; then
    echo ">>> Registering Rust Android targets..."
    rustup target add aarch64-linux-android x86_64-linux-android armv7-linux-androideabi
fi

# 4. Install npm packages
echo ">>> Installing npm packages..."
npm install --legacy-peer-deps

echo "[✓] Toolchain setup complete!"
