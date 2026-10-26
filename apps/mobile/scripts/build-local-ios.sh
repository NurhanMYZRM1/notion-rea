#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cmake >/dev/null || { echo 'Install CMake and Ninja first: brew install cmake ninja' >&2; exit 1; }
command -v ninja >/dev/null || { echo 'Install Ninja first: brew install ninja' >&2; exit 1; }
# SDK 58 / RN 0.88 prebuilt binaries currently omit symbols required by the native modules.
# Compile matching RN and Hermes sources for local development; EAS profiles stay unchanged.
export RCT_USE_PREBUILT_RNCORE=0 RCT_USE_RN_DEP=0 RCT_BUILD_HERMES_FROM_SOURCE=true
export EXPO_USE_PRECOMPILED_MODULES=0 EX_DEV_CLIENT_NETWORK_INSPECTOR=false
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://localhost:5173}"
pnpm exec expo prebuild --platform ios --no-install
(cd ios && pod install && pod update hermes-engine --no-repo-update)
python3 scripts/fix-ios-hermes-paths.py
pnpm exec expo run:ios --device "${WORKSPACE_IOS_DEVICE:-iPhone 17 Pro}" --no-bundler
