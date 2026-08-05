#!/usr/bin/env bash
#
# Build & install SableSat (iOS) to a connected iPhone.
#
# Prerequisites (one-time, done in Xcode GUI):
#   Xcode -> Settings -> Accounts: sign in with the Dialing Apple ID
#   (51847964@qq.com) so provisioning profiles can be fetched.
#   Without a valid login, device builds cannot be signed.
#
# Usage:
#   ./scripts/build-ios.sh [device-udid]
#   device-udid defaults to the iPhone used for development.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UDID="${1:-00008120-000628293E88C01E}"   # physical device UDID for xcodebuild -destination
TEAM=5CPG294RT4                           # Dialing An DEVELOPMENT team (has the dev cert)
DERIVED=ios/build/Dialing

echo ">> Building SableSat (Release) for device $UDID, team $TEAM"
xcodebuild \
  -workspace ios/SableSat.xcworkspace \
  -scheme SableSat \
  -configuration Release \
  -destination "id=$UDID" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  -derivedDataPath "$DERIVED" \
  build

APP="$DERIVED/Build/Products/Release-iphoneos/SableSat.app"

# devicectl identifies devices by its CoreDevice UUID, not the hardware UDID.
# Pick the first connected iPhone/iPad from `xcrun devicectl list devices`.
DEVICE_ID="$(xcrun devicectl list devices \
  | awk '$4=="connected" && $5 ~ /iPhone|iPad/ {print $3; exit}')"

if [ -z "$DEVICE_ID" ]; then
  echo "!! No connected iPhone/iPad found via devicectl." >&2
  exit 1
fi

echo ">> Installing $APP to device $DEVICE_ID"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
echo ">> Done."
