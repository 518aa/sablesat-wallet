# 安全审计整改 CHANGELOG

本次改动覆盖审计报告的全部 30 项发现、越狱检测/证书固定/多签三个方向的完善建议，
以及解锁性能优化。**未保留向后兼容**（按约定，尚无真实用户），旧的 v1/v2 数据格式
与 legacy 迁移分支已全部删除。

---

## 🔴 P0 — 发布阻断项

### 0. 熵源加固：消除 `Math.random()` 退化路径 ⚠️ 追加发现
`src/services/randomness.ts`（新增）

审计追问「私钥生成的随机性如何」时发现的问题。`expo-crypto` 的**同步**
`getRandomBytes()` 源码里有这么一段：

```js
if (__DEV__) {
  if (!global.nativeCallSyncHook || global.__REMOTEDEV__) {
    // remote javascript debugging is enabled
    for (...) array[i] = Math.floor(Math.random() * 256);   // ← !!
    return array;
  }
}
```

即：**开发构建 + 调试器 attach 时，熵源静默退化成 `Math.random()`**。
Hermes / V8 的 `Math.random` 是 xorshift128+，约 2 个输出即可还原内部状态 ——
在那个状态下创建的钱包，助记词可被直接逆推。

旧代码有 **4 处**直接依赖它：
- `wallet.ts generateMnemonic()` — 主钱包助记词熵
- `SigningTerminalSetupScreen.tsx` — 冷钱包助记词（另一份重复实现）
- `mnemonicStore.ts getDeviceSecret()` — device secret
- `App.tsx` 的 crypto polyfill → `@noble` 的 salt / nonce / DEK

生产构建（`__DEV__ === false`）不受影响，但开发者调试时创建的测试钱包会中招，
而且这类「看起来仍然随机」的降级最危险。

**更糟的是我第一版写的 `assertEntropyAvailable()` 自检发现不了它** —— 只检查了
全零和两次重复，而 `Math.random` 的输出非零、不重复、分布均匀，完全能通过。

修复：
- 新增 `randomness.ts` 作为**唯一**熵源入口，全部 4 处改为经由它
- 显式检测降级条件（`__DEV__ && (!nativeCallSyncHook || __REMOTEDEV__)`），
  命中即 `throw WeakEntropyError`，**绝不静默产出弱随机**
- 优先用 `react-native-quick-crypto`（JSI → OpenSSL CSPRNG）；
  否则**直接调原生模块** `ExpoCrypto.getRandomValues`，绕过那段 JS 降级逻辑
- 自检改为**结构性检查**为主（统计检验对此无效），统计检查只作 RNG 卡死的兜底
- `security.ts` 新增 `allowKeyGeneration` 策略，熵源降级时禁止生成新钱包并
  在首页显示醒目告警

### 1. Android release 不再用 debug keystore 签名
`android/app/build.gradle`

旧代码 release buildType 直接 `signingConfig signingConfigs.debug`，口令是公开的 `android`，
任何人都能伪造升级包。现在签名凭证从 `gradle.properties` / 环境变量注入，**缺凭证时构建
直接失败**（`throw new GradleException`），不会静默回退到 debug 签名。EAS Build 环境下
由 EAS 凭证服务接管。

需要你做：生成 upload keystore，在 `~/.gradle/gradle.properties` 设置
`SABLESAT_UPLOAD_STORE_FILE` / `_STORE_PASSWORD` / `_KEY_ALIAS` / `_KEY_PASSWORD`。

### 2. iOS Face ID 崩溃修复
`app.json`

补上 `NSFaceIDUsageDescription`（缺失时调用 Face ID 会**立即崩溃**）与
`expo-local-authentication` plugin 声明；另外加了显式 ATS 配置
（`NSAllowsArbitraryLoads: false`）与 `expo-build-properties`（Android `usesCleartextTraffic=false`）。

`ITSAppUsesNonExemptEncryption` 由 `false` 改为 `true` — 应用确实使用了非豁免加密。
**需要你填入 `ITSEncryptionExportComplianceCode`**（占位符已留）。

---

## 🟠 P1 — 高危

### 3. 胁迫钱包改用独立助记词
`src/services/duress.ts`、`src/services/wallet.ts`

