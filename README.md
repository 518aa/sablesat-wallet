# BitNest Wallet / 比特币钱包

一个从零构建的 iOS + Android 双端比特币钱包原型，基于 Expo React Native。界面内置中文/英文切换，默认面向新手用户。

## 已实现

- 创建 24 词助记词钱包。两级密钥架构：随机 DEK 加密助记词，DEK 分别由
  ① Secure Enclave / Keystore（生物识别门禁）② scrypt(PIN) 两条路径包裹。
- 导入已有英文助记词（12/24 词）。
- 解锁支持生物识别（<100ms，0 次 KDF）与 PIN（约 90ms）两条路径。
  PIN 失败指数退避（1min → 5min → 30min → 2h → 6h → 24h）；
  「多次失败后清除钱包」为可选策略，**默认关闭**。
- 按 BIP84 路径派生 BTC 主网 `bc1` 收款地址，找零地址每次递增以保护隐私。
- 按 BIP44 gap limit（`GAP_LIMIT = 20`，与 Electrum / Sparrow / BlueWallet 一致）
  扫描 `m/84'/0'/0'/{0,1}/0..n+20` 全部地址，正确聚合余额与 UTXO，每次签名的 UTXO
  用对应路径的私钥。该值由 `src/__tests__/auditFixes.test.ts` 断言，不得下调 ——
  低于 20 会导致导入外部钱包助记词时漏扫地址，表现为"链上有钱、App 说余额不足"。
- 查询地址余额和最近交易（钱包级聚合，跨多地址去重）。
- 获取 BTC/CNY 参考价并计算购买预估。
- 支付宝购买入口：支持配置真实后端下单接口；未配置时自动进入演示模式。
- 发送前强制二次确认收款地址（前 8 位 + 后 8 位高亮）。
- 运行环境告警：在 Expo Go 或开发构建内显示醒目提示，避免误用做主资产钱包。
- 网络出口白名单：所有 BTC / 价格 / EVM RPC 请求必须命中 `src/services/hosts.ts` 中的主机集合，未知主机直接抛错。
- 中英文 UI、新人三步、安全备份提醒、重置钱包。

## 安全审计整改

本项目已完成一轮完整安全审计与整改，详见 `CHANGELOG-SECURITY-AUDIT.md`。
关键变更：

- **解锁从约 1.7s 降到 90ms**（生物识别路径 <100ms）：删掉了解锁路径上冗余的
  600k PBKDF2，改用两级密钥架构（DEK 由 Secure Enclave / Keystore 保护）
- **胁迫钱包改用独立助记词** —— 旧实现的 payload 里装的是主助记词本体

  ⚠️ 注意「解锁从 1.7s 降到 90ms」的**代价**：PIN 路径包裹 DEK 的 scrypt 记录
  （`sablesat.dek.pin.v1`）就在同一个 Keychain 里。生物识别路径确实消除了离线
  爆破（DEK 在 Secure Enclave 内不可导出），但**PIN 路径没有**：拿到 Keychain
  转储的攻击者可以对 6 位 PIN 做离线穷举，10^6 × scrypt(N=32768,r=8) 在专用硬件上
  是天级而非年级。因此 vault 的真实安全下界是 **PIN 的熵**，不是 scrypt 的强度。
  改进方向：允许字母数字口令，或让 PIN 路径的 KEK 与一个受 Secure Enclave 门禁的
  密钥做 HKDF 混合，把离线攻击变成必须在设备上进行。
- **多签新增 output descriptor 导出与强制备份** —— 否则设备丢失后仅有助记词
  无法恢复多签资产；新增重复 xpub 检测（旧实现会让 2-of-3 静默退化成 1-of-2）
- **签名端新增手续费上限校验**、默认启用 RBF、越狱检测接入业务策略、防截屏
- **熵源加固**：`expo-crypto` 的同步 `getRandomBytes` 在开发构建 + 调试器 attach 时
  会静默退化成 `Math.random()`（助记词可被逆推）。现已统一经由
  `src/services/randomness.ts`，命中降级条件直接 hard-fail 并禁止生成新钱包

