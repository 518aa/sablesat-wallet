# 装机后必查清单

按风险从高到低排。前两项在完成前**不要往钱包里放任何真实资产**。

---

## 🔴 1. KDF 一致性还没验过（报告里那个「4/4 通过」是误读）

```
PASS src/__tests__/kdfParity.test.ts
  ✓ reports which implementation is active
  ✓ scrypt matches the @noble reference
```

这个测试跑在 **Node** 里，`react-native-quick-crypto` 根本加载不了，
`isNativeKdfActive()` 恒为 `false` —— 它比的是**「@noble 对 @noble」**。
原生分支一次都没参与。脚本名 `test:kdf-parity` 是我起的，直接诱导了这个误读，
已改名为 `test:kdf-js-only`。

**为什么这件事严重**：若原生 scrypt 与 JS scrypt 对同一输入产出不同结果，
用一条路径创建的钱包在另一条路径下就解不开。换机、升级、原生模块加载失败
都会触发切换 —— 直接导致资产无法找回，且没有任何补救手段。

**真正的校验只能在设备上做。** 已新增 `kdf.checkKdfParity()`，并且：

- 接入设置页诊断，可随时手动查看
- **`createWallet` / `importWallet` 前强制执行**（`assertKdfParityOk`），
  两条实现不一致时直接拒绝创建钱包

重装后在设置页确认显示「原生与 JS 实现逐字节一致」。若显示不一致，
**立刻停止使用**，把 `scryptMatch` / `pbkdf2Match` 两个字段发我。

---

## 🔴 2. Android release APK 是用 debug keystore 签的

报告里写着「签名: debug keystore」。但我在 `android/app/build.gradle` 里加过
硬失败保护 —— 缺正式凭证时 `assembleRelease` 应该直接 `throw GradleException`。
它没触发，说明**那段保护已经不在你机器上的 build.gradle 里了**。

最可能的原因：中途某次 `npx expo run:android` 或 app.json 改动
（deploymentTarget 15.1 → 16.4）触发了 prebuild，用模板覆盖了 `build.gradle`。
这正是我之前提示「不要跑 prebuild」的原因。

**先确认：**

```bash
grep -c SABLESAT_UPLOAD_STORE_FILE android/app/build.gradle
```

- 返回 `3` → 保护还在，那 APK 是更早的构建产物，重新 `assembleRelease` 会正常报错
- 返回 `0` → 已被覆盖，用新包里的 `android/app/build.gradle` 覆盖回去

**debug keystore 的实际风险**：它的口令是公开的 `android`，全世界一样。
任何人都能用同一把 key 签一个恶意 APK，系统会认为那是**合法升级**并允许覆盖安装。
自己测试无妨，但这个包绝不能分发给任何人，也不要在上面存真实资产。

---

## 🟠 3. 闪退是我造成的，另有一个同类问题可能还在

`expo-device 8.0.10` 引用不存在的 `AnyTypeProvider` —— 根因是**我在 package.json 里
写错了版本号**，用了别的 SDK 的编号体系。你那边修了 `expo-constants` 和 `expo-device`，
但我一共写错了 **4 个**：

| 包 | 我写的 | 应为 |
|---|---|---|
| `expo-constants` | `~18.0.9` | `~56.0.22` ✅ 你已修 |
| `expo-device` | `~8.0.9` | `~56.0.4` ✅ 你已修 |
| **`expo-screen-capture`** | `~8.0.4` | `~56.0.4` ⚠️ 请确认 |
| **`expo-haptics`** | `^57.0.0` | `~56.0.4` ⚠️ 请确认 |

`expo-screen-capture` 是防截屏功能的依赖。版本不对的话可能不崩溃、
但**功能静默失效** —— 助记词页照样能截屏，而你不会收到任何提示。

```bash
npx expo install --check      # 列出所有版本不匹配的包
```

新包里这 4 个版本已修正。

---

## 🟡 4. 装上后逐项确认（原来的清单）

| 项 | 看哪里 | 预期 | 若不符 |
|---|---|---|---|
| **KDF 一致性** | 设置页诊断 | 「逐字节一致」 | 停用，发我详情 |
| 原生 KDF 生效 | 设置页 KDF 诊断 | 「原生加速：已启用」 | quick-crypto 没链上，功能仍可用但解锁慢 |
| 熵源 | 设置页熵源诊断 | `quick-crypto` 或 `ExpoCrypto native` | 出现 `DEGRADED` 则立刻停用 |
| 解锁速度 | 冷启动输 PIN | ~90ms 级 | 若仍卡顿说明原生 KDF 未生效 |
| 生物识别解锁 | 设置页启用后锁屏再解 | 秒开 | — |
| **防截屏** | 助记词页截屏 | 安卓黑屏 | 截得到 = `expo-screen-capture` 版本问题 |
| 越狱检测 | 正常机器首页 | 无告警横幅 | 有则是误报，发我看 |
| 多签强制备份 | 建金库 | 未备份 descriptor 进不去详情页 | — |

---

## 🟡 5. iOS 侧两个遗留

- **`ITSEncryptionExportComplianceCode`** 仍是占位符。真机安装不受影响，
  提交 App Store 会被拒。
- **Bundle ID `com.bitnest.wallet`** 与应用名 SableSat 不一致。不影响运行，
  但上架前建议统一（改了之后 iOS 上是一个全新应用，旧数据不会迁移）。

---

## 一句话

**在设置页确认 KDF 一致性通过之前，两台设备上都不要存真实资产。**
其余问题最多是功能失效或需要重装，只有 KDF 不一致会导致资产永久取不回来。
