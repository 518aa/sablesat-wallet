# 装到真机（iPhone + 安卓）

环境：macOS + Xcode + Android Studio + 付费 Apple 开发者账号，目标 **release 构建**。

> ⚠️ **不要跑 `expo prebuild`。** 本项目是 bare workflow（`android/` `ios/` 已入库），
> `android/app/build.gradle` 有定制的签名加固，`prebuild --clean` 会用模板覆盖掉。
> 新增原生模块靠自动链接接入（Android `useExpoModules()` / iOS `use_expo_modules!`），
> 不需要 prebuild。

---

## 依赖已升到支持新架构的版本

你的工程是 RN 0.85 + `newArchEnabled=true`。原先我加的是旧架构模块，已全部换掉：

| 包 | 原 | 现 | 说明 |
|---|---|---|---|
| `react-native-quick-crypto` | 0.7.16（旧桥接，对着 RN 0.72 开发） | **1.1.6** | 走 Nitro Modules，原生支持新架构 |
| `react-native-nitro-modules` | — | **0.36.5** | quick-crypto 1.x 的 peer 依赖 |
| `react-native-quick-base64` | — | **3.0.0** | 同上 |
| `jail-monkey` | 2.8.5 | **3.0.0** | 3.0 起支持新架构 |

已确认 1.1.6 提供 `scrypt` / `scryptSync` / `pbkdf2Sync` / `randomFillSync` / `createHmac`——
解锁主路径用到的全部函数都在，导出形态（`module.exports = QuickCrypto` 带 `.default`）
也与代码里的探测逻辑一致。

`app.json` 的 plugins 已加入 `react-native-quick-crypto`（1.x 自带配置插件，必须注册）。

---

## 1. 准备

```bash
tar -xzf sablesat-wallet-audited.tar.gz -C ~/sablesat && cd ~/sablesat
bash scripts/setup-device-build.sh
```

脚本做：装依赖 → 按 SDK 补 `expo-build-properties`/`babel-preset-expo` →
类型检查 + 单元测试 → `pod install` → 检查 Android 签名凭证。

没装 CocoaPods 的话先 `brew install cocoapods`。

---

## 2. 安卓（release）

```bash
adb devices                                    # 确认手机已识别（需开 USB 调试）
npx expo run:android --variant release --device
```

首次拉 Gradle 依赖，5–15 分钟。

报「Release 构建缺少签名凭证」是我加的保护，不是 bug：

```bash
mkdir -p ~/keystores
keytool -genkeypair -v -storetype PKCS12 \
  -keystore ~/keystores/sablesat-upload.keystore \
  -alias sablesat-upload -keyalg RSA -keysize 4096 -validity 10000
```

再写入 `~/.gradle/gradle.properties`：

```properties
SABLESAT_UPLOAD_STORE_FILE=/Users/<你的用户名>/keystores/sablesat-upload.keystore
SABLESAT_UPLOAD_STORE_PASSWORD=<口令>
SABLESAT_UPLOAD_KEY_ALIAS=sablesat-upload
SABLESAT_UPLOAD_KEY_PASSWORD=<口令>
```

keystore 丢了就无法再升级已发布的应用，务必单独备份。

---

## 3. iPhone（release）

```bash
xcrun xctrace list devices | grep -i iphone     # 确认手机已识别
npx expo run:ios --configuration Release --device
```

首次需在 Xcode 里确认签名：

1. `open ios/SableSat.xcworkspace`（是 **.xcworkspace**，不是 .xcodeproj）
2. target `SableSat` → Signing & Capabilities
3. 勾 Automatically manage signing，Team 选你的付费账号
4. Bundle ID 当前 `com.bitnest.wallet`——若不属于你的 Team 就改掉，
   同时同步改 `app.json` 的 `ios.bundleIdentifier`

iPhone 首次运行前：设置 → 通用 → VPN 与设备管理 → 信任开发者证书。

---

## 4. 装上后必须验的

**第一优先，跑在任何性能测试之前：**

```bash
npm run test:kdf-parity
```

原生与 JS 两条 KDF 必须逐字节一致。不一致的话，一台设备建的钱包在另一条路径下
解不开——直接丢币。

然后在机上确认：

| 项 | 看哪里 | 预期 |
|---|---|---|
| 原生 KDF 生效 | 设置页 KDF 诊断 | 「原生加速：已启用」。显示未启用说明 quick-crypto 没链上 |
| 熵源 | 设置页熵源诊断 | `react-native-quick-crypto` 或 `ExpoCrypto native`，**不得**出现 `DEGRADED` |
| 解锁速度 | 冷启动输 PIN | ~90ms 级，无 1.7 秒卡顿 |
| 生物识别快速解锁 | 设置页启用后锁屏再解 | 秒开，0 次 KDF |
| 防截屏 | 助记词页截屏 | 安卓黑屏；iOS 截屏后有提示 |
| 越狱检测 | 正常机器首页 | 无告警横幅（有则是误报） |
| 多签强制备份 | 建金库 | 未确认备份 descriptor 前进不去详情页 |

---

## 5. 编译失败时的定位顺序

失败大概率出在新增的原生模块上，按这个顺序看：

1. **Nitro Modules 相关报错**（`nitrogen`、`NitroModules` 关键字）→ quick-crypto 1.x 的
   codegen 没跑起来，试 `cd ios && pod install --repo-update`
2. **`jail-monkey` 编译错** → 3.0.0 若仍不兼容，先从 `package.json` 移除它并
   `npm i && cd ios && pod install`；代码侧已验证可优雅降级（越狱判定退化为 false，
   其余安全策略照常），不影响其他功能
3. **Metro / babel 报错** → 确认 `babel.config.js` 存在（我这轮新建的，原项目缺失）
4. **`expo-build-properties` 插件解析失败** → `npx expo install expo-build-properties`

报错整段贴给我。

---

## 6. 上架前还需处理

- `ITSEncryptionExportComplianceCode` 现为占位符，真机安装不受影响，提交 App Store 前必须替换
- Bundle ID / package 仍是 `com.bitnest.wallet`，应用名已是 SableSat，建议统一
- `.env` 里 `EXPO_PUBLIC_` 前缀的变量会被打进客户端 bundle，任何人可见——确认该地址本就公开