## 仍未覆盖（生产前必须评估）

- **越狱 / root 检测的固有局限**：已集成 `jail-monkey` + 模拟器检测 + Frida 痕迹探测
  （`src/services/security.ts`），但客户端检测在有动机的攻击者面前必然失效
  （Shadow / Liberty Lite / Frida 都能 hook 掉）。**这是风险信号，不是安全边界。**
  真正的边界建在硬件上——vault 密钥受 `requireAuthentication` + Secure Enclave 保护。
  策略上采取分级降权而非直接阻断（直接阻断只会促使用户绕过，反而丢掉信号）。
  更强的方案是 App Attest / Play Integrity，但两者都需要服务端验证 token，
  纯客户端钱包无法使用；若上线支付后端，应在那条链路上启用。
- **证书固定：刻意不做**。白名单里 13 个域名全是第三方，pin 别人的证书意味着对方
  例行换证时钱包直接失去联网能力，修复还要过商店审核——一个比特币钱包因为 pinning
  配置失效而无法广播交易，损失可能远大于它防住的 MITM。
  改为把信任从传输层挪到数据层：价格多源取中位数（`fetchBtcCnyPrice`，已实现）、
  广播 txid 本地计算比对（已实现）。
  **⚠️ 已知缺口：`fetchBitcoinApiCrossChecked` 已写好但尚未接入任何调用点**——
  余额 / UTXO / 交易历史目前走的仍是 `fetchBitcoinApi`（first-success failover），
  即"关键链上读取的双源交叉验证"这一层**当前并不存在**。上线前必须二选一：
  把它接到 `fetchWalletState` / `fetchAllWalletUtxos`，或删掉这段声明。
  若未来上线自有后端，可只对自有域名做 pinning（务必配备用 pin + 远程 kill-switch）。
  另注意：`redirect: "manual"` 在 RN 上不生效（OkHttp/NSURLSession 会忽略），
  已在 `hosts.ts` 中如实标注并加了最终 URL 兜底校验。
- **多签**：已实现 2-of-2 / 2-of-3 / 3-of-4 / 3-of-5 的 P2WSH 多签金库
  （BIP48 派生 + BIP67 排序 + PSBT 协同签名），并补齐了 BIP380 descriptor 导出、
  BC-UR 动态 QR、重复 cosigner 检测、跨设备地址校验引导。
  **仍建议**首次使用前用测试网跑通完整流程，并与 Sparrow 互相导入验证描述符。


## 运行

```bash
npm install
npm start
```

然后用 Expo Go 扫码，或运行：

```bash
npm run ios
npm run android
```

## 支付宝接入

移动端不能直接保存支付宝应用私钥，也不能在客户端完成完整的合规下单流程。生产环境需要一个后端接口负责：

1. 校验用户、风控、KYC/AML 状态。
2. 调用支付宝开放平台创建订单并完成签名。
3. 返回支付宝收银台链接或 native SDK 所需 order string。
4. 接收支付宝异步通知。
5. 付款成功后通过你的 BTC 流动性/托管/出币服务放币到用户地址。

配置 `.env`：

```bash
EXPO_PUBLIC_ALIPAY_ORDER_ENDPOINT=https://your-api.example.com/payments/alipay/order
```

当前移动端请求契约：

```json
{
  "amountCny": 100,
  "asset": "BTC",
  "network": "bitcoin-mainnet",
  "payoutAddress": "bc1..."
}
```

期望响应：

```json
{
  "id": "merchant-order-id",
  "status": "created",
  "paymentUrl": "alipay cashier url or deeplink"
}
```

## 上线前必须完成

- 钱包安全审计和助记词备份确认流程。
- 交易构建、手续费估算、广播和硬件安全策略。
- 支付宝商户进件、App 支付 SDK 或 H5 支付合规接入。
- 买币业务需要符合当地 KYC、AML、牌照和风控要求。
- App Store / Google Play 隐私政策、加密声明、金融产品审核材料。
