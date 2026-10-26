#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}"
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://localhost:5173}"
if "$ANDROID_HOME/platform-tools/adb" get-state >/dev/null 2>&1; then
  "$ANDROID_HOME/platform-tools/adb" reverse tcp:5173 tcp:5173
fi
pnpm exec expo prebuild --platform android --no-install
# React Native's generated autolinking cache does not track the monorepo's root pnpm lockfile.
# Refresh it so pinned native patches resolve to the installed package, not an older store path.
rm -f android/build/generated/autolinking/autolinking.json
(cd android && ./gradlew :app:assembleDebug --stacktrace)
echo "Development APK: $PWD/android/app/build/outputs/apk/debug/app-debug.apk"
