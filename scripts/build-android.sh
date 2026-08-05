#!/usr/bin/env bash
#
# Build & install SableSat (Android release APK) to a connected device.
#
# Usage:
#   ./scripts/build-android.sh [device-serial]
#   device-serial defaults to the OnePlus used for development.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/android"

DEVICE="${1:-8DONONFM4DTO5DYL}"   # adb serial of the target device
APK=app/build/outputs/apk/release/app-release.apk

echo ">> Assembling Android release APK"
./gradlew assembleRelease --no-daemon

echo ">> Installing $APK to device $DEVICE"
adb -s "$DEVICE" install -r "$APK"
echo ">> Done."
