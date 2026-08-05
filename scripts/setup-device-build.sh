#!/usr/bin/env bash
# SableSat 真机 release 构建 —— 一次性环境准备
#
# 只做「准备」，不触发编译。跑完后用 BUILD-ON-DEVICE.md 里的命令编译。
# 全程幂等，可重复执行。
set -euo pipefail

BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
ok(){ echo "${GRN}  ✓${RST} $*"; }
warn(){ echo "${YLW}  !${RST} $*"; }
die(){ echo "${RED}  ✗${RST} $*"; exit 1; }
step(){ echo; echo "${BOLD}$*${RST}"; }

cd "$(dirname "$0")/.."
ROOT="$PWD"

step "1/6 检查工具链"
command -v node >/dev/null || die "未找到 node"
ok "node $(node -v)"
command -v xcodebuild >/dev/null && ok "Xcode $(xcodebuild -version | head -1)" || warn "未找到 xcodebuild，iOS 构建不可用"
if command -v pod >/dev/null; then ok "CocoaPods $(pod --version)"
else warn "未找到 CocoaPods —— iOS 必需。安装：${BOLD}brew install cocoapods${RST}"; fi
[ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ] && ok "Android SDK: ${ANDROID_HOME:-$ANDROID_SDK_ROOT}" \
  || warn "ANDROID_HOME 未设置。通常是 ~/Library/Android/sdk"

step "2/6 安装 JS 依赖"
npm install
ok "node_modules 就绪"

step "3/6 补齐 SDK 对应版本的包"
# 版本交给 expo 解析，避免手写版本号与 SDK 56 冲突
npx expo install expo-build-properties babel-preset-expo
ok "expo-build-properties / babel-preset-expo 已按 SDK 版本安装"

step "4/6 校验（类型 + 单元测试）"
npx tsc --noEmit && ok "类型检查通过" || die "类型检查失败"
npx jest --silent && ok "单元测试通过" || warn "有测试未通过，请先查看输出"

step "5/6 iOS Pods"
if command -v pod >/dev/null && [ -d ios ]; then
  # 新增了 quick-crypto / jail-monkey / expo-screen-capture / expo-device，
  # 旧的 Podfile.lock 里没有它们，必须重跑。
  (cd ios && pod install)
  ok "Pods 已同步"
else
  warn "跳过 pod install"
fi

step "6/6 Android release 签名"
GP="$HOME/.gradle/gradle.properties"
if grep -q "SABLESAT_UPLOAD_STORE_FILE" "$GP" 2>/dev/null; then
  ok "签名凭证已配置于 $GP"
else
  warn "release 构建需要签名凭证，当前未配置。"
  cat <<EOF

  ${BOLD}生成 keystore（口令请用密码管理器，丢了就无法再升级已发布的应用）：${RST}

    mkdir -p ~/keystores
    keytool -genkeypair -v -storetype PKCS12 \\
      -keystore ~/keystores/sablesat-upload.keystore \\
      -alias sablesat-upload -keyalg RSA -keysize 4096 -validity 10000

  ${BOLD}然后写入 $GP：${RST}

    SABLESAT_UPLOAD_STORE_FILE=$HOME/keystores/sablesat-upload.keystore
    SABLESAT_UPLOAD_STORE_PASSWORD=<你的口令>
    SABLESAT_UPLOAD_KEY_ALIAS=sablesat-upload
    SABLESAT_UPLOAD_KEY_PASSWORD=<你的口令>

  ${BOLD}并把 keystore 单独备份到密码管理器/离线介质。${RST}
  未配置时 release 构建会直接失败（这是刻意的，防止误用 debug 口令签名发布）。

EOF
fi

echo; echo "${BOLD}准备完成。编译命令见 BUILD-ON-DEVICE.md${RST}"