旧 payload 是 `{ mnemonic: <主助记词>, passphrase: <胁迫口令词> }` —— 装的**就是主钱包
助记词本体**。胁迫者拿到设备和胁迫 PIN 后 dump Keychain 离线解密即可拿到主种子，
`assertNotDuress()` 那层 App 内封锁形同虚设。

现在 `setupDuressEntry()` 调用 `generateMnemonic()` 生成**独立**助记词，与主 vault
在密码学上完全无关联，并在设置完成后提示用户单独备份诱饵助记词。

### 4. PIN 锁定改指数退避，抹除策略默认关闭
`src/services/pin.ts`

旧策略：5 次错 → 锁 60 秒；8 次错 → **直接抹除 vault**，5→8 之间无任何递增惩罚。
口袋误触 8 次即资产归零。

新策略：
- 退避 `1min → 5min → 30min → 2h → 6h → 24h`
- 抹除策略**默认关闭**，需用户在设置页显式开启（阈值 20），开启前弹窗说明后果
- 失败计数改为**写前递增**：攻击者在 KDF 返回后、写盘前杀进程无法再规避计数

### 5. 主 PIN 强度校验
`src/services/pin.ts`、`src/screens/SettingsScreen.tsx`

旧实现 `isWeakPin()` **只在胁迫 PIN 路径被调用**，主 PIN 只校验 `^\d{6,8}$` —— 用户可以
设成 `123456`。现在两条路径共用 `validateNewPin()`，并扩充了检测：连续序列、重复模式
（`121212`/`123123`）、唯一数字过少（`112211`）。PIN 长度上限放宽到 12 位。

### 6. App Store Connect 凭证移出源码
`scripts/asc_api.py`、`scripts/debug_jwt.py`、`scripts/build-ios-appstore.sh`

Key ID / Issuer ID / .p8 绝对路径原本硬编码在仓库里，现在全部读环境变量
（`ASC_KEY_PATH` / `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_TEAM_ID`）。

**需要你做：如果此仓库曾对外分享过，请吊销并重签这把 ASC key。** 另外原 `.p8` 路径
指向 Apple Notes 的 iCloud 同步目录，请移到不同步的安全位置。

### 7. 移除助记词/私钥剪贴板复制
`src/screens/OfflineSignScreen.tsx`、`src/screens/SettingsScreen.tsx`

Android 上任意 App 可读剪贴板，iOS 通用剪贴板会同步到同一 Apple ID 的其他设备 ——
30 秒自动清空远不足以防住这两条路径。改为「屏幕显示 + 手抄 + 逐词核对」。
地址 / zpub / 已签 PSBT 等公开数据的复制保留。

### 8. 防截屏与后台快照
`src/services/screenGuard.ts`（新增）

`useScreenGuard()` hook 基于 `expo-screen-capture` 做引用计数，已挂到助记词展示页
（SettingsScreen）与离线签名页（OfflineSignScreen）。iOS 上截屏无法阻止，另提供
`useScreenshotWarning()` 事后提示。

---

## 🟡 P2 — 中危 / 正确性

