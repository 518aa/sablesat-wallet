# 手动 E2E 检查清单（Vault 多签冷储）

这是「真机 + testnet」端到端验证清单，跟着勾选。脚本层面 e2e 见 `scripts/e2e-vault-flow.ts`，已经覆盖密码学层面；本文档覆盖 UI / 相机 / 真实 UTXO / 真实广播。

## 准备

- [ ] **两台设备**：可以是两台 Android 真机、两台 emulator（Pixel 5 API 34 推荐），或一台真机 + 一台 emulator
- [ ] **两份助记词**：用 Ian Coleman BIP39 工具或 `bip39` 命令行生成 2 份 24 词助记词，分别给 Device A 和 Device B
- [ ] **第三份助记词**（可选）：如果要做完整的 2-of-3，再用一份；如果只验证流程，可以 A、B 各持 1 把，C 暂时复用 A 或 B 的
- [ ] **Sparrow Wallet**（可选，用于交叉验证地址派生）：[https://sparrowwallet.com/](https://sparrowwallet.com/)

## 设备初始化（两台都做）

- [ ] 启动 app，分别用不同助记词**导入**钱包
- [ ] 设置 PIN、解锁
- [ ] 进入 **Settings → 高级 → 网络**，切到 **测试网**
- [ ] 确认警告（清空缓存、需重新解锁）
- [ ] 重新输入 PIN 解锁
- [ ] 进入 **首页**，确认余额显示 0 BTC（testnet 上还没钱）

## 创建 Vault（两台设备配置必须一致）

**Device A：**

- [ ] 进入 **Vault 标签页 → 创建金库**
- [ ] 复制「本机公钥 (Xpub)」字符串
- [ ] 录入 Device B 的 xpub（粘贴/扫码）
- [ ] 录入 Device C 的 xpub（粘贴/扫码，或暂时复用 B 的）
- [ ] 核对首收款地址（应该是 `tb1q...` 开头）→ 创建

**Device B：**

- [ ] 进入 **Vault 标签页 → 创建金库**
- [ ] 复制「本机公钥」
- [ ] 录入 Device A 和 Device C 的 xpub
- [ ] **核对首收款地址**——必须和 Device A 完全一致（否则配置不匹配，无法协签）

**Sparrow Wallet 交叉验证（可选）：**

- [ ] 用 Sparrow Wallet 创建 multisig vault，录入相同 3 个 xpub
- [ ] 比对 Sparrow 派生的收款地址与 app 派生的地址 — 必须一致

## 充值 testnet BTC

- [ ] Device A 进入 vault 详情 → **收款**
- [ ] 复制 vault 收款地址
- [ ] 去以下任一 testnet 水龙头领 0.001 tBTC：
  - https://coinfaucet.eu/en/btc-testnet/
  - https://testnet-faucet.com/btc-testnet/
  - https://kyc-free.coinfaucet.eu/
- [ ] 等 1-2 分钟，blockstream.info/testnet 上能看到这笔交易
- [ ] app 内下拉刷新，确认 vault 余额更新到 0.001 BTC

## 跨设备协签转账

**Device A 发起：**

- [ ] vault 详情 → **发起转账**
- [ ] 收款方地址：Device B 的单签收款地址（或任何 testnet 合法地址）
- [ ] 金额：0.0005 BTC
- [ ] 手续费：标准（或自定义）
- [ ] 点「确认发送」→ app 构造 PSBT + 本机签名 → 显示 PSBT QR
- [ ] 截图或拍照保存 PSBT QR（备用）

**Device B 协签：**

- [ ] vault 详情 → **协签交易**
- [ ] 扫 Device A 的 PSBT QR（或粘贴 base64）
- [ ] app 显示交易摘要：金额、收款方、手续费、签名进度 1/2
- [ ] 点「确认」→ 本机签名 → 显示已签 PSBT QR
- [ ] 进度应该是 2/2「可广播」

**Device A 合并 + 广播：**

- [ ] vault 详情 → **协签交易**
- [ ] 扫 Device B 的 PSBT QR
- [ ] app 自动合并签名、finalize、显示「广播交易」按钮
- [ ] 点「广播交易」→ 等待 mempool 返回 txid
- [ ] 显示「交易已广播」+ txid

## 上链验证

- [ ] 复制 txid，打开 https://mempool.space/testnet/tx/{txid}
- [ ] 确认交易已入 mempool（待确认状态）
- [ ] 等 10-30 分钟（testnet 出块时间不稳定），交易应被打包进 1 个区块
- [ ] app 内下拉刷新，vault 余额应减少 0.0005 BTC + 手续费
- [ ] 收款方地址在 https://mempool.space/testnet/address/{收款方} 应能看到这笔收入

## 回归检查

- [ ] 切回 mainnet → 重新解锁 → 单签钱包余额和历史正常（mainnet 余额恢复）
- [ ] 切回 testnet → vault 配置仍然存在
- [ ] 重启 app → vault 配置和余额仍正常
- [ ] 锁钱包 / 解锁流程不受影响
- [ ] 单签钱包的发送/收款仍可用（testnet 模式下）

## 已知限制

- **PSBT > 1200 字符**会触发降级（不显示 QR，只显示文本+复制按钮）。testnet 上单输入 PSBT 通常 600-900 字符，不会触发；但多输入或 Taproot 多签会
- **testnet 水龙头额度有限**：每个 IP/地址一般每 24 小时只能领 0.001-0.01 tBTC
- **testnet 不稳定**：偶尔会重启，余额可能被清空（这是 testnet 设计上的特性，不是 bug）

## 故障排查

| 现象 | 可能原因 | 处置 |
|---|---|---|
| 两台设备派生的 vault 地址不一致 | xpub 录入顺序或内容不同 | 删除 vault 重做，核对每一段 xpub |
| 协签后还是显示 1/2 | Device B 的 self xpub 没有被 Device A 录入 | Device A 删除 vault，重新录入 B 的 xpub |
| 广播失败 "bad-txns-inputs-missingorspent" | 引用的 UTXO 已被花费 / 不在链上 | 下拉刷新 vault 余额，重新发起 |
| 广播失败 "non-mandatory-script-verify-flag" | 签名脚本不一致（罕见） | 收集两台设备的 PSBT base64，提交 issue |
| 派生出 `bc1` 而非 `tb1` 地址 | Settings 没切到 testnet / app 重启后默认 mainnet | Settings → 高级 → 切到 testnet，重新解锁 |
