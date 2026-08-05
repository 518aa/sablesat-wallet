#!/usr/bin/env bash
#
# build-ios-appstore.sh — 用 Dialing An 的 App Store 描述文件打 TestFlight 用 IPA
#
# 用法:
#   ./scripts/build-ios-appstore.sh <path-to-appstore.mobileprovision>
#
# 前置:
#   - 钥匙串已有 "Apple Distribution: Dialing An (8W8SH2P9JH)" 证书
#   - 描述文件必须是 App Store 类型 (get-task-allow=false, 无 ProvisionedDevices)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE_PATH="${1:?用法: $0 <path-to-appstore.mobileprovision>}"
APP_BUNDLE_ID="com.bitnest.wallet"
TEAM_ID="${ASC_TEAM_ID:?请先 export ASC_TEAM_ID}"

echo "== 解码描述文件 =="
PLIST="$(security cms -D -i "$PROFILE_PATH" 2>/dev/null)"
UUID="$(echo "$PLIST" | plutil -extract UUID raw -)"
PNAME="$(echo "$PLIST" | plutil -extract Name raw -)"
APPID="$(echo "$PLIST" | plutil -extract Entitlements.application-identifier raw - 2>/dev/null | sed 's/^[^.]*\.//')"
GETTASK="$(echo "$PLIST" | plutil -extract Entitlements.get-task-allow raw - 2>/dev/null || echo false)"
# ProvisionedDevices 键仅在 Ad Hoc/Development 类型存在；App Store 类型没有该键
if echo "$PLIST" | grep -q "ProvisionedDevices"; then
  HAS_DEVICES=yes
else
  HAS_DEVICES=no
fi

echo "  UUID          = $UUID"
echo "  Name          = $PNAME"
echo "  applicationId = $APPID"
echo "  get-task-allow= $GETTASK"
echo "  hasDevices    = $HAS_DEVICES"

if [ "$APPID" != "$APP_BUNDLE_ID" ]; then
  echo "!! 描述文件 bundle id ($APPID) 与 $APP_BUNDLE_ID 不符" >&2
  exit 1
fi
if [ "$GETTASK" = "true" ] || [ "$HAS_DEVICES" = "yes" ]; then
  echo "!! 这不是 App Store 描述文件 (get-task-allow=$GETTASK, 含设备列表=$HAS_DEVICES)" >&2
  echo "   请到开发者后台下载 App Store 类型 (不是 Ad Hoc / Development)" >&2
  exit 1
fi
echo "== 描述文件校验通过 (App Store 类型) =="

# 放到 Xcode 能按 UUID 找到的位置
mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
cp "$PROFILE_PATH" "$HOME/Library/MobileDevice/Provisioning Profiles/$UUID.mobileprovision"

EXPORT_PLIST="$ROOT/scripts/ExportOptions-appstore.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store</string>
  <key>signingStyle</key><string>manual</string>
  <key>teamId</key><string>$TEAM_ID</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$APP_BUNDLE_ID</key><string>$UUID</string>
  </dict>
</dict>
</plist>
EOF

echo "== 归档 (Release / App Store) =="
xcodebuild -workspace ios/SableSat.xcworkspace -scheme SableSat \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath ios/build/AppStore/SableSat.xcarchive \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="$UUID" \
  archive 2>&1 | tee /tmp/ios_archive.log

echo "== 导出 IPA =="
xcodebuild -exportArchive \
  -archivePath ios/build/AppStore/SableSat.xcarchive \
  -exportPath ios/build/AppStore/ipa \
  -exportOptionsPlist "$EXPORT_PLIST" 2>&1 | tee /tmp/ios_export.log

echo "== 完成: IPA 位置 =="
ls -lh ios/build/AppStore/ipa/*.ipa