| # | 位置 | 修复 |
|---|------|------|
| 9 | `transaction.ts` `assertFeeSane()` | **签名前 hard-fail 手续费上限**：占输入总额 >10% 或 >500 sat/vB 直接拒签。多签路径同（`vault/psbt.ts` `assertVaultFeeSane`）。旧实现签名端完全不校验 fee |
| 10 | `evm.ts` `withProviderOnce()` | 写操作**只在广播前**允许切 RPC。旧实现 `tx.wait()` 超时会在下个 RPC 上重发交易 |
| 11 | `src/polyfills.ts`（新增） | crypto polyfill 移到独立文件并在 App.tsx **第一行**导入（ESM import 提升问题）；新增 `assertEntropyAvailable()` 启动自检，熵源异常拒绝启动 |
| 12 | `crypto.ts` `integrityTag()` | 缓存完整性改 **HMAC-SHA256**（密钥从 root 派生）。旧实现是 `SHA256(硬编码盐+数据)`，盐在 bundle 里，只防损坏不防篡改。无标签的旧缓存一律不信任 |
| 13 | `evm.ts` | `decimals` 用 `AbiCoder` 解码并严格校验（旧代码 `\|\| 18` 把 0 位小数静默改成 18，差 10^18 倍）；`hexToAscii` 手写 ABI 解码器换成 `AbiCoder`；非 ERC-20 地址不再静默产出假代币 |
| 14 | `utils/bitcoin.ts` | `btcToSatsOrNull()` 对非法输入返回 `null` 而非静默 0；`btcToSats()` 抛 `InvalidAmountError`；`parseBitcoinUri` 按 BIP21 拒绝未知 `req-` 参数与非法 amount |
| 15 | `blockchain.ts` | `txCount` 按 txid 去重（旧实现跨地址重复计数） |
| 16 | `wallet.ts` `getAccountZpub()` | 按网络模式导出 zpub/vpub（旧实现硬编码 `m/84'/0'/0'`，testnet 下与地址树不匹配） |
| 17 | `transaction.ts` / `vault/psbt.ts` | **默认启用 RBF**（`sequence = 0xFFFFFFFD`）。旧实现固定 `0xFFFFFFFE`，低费交易卡 mempool 无法加速 |
| 18 | `logger.ts` | 脱敏**递归**处理对象/数组/Map/Set；新增助记词模式与扩展公钥模式；敏感键名（mnemonic/seed/passphrase/…）整体屏蔽；裸字节一律不打印内容；删除重复的死规则 |
| 19 | `package.json` | 补 `expo-constants` 等未声明依赖 |
| 20 | `hosts.ts` | 如实标注 `redirect: "manual"` 在 RN 上不生效；新增最终 URL 白名单兜底校验 |

---

## 🔵 P3 — 性能与清理

- **`wallet.ts` 派生缓存**：解锁时预派生并缓存 account 节点，地址派生只走最后一级
  （实测 12 个地址 42ms → 8ms）；新增 `address → {child, path}` Map，签名时按地址反查
  不再线性重扫整棵树
- **`transaction.ts` UTXO 短时缓存**：预览与构造共用一次拉取（旧实现拉两遍全量 UTXO）
- **`vault/psbt.ts` 派生 memo 化**：`collectVaultScripts` / `summarizePsbt` 按 vault 指纹缓存
- **删除死代码**：`getPrivateKeyForAddress()`（从未被调用）、`logger.ts` 重复规则、
  `mnemonicStore.ts`（被 `vaultKey.ts` 取代）、`MigrateView` 与 legacy 迁移分支、
  `sortedPubkeys()` 标注 `@internal`
- **`blockchain.ts`**：删除硬编码兜底价 `FALLBACK_BTC_CNY_PRICE = 432_000`，价格不可用时
  返回 `null` 由 UI 显示「价格不可用」，不再编造数字

---

## ⚡ 解锁性能：1683ms → 约 90ms（22×）

### 核心：删掉解锁路径上的冗余 PBKDF2

实测（Node/V8，Hermes 上还要慢 3–8 倍）：

| 操作 | 耗时 |
|---|---|
| PBKDF2-SHA256 600k（旧 PIN 校验） | **1551 ms** |
| scrypt N=16384（vault 解密） | **89 ms** |

`App.tsx` 里那条「fast path: check PIN first (PBKDF2 ~0.5s) to avoid expensive scrypt
(2-4s)」的注释假设是反的 —— PBKDF2 比 scrypt 贵 14 倍。

而且这个 PBKDF2 **完全冗余**：vault 用 AES-256-GCM 加密，PIN 错 → 派生的密钥错 →
认证标签校验失败。解密本身就是密码学强认证。`pin.ts` 现在只负责失败计数与锁定退避
（不需要 KDF），PIN 哈希记录已彻底删除。

### 两级密钥架构（KEK / DEK）
`src/services/vaultKey.ts`（新增）

```
随机 DEK(32B) ──AES-256-GCM──> vault({mnemonic, passphrase})

DEK 被两条路径分别包裹：
  ① 生物识别  DEK 存 SecureStore，requireAuthentication:true
              + WHEN_PASSCODE_SET_THIS_DEVICE_ONLY
              → Secure Enclave / Keystore 硬件门禁，解锁 0 次 KDF
  ② PIN       wrap(DEK, scrypt(PIN)) → 生物识别不可用/失效时的回退
```

| 场景 | 旧 | 新 |
|---|---|---|
| 日常解锁 | 1683 ms | **< 100 ms**（生物识别）/ ~90 ms（PIN） |
| 错误 PIN | 2943 ms | ~180 ms |
| 改 PIN | 3128 ms（4 次 KDF + 重加密 vault） | **~90 ms**（只重新包裹 32 字节 DEK） |
| 离线爆破 PIN | 可行 | 生物识别路径下 DEK 在 SE 内，不可导出 |

### 其他解锁相关改动
- `crypto.ts` 改用 **`scryptAsync`**（`asyncTick: 10`）：同步版本会独占 JS 线程，
  转圈动画整个过程冻住，用户感知为「卡死」，还有 Android ANR 风险。代价仅 +20ms
- `src/services/kdf.ts`（新增）：优先走 **`react-native-quick-crypto`**（JSI → OpenSSL），
  不可用时回退 `@noble`。scrypt 参数随实现自适应（原生 N=32768 / JS N=16384）
- `pin.ts` legacy KDF 升级改 fire-and-forget（旧实现是 `await`，升级用户第一次解锁等双倍）
- **前台切换宽限期 30 秒**（`App.tsx` `FOREGROUND_GRACE_MS`）：旧实现任何一次进入
  background 都立即锁定。从敏感界面离开时**不给**宽限期
- **口令词与助记词同存 vault**：旧实现另存一份 `SHA256(SHA256(seed))` 校验哈希，
  那是可离线检验的验证器 —— 攻击者拿到助记词后能以极低成本爆破口令词。
  现在没有独立验证器，可否认性由（已改独立助记词的）胁迫钱包提供

---

## 🔒 越狱检测

`src/services/security.ts` 重写

旧实现只查 `__DEV__` 和 Expo Go，**连模拟器都不查**（模拟器上密钥库是明文文件），
且结论只用于渲染一个横幅，完全不接入业务逻辑。

现在：
- 新增检测：模拟器（`expo-device`）、越狱/root（`jail-monkey`）、运行时注入（Frida 痕迹）、
  外部存储安装
- **分级策略 `getSecurityPolicy()` 真正接入业务**：`danger` 级下强制每笔生物识别、
  单笔上限 0.01 BTC（`assertSendAllowed()`）、禁用助记词/私钥导出（`assertExportAllowed()`）、
  禁止启用生物识别快速解锁
- **不做「检测到 root 就阻断启动」** —— 那只会促使用户装 Magisk Hide 绕过，
  结果连信号本身都失去。改为分级降权
- 最有价值的一条是把门禁交给硬件（见上面的 `requireAuthentication`），
  而不是靠 JS 层探测

---

## 🔐 传输安全（替代证书固定）

**没有做证书固定**，这是刻意的：`hosts.ts` 白名单里 13 个域名全是第三方，
pin 别人的证书意味着对方例行换证时钱包直接失去联网能力，修复还要过商店审核。

改为把信任从传输层挪到数据层：

- **价格多源取中位数**（`blockchain.ts`）：旧实现是顺序 failover，污染 coinbase 一家
  就够了；现在 7 个源并行取中位数，攻击者需同时污染 4 家。偏离中位数 >10% 的源会告警
- **`fetchBitcoinApiCrossChecked()`**（`network.ts` 新增）：关键读取双源交叉验证，
  不一致时告警而非静默取第一个。这挡的是 MITM 最有价值的攻击 —— **隐瞒**
  （隐藏一笔 UTXO / 伪造未确认入账）
- 已有的「本地算 txid 再与广播返回比对」是对的思路，予以保留并在注释中作为范例说明

---

## 🔑 多签

### 最严重：新增 output descriptor 导出与强制备份
`src/services/vault/descriptor.ts`（新增）

旧实现 vault 配置只存在 AsyncStorage 一处。**设备丢失后，即使完整保存了助记词，
多签资产也拿不回来** —— 恢复 2-of-3 需要另外两个 cosigner 的 xpub。这是多签用户
丢币的头号原因。

现在：
- 完整的 BIP380 `wsh(sortedmulti(...))` 描述符生成/解析，含 checksum（抄错一个字符即检出）
- 支持 multipath `<0;1>` 单行形式与 receive/change 分开两种
- **创建流程强制门禁**：未确认备份 descriptor 之前不放行到金库详情页（`VaultCreateScreen`）
- 未备份的 vault 在详情页常驻警告卡片，可随时重新查看

### 重复 xpub 检测
`descriptor.ts` `assertNoDuplicateCosigners()`、`useVaults.ts`、`VaultCreateScreen.tsx`

旧实现只校验每个 xpub 格式合法，**完全没有去重**。把同一个 xpub 粘进 2-of-3 的两个
外部槽位（复制粘贴时极易发生）→ 实际退化成 1-of-2，而 `sortedMultisig` 会正常接受、
地址能生成、链上有效，**用户完全无感**。

比较前先用 `parseExtKey()` 归一化（同一把密钥的 xpub/zpub/Zpub 字符串不同但等价），
同时检测 fingerprint 重复。UI 层在输入阶段就实时提示。

### 跨设备地址校验引导
`VaultDetailScreen.tsx`

收款前弹窗提示在**每一台** cosigner 设备上独立派生同一索引的地址并比对。
只在本机算一次是无效的 —— 如果本机被攻破（添加 cosigner 时 xpub 被换），
你会把钱收进攻击者能凑够 m 签的地址。

### BC-UR 动态 QR
`src/services/vault/ur.ts`（新增）

单 QR 上限 1200 字符对 2-of-3 P2WSH 远远不够（单输入就 400+ 字符），
而离线签名终端是气隙设备，QR 是唯一通道。`planPsbtQr()` 超限时自动切成
`ur:crypto-psbt` 分片轮播，`PsbtUrScanner` 增量解码。这是 Sparrow / Keystone /
Foundation 的事实标准，顺带白拿互操作性。

### 其他
- **account 索引**：`m/48'/{coin}'/{account}'/2'`，新建 vault 自动递增。
  旧实现写死 account=0，同一种子的所有 vault 共用同一把 cosigner 密钥
- **schema 校验**：`assertValidVaultConfig()` 在保存前与读取后各跑一次
  （旧实现是裸的 `JSON.parse(...) as VaultConfig[]`，m=0 这种会直接进签名路径）
- **输入数量断言**：`signVaultPsbtSelf` 校验 `tx.inputsLength === inputs.length`
  （旧实现多出的输入会静默不签，用户拿到看似"签好了"实则无效的 PSBT）
- **边界校验**：`deriveVaultAddress` 拒绝 m<1、n>15（P2WSH 的 OP_1..OP_16 上限）

---

## 测试

新增 `src/__tests__/`：`descriptor.test.ts`、`pin.test.ts`、`bitcoinUtils.test.ts`、
`logger.test.ts`、`kdfParity.test.ts`、`randomness.test.ts`；扩充 `crypto.test.ts`（DEK 包裹、HMAC 完整性）。
删除 `duress.test.ts`（针对已废弃的 API）。

沙盒中通过独立 harness 验证了 45 项断言（BIP380 checksum 含 Bitcoin Core 权威向量
`raw(deadbeef)#89f8spxm`、重复 cosigner 检测、m/n 边界、PIN 强度、金额解析、日志脱敏、
手续费上限、RBF sequence、熵源降级检测），全部通过。

---

## ⚠️ 需要你本地验证的部分

沙盒环境无法完成 EAS Build 与真机测试，以下必须在本地确认：

1. **`npm ci && npm run typecheck && npm run lint && npm test`** —— 沙盒里 jest 二进制
   未装全，我用独立 harness 验证了纯逻辑，但完整测试套件需要你跑
2. **原生模块编译**：`react-native-quick-crypto` / `jail-monkey` / `@ngraveio/bc-ur`
   都需要 EAS Build 或本地 prebuild，Expo Go 下会走 JS 回退分支
3. **KDF 一致性**：务必确认原生与 JS 两条实现产出逐字节一致的结果
   （`npm run test:kdf-parity`）。不一致的话，Expo Go 里建的钱包在正式包里解不开
4. **descriptor 互操作**：把导出的描述符导入 Sparrow / Bitcoin Core 确认能识别，
   并核对派生出的地址与本机一致
5. **生物识别失效路径**：重新录入指纹/面容后，确认能正确回退到 PIN 并重新启用
6. **`ITSEncryptionExportComplianceCode`** 需要填入你的实际合规码
