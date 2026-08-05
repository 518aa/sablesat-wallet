# BitNest Wallet v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor BitNest from a single-file app into a well-structured multi-screen wallet with send BTC, theme switching, improved reliability, and security enhancements.

**Architecture:** 3-Tab bottom navigation (Wallet/Transactions/Settings) with Home acting as central hub. All state managed via React hooks. Services remain in `src/services/`, UI split into `src/screens/` and `src/components/`. Theme system with dark default + light toggle persisted in AsyncStorage.

**Tech Stack:** Expo 56, React Native 0.85, React Navigation 7, @scure/btc-signer for transactions, expo-local-authentication for biometrics, @react-native-async-storage/async-storage for persistence.

---

## File Structure Map

```
App.tsx                          # Root: theme provider + navigation wrapper
src/
  theme.ts                       # Theme definitions (dark/light palettes)
  i18n.ts                        # Existing — add new keys for send/receive/theme screens
  services/
    wallet.ts                    # Existing — add getPrivateKey() export
    blockchain.ts                # Rewrite — multi-node fallback, local cache
    transaction.ts               # New — UTXO fetch, tx build/sign/broadcast
    alipay.ts                    # Existing — unchanged
  hooks/
    useWallet.ts                 # Wallet state + operations
    useTheme.ts                  # Theme preference + system detection
    useBlockchain.ts             # Blockchain data with caching
  navigation/
    TabNavigator.tsx             # Bottom tab navigation config
  components/
    BalanceCard.tsx              # Balance display with BTC + CNY
    ActionButtons.tsx            # 3 circular action buttons (Send/Receive/Buy)
    TransactionItem.tsx          # Single transaction row
    FeeSelector.tsx              # 3-tier fee picker (Slow/Medium/Fast)
    ThemeToggle.tsx              # Dark/Light mode switch
  screens/
    HomeScreen.tsx               # Wallet overview — balance + actions + recent txs
    TransactionScreen.tsx        # Full transaction history
    SettingsScreen.tsx           # Language, theme, backup, reset
    SendScreen.tsx               # Send BTC flow
    ReceiveScreen.tsx            # Receive BTC with address display + copy
    BuyScreen.tsx                # Alipay buy flow
```

---

## Phase 1: UI Refactor

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install React Navigation and supporting packages**

```bash
cd /c/Users/51847/Documents/btcqianbao
npx expo install @react-navigation/native @react-navigation/bottom-tabs @react-native-async-storage/async-storage expo-local-authentication react-native-screens react-native-safe-area-context
```

- [ ] **Step 2: Verify installation**

```bash
npx expo-doctor
```

Expected: All dependencies resolved.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add navigation, storage, and auth dependencies"
```

---

### Task 2: Create theme system

**Files:**
- Create: `src/theme.ts`
- Create: `src/hooks/useTheme.ts`

- [ ] **Step 1: Create `src/theme.ts` — define dark and light theme palettes**

```ts
export type Theme = {
  bg: string;
  card: string;
  surface: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  incoming: string;
  outgoing: string;
  warning: string;
  border: string;
  input: string;
  inputBorder: string;
  primaryButton: string;
  primaryButtonText: string;
  secondaryButton: string;
  secondaryButtonText: string;
  dangerBorder: string;
  dangerText: string;
  tabBg: string;
  tabActive: string;
  tabActiveText: string;
  tabInactiveText: string;
  sendGradient: [string, string];
  receiveGradient: [string, string];
  buyGradient: [string, string];
};

export const dark: Theme = {
  bg: "#0f0f23",
  card: "#1a1a2e",
  surface: "#16213e",
  text: "#f0f0f0",
  textSecondary: "#888",
  textMuted: "#555",
  accent: "#3b82f6",
  incoming: "#4ade80",
  outgoing: "#ef4444",
  warning: "#f59e0b",
  border: "rgba(255,255,255,0.08)",
  input: "#1e293b",
  inputBorder: "rgba(255,255,255,0.12)",
  primaryButton: "#3b82f6",
  primaryButtonText: "#ffffff",
  secondaryButton: "#1e293b",
  secondaryButtonText: "#94a3b8",
  dangerBorder: "#ef4444",
  dangerText: "#ef4444",
  tabBg: "#0f0f23",
  tabActive: "#3b82f6",
  tabActiveText: "#ffffff",
  tabInactiveText: "#555",
  sendGradient: ["#f59e0b", "#f97316"],
  receiveGradient: ["#3b82f6", "#6366f1"],
  buyGradient: ["#10b981", "#14b8a6"]
};

export const light: Theme = {
  bg: "#F8F4EA",
  card: "#FFFFFF",
  surface: "#F0ECE3",
  text: "#12352F",
  textSecondary: "#647067",
  textMuted: "#9B968B",
  accent: "#176B58",
  incoming: "#176B58",
  outgoing: "#B43C24",
  warning: "#8A6B30",
  border: "#ECE2CF",
  input: "#FFFFFF",
  inputBorder: "#DDD1BC",
  primaryButton: "#176B58",
  primaryButtonText: "#FFFFFF",
  secondaryButton: "#E9F2EC",
  secondaryButtonText: "#176B58",
  dangerBorder: "#D86D54",
  dangerText: "#B43C24",
  tabBg: "#12352F",
  tabActive: "#F4B64A",
  tabActiveText: "#12352F",
  tabInactiveText: "#E7EEE9",
  sendGradient: ["#f59e0b", "#f97316"],
  receiveGradient: ["#3b82f6", "#6366f1"],
  buyGradient: ["#10b981", "#14b8a6"]
};
```

- [ ] **Step 2: Create `src/hooks/useTheme.ts` — load/save preference, detect system**

```ts
import { createContext, useContext } from "react";
import type { Theme } from "../theme";

export type ThemeMode = "dark" | "light";

export type ThemeContextType = {
  theme: Theme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

export const ThemeContext = createContext<ThemeContextType>({
  theme: {} as Theme,
  mode: "dark",
  setMode: () => {},
  toggle: () => {}
});

export function useTheme() {
  return useContext(ThemeContext);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/theme.ts src/hooks/useTheme.ts
git commit -m "feat: add theme system with dark and light palettes"
```

---

### Task 3: Add new i18n keys

**Files:**
- Modify: `src/i18n.ts`

- [ ] **Step 1: Add new translation keys for send screen, fee selector, theme, transaction screen**

Add these keys to both `zh` and `en` objects in `src/i18n.ts`:

**zh additions:**
```ts
send: "发送",
sendTitle: "发送 BTC",
recipientAddress: "收件人地址",
recipientPlaceholder: "输入或粘贴 BTC 地址",
amountBtc: "金额 (BTC)",
amountCnyInput: "金额 (CNY)",
available: "可用",
feeSlow: "慢",
feeMedium: "中",
feeFast: "快",
feeSlowTime: "~数小时",
feeMediumTime: "~30 分钟",
feeFastTime: "~10 分钟",
networkFee: "网络手续费",
total: "合计",
confirmSend: "确认发送",
sending: "发送中...",
sendSuccess: "发送成功",
sendFailed: "发送失败",
invalidAddress: "地址无效",
insufficientFunds: "余额不足",
paste: "粘贴",
max: "最大",
txHistory: "交易记录",
viewAll: "查看全部",
darkMode: "深色模式",
lightMode: "浅色模式",
theme: "主题",
confirmTransaction: "确认交易",
sendingTo: "发送至",
biometricPrompt: "验证身份以发送交易",
biometricFallback: "请输入 PIN 码",
walletTab: "钱包",
historyTab: "交易",
settingsTab: "设置",
scanQr: "扫码",
```

**en additions:**
```ts
send: "Send",
sendTitle: "Send BTC",
recipientAddress: "Recipient address",
recipientPlaceholder: "Enter or paste BTC address",
amountBtc: "Amount (BTC)",
amountCnyInput: "Amount (CNY)",
available: "Available",
feeSlow: "Slow",
feeMedium: "Medium",
feeFast: "Fast",
feeSlowTime: "~several hours",
feeMediumTime: "~30 minutes",
feeFastTime: "~10 minutes",
networkFee: "Network fee",
total: "Total",
confirmSend: "Confirm send",
sending: "Sending...",
sendSuccess: "Transaction sent",
sendFailed: "Send failed",
invalidAddress: "Invalid address",
insufficientFunds: "Insufficient funds",
paste: "Paste",
max: "Max",
txHistory: "Transaction history",
viewAll: "View all",
darkMode: "Dark mode",
lightMode: "Light mode",
theme: "Theme",
confirmTransaction: "Confirm transaction",
sendingTo: "Sending to",
biometricPrompt: "Verify identity to send",
biometricFallback: "Enter PIN",
walletTab: "Wallet",
historyTab: "History",
settingsTab: "Settings",
scanQr: "Scan QR",
```

- [ ] **Step 2: Commit**

```bash
git add src/i18n.ts
git commit -m "feat: add i18n keys for send, theme, and transaction screens"
```

---

### Task 4: Create wallet and blockchain hooks

**Files:**
- Create: `src/hooks/useWallet.ts`
- Create: `src/hooks/useBlockchain.ts`
- Modify: `src/services/wallet.ts` — export `getPrivateKey`
- Modify: `src/services/blockchain.ts` — add fallback nodes + caching

- [ ] **Step 1: Add `getPrivateKey` export to `src/services/wallet.ts`**

Add after the `deleteWallet` function:

```ts
export async function getPrivateKey(): Promise<Uint8Array> {
  const mnemonic = await SecureStore.getItemAsync(MNEMONIC_KEY);
  if (!mnemonic) throw new Error("No wallet");
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(DERIVATION_PATH);
  if (!child.privateKey) throw new Error("Could not derive private key");
  return child.privateKey;
}
```

- [ ] **Step 2: Rewrite `src/services/blockchain.ts` with multi-node fallback and caching**

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

export type ChainState = {
  balanceSats: number;
  txCount: number;
  transactions: Array<{
    txid: string;
    confirmed: boolean;
    valueSats: number;
  }>;
};

const CACHE_KEY = "bitnest.chain.cache";

const NODES = [
  "https://blockstream.info/api",
  "https://mempool.space/api"
];

async function fetchWithFallback(path: string): Promise<Response> {
  for (const node of NODES) {
    try {
      const res = await fetch(`${node}${path}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return res;
    } catch { continue; }
  }
  throw new Error("Network unavailable — all nodes failed");
}

export async function fetchAddressState(address: string): Promise<ChainState> {
  const [addressRes, txRes] = await Promise.all([
    fetchWithFallback(`/address/${address}`),
    fetchWithFallback(`/address/${address}/txs`)
  ]);

  const addressJson = await addressRes.json();
  const txJson = await txRes.json();

  const funded = addressJson.chain_stats.funded_txo_sum + addressJson.mempool_stats.funded_txo_sum;
  const spent = addressJson.chain_stats.spent_txo_sum + addressJson.mempool_stats.spent_txo_sum;

  const state: ChainState = {
    balanceSats: funded - spent,
    txCount: addressJson.chain_stats.tx_count + addressJson.mempool_stats.tx_count,
    transactions: txJson.slice(0, 20).map((tx: { txid: string; status?: { confirmed: boolean }; vout: Array<{ scriptpubkey_address: string; value: number }>; vin: Array<{ prevout?: { scriptpubkey_address: string; value: number } }> }) => {
      const incoming = tx.vout
        .filter((out) => out.scriptpubkey_address === address)
        .reduce((sum: number, out) => sum + out.value, 0);
      const outgoing = tx.vin
        .filter((input) => input.prevout?.scriptpubkey_address === address)
        .reduce((sum: number, input) => sum + (input.prevout?.value ?? 0), 0);
      return {
        txid: tx.txid,
        confirmed: Boolean(tx.status?.confirmed),
        valueSats: incoming - outgoing
      };
    })
  };

  await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(state)).catch(() => {});
  return state;
}

export async function getCachedState(): Promise<ChainState | null> {
  const raw = await AsyncStorage.getItem(CACHE_KEY).catch(() => null);
  if (!raw) return null;
  return JSON.parse(raw) as ChainState;
}

export async function fetchBtcCnyPrice(): Promise<number> {
  const res = await fetch("https://api.coinbase.com/v2/prices/BTC-CNY/spot", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("Could not load price");
  const json = await res.json();
  return Number(json.data.amount);
}

export async function fetchFeeEstimates(): Promise<{ slow: number; medium: number; fast: number }> {
  const res = await fetchWithFallback("/fee-estimates");
  const json = await res.json();
  return {
    slow: Math.max(1, Math.round(json["144"] ?? 2)),
    medium: Math.max(1, Math.round(json["6"] ?? 5)),
    fast: Math.max(1, Math.round(json["2"] ?? 20))
  };
}
```

- [ ] **Step 3: Create `src/hooks/useWallet.ts`**

```ts
import { useEffect, useState } from "react";
import { createWallet, deleteWallet, importWallet, loadWallet, type Wallet } from "../services/wallet";

export function useWallet() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadWallet().then(setWallet).finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    setWallet(await createWallet());
  };

  const handleImport = async (mnemonic: string) => {
    setWallet(await importWallet(mnemonic));
  };

  const handleDelete = async () => {
    await deleteWallet();
    setWallet(null);
  };

  return { wallet, loading, create: handleCreate, import: handleImport, delete: handleDelete };
}
```

- [ ] **Step 4: Create `src/hooks/useBlockchain.ts`**

```ts
import { useCallback, useEffect, useState } from "react";
import { fetchAddressState, fetchBtcCnyPrice, getCachedState, type ChainState } from "../services/blockchain";

export function useBlockchain(address: string | undefined) {
  const [chain, setChain] = useState<ChainState | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) return;
    setBusy(true);
    try {
      const cached = await getCachedState();
      if (cached) setChain(cached);
      const [nextChain, nextPrice] = await Promise.all([
        fetchAddressState(address),
        fetchBtcCnyPrice().catch(() => null)
      ]);
      setChain(nextChain);
      setPrice(nextPrice);
    } catch {
      // keep cached data if available
    } finally {
      setBusy(false);
    }
  }, [address]);

  useEffect(() => {
    if (address) void refresh();
  }, [address, refresh]);

  return { chain, price, busy, refresh };
}
```

- [ ] **Step 5: Commit**

```bash
git add src/services/wallet.ts src/services/blockchain.ts src/hooks/useWallet.ts src/hooks/useBlockchain.ts
git commit -m "feat: add hooks and multi-node blockchain service with caching"
```

---

### Task 5: Create shared UI components

**Files:**
- Create: `src/components/BalanceCard.tsx`
- Create: `src/components/ActionButtons.tsx`
- Create: `src/components/TransactionItem.tsx`
- Create: `src/components/ThemeToggle.tsx`

- [ ] **Step 1: Create `src/components/BalanceCard.tsx`**

```tsx
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";

const satsPerBtc = 100_000_000;

export function BalanceCard({
  balanceSats,
  priceCny,
  busy,
  onRefresh,
  refreshingLabel,
  refreshLabel,
  priceLabel
}: {
  balanceSats: number;
  priceCny: number | null;
  busy: boolean;
  onRefresh: () => void;
  refreshingLabel: string;
  refreshLabel: string;
  priceLabel: string;
}) {
  const { theme } = useTheme();
  const btc = (balanceSats / satsPerBtc).toFixed(8);
  const cny = priceCny ? (balanceSats / satsPerBtc * priceCny).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : null;

  return (
    <View style={[styles.card, { backgroundColor: theme.card }]}>
      <Text style={[styles.kicker, { color: theme.textSecondary }]}>BALANCE</Text>
      <Text style={[styles.balance, { color: theme.text }]}>{btc} BTC</Text>
      {cny && <Text style={[styles.cny, { color: theme.incoming }]}>≈ ¥{cny}</Text>}
      <Text style={[styles.price, { color: theme.textSecondary }]}>
        {priceCny ? `${priceLabel}: ¥${priceCny.toLocaleString("zh-CN")}` : priceLabel}
      </Text>
      <Pressable disabled={busy} onPress={onRefresh} style={[styles.refreshBtn, { backgroundColor: theme.accent }]}>
        <Text style={[styles.refreshText, { color: theme.primaryButtonText }]}>{busy ? refreshingLabel : refreshLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 20, borderRadius: 16, gap: 6 },
  kicker: { fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  balance: { fontSize: 32, fontWeight: "900", letterSpacing: -1 },
  cny: { fontSize: 15, fontWeight: "700" },
  price: { fontSize: 13, marginTop: 2 },
  refreshBtn: { marginTop: 8, alignSelf: "flex-start", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  refreshText: { fontSize: 13, fontWeight: "800" }
});
```

- [ ] **Step 2: Create `src/components/ActionButtons.tsx`**

```tsx
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";

export function ActionButtons({
  onSend,
  onReceive,
  onBuy,
  sendLabel,
  receiveLabel,
  buyLabel
}: {
  onSend: () => void;
  onReceive: () => void;
  onBuy: () => void;
  sendLabel: string;
  receiveLabel: string;
  buyLabel: string;
}) {
  const { theme } = useTheme();

  return (
    <View style={styles.row}>
      <ActionButton label={sendLabel} gradient={theme.sendGradient} onPress={onSend} icon="↑" />
      <ActionButton label={receiveLabel} gradient={theme.receiveGradient} onPress={onReceive} icon="↓" />
      <ActionButton label={buyLabel} gradient={theme.buyGradient} onPress={onBuy} icon="¥" />
    </View>
  );
}

function ActionButton({ label, gradient, onPress, icon }: { label: string; gradient: [string, string]; onPress: () => void; icon: string }) {
  return (
    <Pressable onPress={onPress} style={styles.action}>
      <View style={[styles.circle, { background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})` }]}>
        <Text style={styles.icon}>{icon}</Text>
      </View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "center", gap: 20, paddingVertical: 8 },
  action: { alignItems: "center", width: 72 },
  circle: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", marginBottom: 6, backgroundColor: "#3b82f6" },
  icon: { color: "#fff", fontSize: 22, fontWeight: "800" },
  label: { fontSize: 12, color: "#999" }
});
```

- [ ] **Step 3: Create `src/components/TransactionItem.tsx`**

```tsx
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";

const satsPerBtc = 100_000_000;

export function TransactionItem({
  txid,
  confirmed,
  valueSats,
  priceCny
}: {
  txid: string;
  confirmed: boolean;
  valueSats: number;
  priceCny: number | null;
}) {
  const { theme } = useTheme();
  const isPositive = valueSats >= 0;
  const btc = (Math.abs(valueSats) / satsPerBtc).toFixed(8);
  const shortId = `${txid.slice(0, 8)}...${txid.slice(-8)}`;
  const cny = priceCny ? `≈ ¥${(Math.abs(valueSats) / satsPerBtc * priceCny).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}` : null;

  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <View style={[styles.icon, { backgroundColor: isPositive ? `${theme.incoming}22` : `${theme.outgoing}22` }]}>
        <Text style={{ color: isPositive ? theme.incoming : theme.outgoing, fontSize: 16 }}>{isPositive ? "↓" : "↑"}</Text>
      </View>
      <View style={styles.info}>
        <Text style={[styles.hash, { color: theme.text }]}>{shortId}</Text>
        <Text style={[styles.status, { color: theme.textMuted }]}>{confirmed ? "Confirmed" : "Pending"}</Text>
      </View>
      <View style={styles.amounts}>
        <Text style={{ color: isPositive ? theme.incoming : theme.outgoing, fontWeight: "700", fontSize: 13 }}>
          {isPositive ? "+" : "-"}{btc}
        </Text>
        {cny && <Text style={[styles.cny, { color: theme.textMuted }]}>{cny}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  info: { flex: 1, marginLeft: 10 },
  hash: { fontWeight: "700", fontSize: 13 },
  status: { fontSize: 11, marginTop: 2 },
  amounts: { alignItems: "flex-end" },
  cny: { fontSize: 11, marginTop: 2 }
});
```

- [ ] **Step 4: Create `src/components/ThemeToggle.tsx`**

```tsx
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme, type ThemeMode } from "../hooks/useTheme";

export function ThemeToggle({ darkLabel, lightLabel }: { darkLabel: string; lightLabel: string }) {
  const { mode, setMode, theme } = useTheme();

  return (
    <View style={[styles.switch, { backgroundColor: theme.surface }]}>
      {(["dark", "light"] as ThemeMode[]).map((item) => (
        <Pressable
          key={item}
          onPress={() => setMode(item)}
          style={[styles.btn, mode === item && { backgroundColor: theme.card }]}
        >
          <Text style={[styles.text, { color: mode === item ? theme.text : theme.textMuted }]}>
            {item === "dark" ? darkLabel : lightLabel}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  switch: { flexDirection: "row", padding: 4, borderRadius: 8, alignSelf: "flex-start" },
  btn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  text: { fontWeight: "800", fontSize: 13 }
});
```

- [ ] **Step 5: Commit**

```bash
git add src/components/
git commit -m "feat: add BalanceCard, ActionButtons, TransactionItem, ThemeToggle"
```

---

### Task 6: Create screens

**Files:**
- Create: `src/screens/HomeScreen.tsx`
- Create: `src/screens/TransactionScreen.tsx`
- Create: `src/screens/SettingsScreen.tsx`
- Create: `src/screens/ReceiveScreen.tsx`
- Create: `src/screens/BuyScreen.tsx`

- [ ] **Step 1: Create `src/screens/HomeScreen.tsx`**

```tsx
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { useBlockchain } from "../hooks/useBlockchain";
import { type Wallet } from "../services/wallet";
import { type Language, type ReturnTypeT } from "../i18n";
import { BalanceCard } from "../components/BalanceCard";
import { ActionButtons } from "../components/ActionButtons";
import { TransactionItem } from "../components/TransactionItem";

export function HomeScreen({
  wallet,
  language,
  text,
  onSend,
  onReceive,
  onBuy
}: {
  wallet: Wallet;
  language: Language;
  text: ReturnTypeT;
  onSend: () => void;
  onReceive: () => void;
  onBuy: () => void;
}) {
  const { theme } = useTheme();
  const { chain, price, busy, refresh } = useBlockchain(wallet.address);
  const steps = [text.step1, text.step2, text.step3];

  return (
    <ScrollView contentContainerStyle={[styles.content, { backgroundColor: theme.bg }]}>
      <BalanceCard
        balanceSats={chain?.balanceSats ?? 0}
        priceCny={price}
        busy={busy}
        onRefresh={refresh}
        refreshingLabel={text.loading}
        refreshLabel={text.refresh}
        priceLabel={text.price}
      />

      <ActionButtons
        onSend={onSend}
        onReceive={onReceive}
        onBuy={onBuy}
        sendLabel={text.send}
        receiveLabel={text.receive}
        buyLabel={text.buy}
      />

      <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.beginnerSteps}</Text>
        {steps.map((step, i) => (
          <View key={step} style={styles.step}>
            <View style={[styles.stepNum, { backgroundColor: theme.secondaryButton }]}>
              <Text style={{ color: theme.accent, fontWeight: "900", textAlign: "center", lineHeight: 28 }}>{i + 1}</Text>
            </View>
            <Text style={[styles.stepText, { color: theme.text }]}>{step}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.txs}</Text>
        </View>
        {!chain?.transactions.length && <Text style={{ color: theme.textMuted }}>{text.noTxs}</Text>}
        {(chain?.transactions ?? []).slice(0, 5).map((tx) => (
          <TransactionItem key={tx.txid} txid={tx.txid} confirmed={tx.confirmed} valueSats={tx.valueSats} priceCny={price} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 80 },
  section: { padding: 16, borderRadius: 12, gap: 10, borderWidth: 1 },
  sectionTitle: { fontSize: 16, fontWeight: "800" },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  step: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepNum: { width: 28, height: 28, borderRadius: 14, overflow: "hidden" },
  stepText: { fontSize: 14, fontWeight: "600" }
});
```

- [ ] **Step 2: Create `src/screens/TransactionScreen.tsx`**

```tsx
import React from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { useBlockchain } from "../hooks/useBlockchain";
import { type Wallet } from "../services/wallet";
import { TransactionItem } from "../components/TransactionItem";

export function TransactionScreen({ wallet }: { wallet: Wallet }) {
  const { theme } = useTheme();
  const { chain, price, busy, refresh } = useBlockchain(wallet.address);

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { backgroundColor: theme.bg }]}
      refreshing={busy}
      onRefresh={refresh}
    >
      <Text style={[styles.title, { color: theme.text }]}>{chain?.transactions.length ?? 0} transactions</Text>
      {busy && !chain && <ActivityIndicator color={theme.accent} />}
      {!chain?.transactions.length && !busy && <Text style={{ color: theme.textMuted }}>No transactions yet</Text>}
      {(chain?.transactions ?? []).map((tx) => (
        <TransactionItem key={tx.txid} txid={tx.txid} confirmed={tx.confirmed} valueSats={tx.valueSats} priceCny={price} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 4, paddingBottom: 80 },
  title: { fontSize: 18, fontWeight: "900", marginBottom: 8 }
});
```

- [ ] **Step 3: Create `src/screens/ReceiveScreen.tsx`**

```tsx
import * as Clipboard from "expo-clipboard";
import React from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";

export function ReceiveScreen({ address, copiedLabel, copyLabel, titleLabel }: {
  address: string;
  copiedLabel: string;
  copyLabel: string;
  titleLabel: string;
}) {
  const { theme } = useTheme();

  async function handleCopy() {
    await Clipboard.setStringAsync(address);
    Alert.alert("BitNest", copiedLabel);
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>{titleLabel}</Text>
        <View style={[styles.addressBox, { backgroundColor: theme.surface }]}>
          <Text selectable style={[styles.address, { color: theme.text }]}>{address}</Text>
        </View>
        <Pressable onPress={handleCopy} style={[styles.btn, { backgroundColor: theme.primaryButton }]}>
          <Text style={[styles.btnText, { color: theme.primaryButtonText }]}>{copyLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  card: { padding: 16, borderRadius: 12, gap: 14, borderWidth: 1 },
  title: { fontSize: 18, fontWeight: "900" },
  addressBox: { padding: 14, borderRadius: 8 },
  address: { fontSize: 15, lineHeight: 22 },
  btn: { minHeight: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 16, fontWeight: "800" }
});
```

- [ ] **Step 4: Create `src/screens/BuyScreen.tsx`**

```tsx
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { createAlipayOrder, type AlipayOrder } from "../services/alipay";

export function BuyScreen({ btcAddress, price, text }: {
  btcAddress: string;
  price: number | null;
  text: { [key: string]: string };
}) {
  const { theme } = useTheme();
  const [amount, setAmount] = useState("100");
  const [order, setOrder] = useState<AlipayOrder | null>(null);
  const [busy, setBusy] = useState(false);

  const estimatedBtc = useMemo(() => {
    const value = Number(amount);
    if (!price || !Number.isFinite(value)) return "0.00000000";
    return (value / price).toFixed(8);
  }, [amount, price]);

  async function handleBuy() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;
    setBusy(true);
    try {
      const nextOrder = await createAlipayOrder(value, btcAddress);
      setOrder(nextOrder);
      Alert.alert("BitNest", nextOrder.status === "demo" ? text.paymentMissing : text.paymentReady);
    } catch (error) {
      Alert.alert("BitNest", String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>{text.buyWithAlipay}</Text>
        <Text style={{ color: theme.textSecondary, lineHeight: 20 }}>{text.buyHint}</Text>
        <Text style={[styles.label, { color: theme.text }]}>{text.amountCny}</Text>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
          placeholder="100"
          placeholderTextColor={theme.textMuted}
        />
        <View style={styles.quoteRow}>
          <Text style={{ color: theme.textSecondary }}>{text.expectedBtc}</Text>
          <Text style={{ color: theme.accent, fontWeight: "900" }}>{estimatedBtc} BTC</Text>
        </View>
        <Text style={{ color: theme.warning, lineHeight: 20, fontSize: 12 }}>{text.feeNote}</Text>
        <Pressable disabled={busy} onPress={handleBuy} style={[styles.btn, { backgroundColor: theme.primaryButton }]}>
          {busy ? <ActivityIndicator color={theme.primaryButtonText} /> : <Text style={[styles.btnText, { color: theme.primaryButtonText }]}>{text.createOrder}</Text>}
        </Pressable>
        {order && (
          <View style={[styles.orderBox, { backgroundColor: theme.surface }]}>
            <Text style={{ color: theme.text, fontWeight: "900" }}>{order.status === "demo" ? text.demoPaid : text.paymentReady}</Text>
            <Text style={{ color: theme.textMuted }}>#{order.id}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  card: { padding: 16, borderRadius: 12, gap: 12, borderWidth: 1 },
  title: { fontSize: 18, fontWeight: "900" },
  label: { fontWeight: "800" },
  input: { minHeight: 54, borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, fontSize: 22, fontWeight: "900" },
  quoteRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  btn: { minHeight: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 16, fontWeight: "800" },
  orderBox: { padding: 14, borderRadius: 8, gap: 4 }
});
```

- [ ] **Step 5: Create `src/screens/SettingsScreen.tsx`**

```tsx
import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { type Language } from "../i18n";
import { ThemeToggle } from "../components/ThemeToggle";

export function SettingsScreen({
  mnemonic,
  language,
  text,
  onLanguageChange,
  onReset
}: {
  mnemonic: string;
  language: Language;
  text: { [key: string]: string };
  onLanguageChange: (lang: Language) => void;
  onReset: () => void;
}) {
  const { theme } = useTheme();
  const [showMnemonic, setShowMnemonic] = useState(false);

  function handleReset() {
    Alert.alert(text.reset, "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      { text: text.reset, style: "destructive", onPress: onReset }
    ]);
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { backgroundColor: theme.bg }]}>
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>{text.backup}</Text>
        <Text style={{ color: theme.outgoing, lineHeight: 20 }}>{text.backupWarning}</Text>
        {showMnemonic && (
          <View style={styles.mnemonicGrid}>
            {mnemonic.split(" ").map((word, i) => (
              <View key={`${word}-${i}`} style={[styles.wordCell, { backgroundColor: theme.surface }]}>
                <Text style={{ color: theme.textMuted, fontSize: 11, fontWeight: "800" }}>{i + 1}</Text>
                <Text style={{ color: theme.text, fontWeight: "800" }}>{word}</Text>
              </View>
            ))}
          </View>
        )}
        <Pressable
          onPress={() => setShowMnemonic((v) => !v)}
          style={[styles.btn, { backgroundColor: theme.secondaryButton }]}
        >
          <Text style={{ color: theme.secondaryButtonText, fontWeight: "800" }}>{showMnemonic ? text.hide : text.reveal}</Text>
        </Pressable>
      </View>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>{text.theme}</Text>
        <ThemeToggle darkLabel={text.darkMode} lightLabel={text.lightMode} />
      </View>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>{text.language}</Text>
        <View style={[styles.langSwitch, { backgroundColor: theme.surface }]}>
          {(["zh", "en"] as Language[]).map((item) => (
            <Pressable
              key={item}
              onPress={() => onLanguageChange(item)}
              style={[styles.langBtn, language === item && { backgroundColor: theme.card }]}
            >
              <Text style={{ color: language === item ? theme.text : theme.textMuted, fontWeight: "800" }}>
                {item === "zh" ? "中文" : "EN"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={{ color: theme.text, fontWeight: "900" }}>{text.riskTitle}</Text>
        <Text style={{ color: theme.textSecondary, lineHeight: 20 }}>{text.riskText}</Text>
      </View>

      <Pressable onPress={handleReset} style={[styles.dangerBtn, { borderColor: theme.dangerBorder }]}>
        <Text style={{ color: theme.dangerText, fontWeight: "900" }}>{text.reset}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 80 },
  card: { padding: 16, borderRadius: 12, gap: 10, borderWidth: 1 },
  title: { fontSize: 18, fontWeight: "900" },
  mnemonicGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  wordCell: { width: "31%", minHeight: 44, borderRadius: 8, padding: 8 },
  btn: { minHeight: 46, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  langSwitch: { flexDirection: "row", padding: 4, borderRadius: 8, alignSelf: "flex-start" },
  langBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  dangerBtn: { minHeight: 50, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" }
});
```

- [ ] **Step 6: Commit**

```bash
git add src/screens/
git commit -m "feat: add Home, Transaction, Settings, Receive, Buy screens"
```

---

### Task 7: Create TabNavigator and rewrite App.tsx

**Files:**
- Create: `src/navigation/TabNavigator.tsx`
- Rewrite: `App.tsx`

- [ ] **Step 1: Create `src/navigation/TabNavigator.tsx`**

```tsx
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { HomeScreen } from "../screens/HomeScreen";
import { TransactionScreen } from "../screens/TransactionScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { ReceiveScreen } from "../screens/ReceiveScreen";
import { BuyScreen } from "../screens/BuyScreen";
import { type Language } from "../i18n";

export type Screen = "wallet" | "history" | "settings" | "send" | "receive" | "buy";

export function TabNavigator({
  walletMnemonic,
  walletAddress,
  language,
  text,
  onLanguageChange,
  onReset
}: {
  walletMnemonic: string;
  walletAddress: string;
  language: Language;
  text: { [key: string]: string };
  onLanguageChange: (lang: Language) => void;
  onReset: () => void;
}) {
  const { theme } = useTheme();
  const [screen, setScreen] = React.useState<Screen>("wallet");
  const [tab, setTab] = React.useState<"wallet" | "history" | "settings">("wallet");

  function navigate(s: Screen) {
    setScreen(s);
    if (s === "wallet" || s === "history" || s === "settings") setTab(s);
  }

  const wallet = { mnemonic: walletMnemonic, address: walletAddress, publicKeyHex: "", path: "" };

  if (screen === "receive") return <ReceiveScreen address={walletAddress} copiedLabel={text.copied} copyLabel={text.copy} titleLabel={text.address} onBack={() => navigate("wallet")} />;
  if (screen === "buy") return <BuyScreen btcAddress={walletAddress} price={null} text={text} onBack={() => navigate("wallet")} />;
  if (screen === "send") return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><Text>Send screen (Phase 2)</Text></View>;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {tab === "wallet" && <HomeScreen wallet={wallet} language={language} text={text} onSend={() => navigate("send")} onReceive={() => navigate("receive")} onBuy={() => navigate("buy")} />}
      {tab === "history" && <TransactionScreen wallet={wallet} />}
      {tab === "settings" && <SettingsScreen mnemonic={walletMnemonic} language={language} text={text} onLanguageChange={onLanguageChange} onReset={onReset} />}

      <View style={[styles.tabBar, { backgroundColor: theme.tabBg }]}>
        {(["wallet", "history", "settings"] as const).map((item) => (
          <Pressable key={item} onPress={() => navigate(item)} style={[styles.tabItem, tab === item && { backgroundColor: theme.tabActive }]}>
            <Text style={{ color: tab === item ? theme.tabActiveText : theme.tabInactiveText, fontWeight: "800", fontSize: 12 }}>
              {text[`${item}Tab` as keyof typeof text]}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabBar: { position: "absolute", left: 16, right: 16, bottom: 20, flexDirection: "row", borderRadius: 12, padding: 6, gap: 6 },
  tabItem: { flex: 1, minHeight: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" }
});
```

- [ ] **Step 2: Rewrite `App.tsx` as root provider**

```tsx
import React, { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { dark, light, type Theme } from "./src/theme";
import { ThemeContext, type ThemeMode } from "./src/hooks/useTheme";
import { useWallet } from "./src/hooks/useWallet";
import { TabNavigator } from "./src/navigation/TabNavigator";
import { type Language, t } from "./src/i18n";
import { InfoPill } from "./src/components/InfoPill";

const THEME_KEY = "bitnest.theme";

export default function App() {
  const { wallet, loading, create, import: importW, delete: deleteW } = useWallet();
  const [language, setLanguage] = useState<Language>("zh");
  const [mode, setMode] = useState<ThemeMode>("dark");
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const text = t(language);
  const theme: Theme = mode === "dark" ? dark : light;

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY).then((stored) => {
      if (stored === "light" || stored === "dark") setMode(stored);
    });
  }, []);

  function handleSetMode(m: ThemeMode) {
    setMode(m);
    AsyncStorage.setItem(THEME_KEY, m).catch(() => {});
  }

  async function handleCreate() {
    setBusy(true);
    try { await create(); } finally { setBusy(false); }
  }

  async function handleImport() {
    setBusy(true);
    try { await importW(importText); setImportText(""); }
    catch { alert(text.invalidMnemonic); }
    finally { setBusy(false); }
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.loading, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.accent} />
        <Text style={{ color: theme.textSecondary }}>{text.loading}</Text>
      </SafeAreaView>
    );
  }

  if (!wallet) {
    return (
      <ThemeContext.Provider value={{ theme, mode, setMode: handleSetMode, toggle: () => handleSetMode(mode === "dark" ? "light" : "dark") }}>
        <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
          <StatusBar style={mode === "dark" ? "light" : "dark"} />
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
            <ScrollView contentContainerStyle={styles.onboarding}>
              <View style={[styles.brandMark, { backgroundColor: "#F4B64A" }]}>
                <Text style={styles.brandGlyph}>B</Text>
              </View>
              <View>
                <Text style={[styles.title, { color: theme.text }]}>{text.appName}</Text>
                <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{text.tagline}</Text>
              </View>
              <View style={{ gap: 12 }}>
                <InfoPill title={text.beginner} body={text.beginnerText} theme={theme} />
                <InfoPill title={text.nonCustodial} body={text.nonCustodialText} theme={theme} />
              </View>
              <Pressable disabled={busy} onPress={handleCreate} style={[styles.primaryButton, { backgroundColor: theme.primaryButton }]}>
                <Text style={[styles.primaryButtonText, { color: theme.primaryButtonText }]}>{busy ? text.loading : text.start}</Text>
              </Pressable>
              <View style={[styles.importPanel, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={{ color: theme.text, fontSize: 20, fontWeight: "900" }}>{text.importTitle}</Text>
                <TextInput multiline value={importText} onChangeText={setImportText} placeholder={text.importPlaceholder} placeholderTextColor={theme.textMuted} style={[styles.seedInput, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]} autoCapitalize="none" autoCorrect={false} />
                <Pressable disabled={busy || !importText.trim()} onPress={handleImport} style={[styles.secondaryButton, { backgroundColor: theme.secondaryButton }]}>
                  <Text style={{ color: theme.secondaryButtonText, fontWeight: "800" }}>{text.importAction}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode: handleSetMode, toggle: () => handleSetMode(mode === "dark" ? "light" : "dark") }}>
      <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
        <StatusBar style={mode === "dark" ? "light" : "dark"} />
        <TabNavigator
          walletMnemonic={wallet.mnemonic}
          walletAddress={wallet.address}
          language={language}
          text={text as { [key: string]: string }}
          onLanguageChange={setLanguage}
          onReset={deleteW}
        />
      </SafeAreaView>
    </ThemeContext.Provider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  onboarding: { padding: 24, gap: 22 },
  brandMark: { width: 76, height: 76, borderRadius: 24, alignItems: "center", justifyContent: "center", shadowColor: "#553300", shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
  brandGlyph: { color: "#12352F", fontSize: 42, fontWeight: "900" },
  title: { fontSize: 38, fontWeight: "900" },
  subtitle: { marginTop: 8, fontSize: 17, lineHeight: 24 },
  primaryButton: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  primaryButtonText: { fontSize: 16, fontWeight: "800" },
  importPanel: { padding: 16, gap: 12, borderRadius: 8, borderWidth: 1 },
  seedInput: { minHeight: 104, borderRadius: 8, borderWidth: 1, padding: 14, textAlignVertical: "top", fontSize: 15, lineHeight: 21 },
  secondaryButton: { minHeight: 50, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 }
});
```

- [ ] **Step 3: Create `src/components/InfoPill.tsx` (extracted from old App.tsx)**

```tsx
import { StyleSheet, Text, View } from "react-native";
import type { Theme } from "../theme";

export function InfoPill({ title, body, theme }: { title: string; body: string; theme: Theme }) {
  return (
    <View style={[styles.pill, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={{ color: theme.text, fontWeight: "800", fontSize: 17 }}>{title}</Text>
      <Text style={{ color: theme.textSecondary, marginTop: 6, fontSize: 14, lineHeight: 20 }}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { borderRadius: 8, padding: 16, borderWidth: 1 }
});
```

- [ ] **Step 4: Commit**

```bash
git add App.tsx src/navigation/ src/components/InfoPill.tsx
git commit -m "feat: rewrite App.tsx with theme provider and tab navigation"
```

---

### Task 8: Fix type issues and verify build

**Files:**
- Various fixes as needed

- [ ] **Step 1: Fix i18n.ts type export**

Add a type export for the return type of `t()` so screens can use it:

In `src/i18n.ts`, at the end of the file, add:

```ts
export type ReturnTypeT = typeof copy.zh;
```

- [ ] **Step 2: Run typecheck**

```bash
cd /c/Users/51847/Documents/btcqianbao
npx tsc --noEmit 2>&1
```

Expected: 0 errors. Fix any type errors found.

- [ ] **Step 3: Start Expo and verify on device**

```bash
export ANDROID_HOME="/c/Users/51847/AppData/Local/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
npx expo run:android
```

Expected: App loads, onboarding shows, can create wallet, 3-tab navigation works, dark theme renders correctly.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: resolve type issues and verify build"
```

---

## Phase 2: Send BTC

### Task 9: Create transaction service

**Files:**
- Create: `src/services/transaction.ts`

- [ ] **Step 1: Create `src/services/transaction.ts`**

```ts
import * as btc from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { getPrivateKey } from "./wallet";

const NODES = [
  "https://blockstream.info/api",
  "https://mempool.space/api"
];

async function fetchWithFallback(path: string): Promise<Response> {
  for (const node of NODES) {
    try {
      const res = await fetch(`${node}${path}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return res;
    } catch { continue; }
  }
  throw new Error("Network unavailable");
}

type UTXO = {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
};

export async function fetchUTXOs(address: string): Promise<UTXO[]> {
  const res = await fetchWithFallback(`/address/${address}/utxo`);
  const utxos = await res.json();
  const enriched: UTXO[] = [];
  for (const utxo of utxos) {
    if (!utxo.confirmed) continue;
    const txRes = await fetchWithFallback(`/tx/${utxo.txid}`);
    const tx = await txRes.json();
    const vout = tx.vout[utxo.vout];
    enriched.push({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      scriptPubKey: vout.scriptpubkey
    });
  }
  return enriched;
}

export async function buildAndSendTx(
  recipientAddress: string,
  amountSats: number,
  feeRate: number,
  changeAddress: string
): Promise<string> {
  const privateKey = await getPrivateKey();
  const publicKey = btc.secp256k1.getPublicKey(privateKey, true);
  const payment = btc.p2wpkh(publicKey, btc.NETWORK);

  const utxos = await fetchUTXOs(changeAddress);
  const inputs: btc.TransactionInput[] = [];
  let inputSum = 0;

  for (const utxo of utxos) {
    inputs.push({
      txid: hexToBytes(utxo.txid),
      index: utxo.vout,
      witnessUtxo: {
        script: hexToBytes(utxo.scriptPubKey),
        amount: BigInt(utxo.value)
      }
    });
    inputSum += utxo.value;
    const estimatedSize = inputs.length * 68 + 2 * 31 + 10;
    const fee = Math.ceil(estimatedSize * feeRate);
    if (inputSum >= amountSats + fee) break;
  }

  if (inputSum === 0) throw new Error("No confirmed UTXOs available");

  const estimatedSize = inputs.length * 68 + 2 * 31 + 10;
  const fee = Math.ceil(estimatedSize * feeRate);

  if (inputSum < amountSats + fee) throw new Error("Insufficient funds for amount + fee");

  const tx = new btc.Transaction();

  for (const input of inputs) {
    tx.addInput(input);
  }

  tx.addOutputAddress(recipientAddress, BigInt(amountSats), btc.NETWORK);

  const changeAmount = inputSum - amountSats - fee;
  if (changeAmount > 546) {
    tx.addOutputAddress(changeAddress, BigInt(changeAmount), btc.NETWORK);
  }

  for (let i = 0; i < inputs.length; i++) {
    tx.signIdx(privateKey, i);
  }

  tx.finalize();
  const rawTx = hexToBytes(tx.hex);

  const broadcastRes = await fetchWithFallback("/tx", {
    method: "POST",
    body: rawTx,
    headers: { "Content-Type": "application/octet-stream" }
  });

  if (!broadcastRes.ok) {
    const errText = await broadcastRes.text();
    throw new Error(errText || "Broadcast failed");
  }

  return await broadcastRes.text();
}
```

Note: `fetchWithFallback` needs to support POST options. Adjust the function signature:

```ts
async function fetchWithFallback(path: string, init?: RequestInit): Promise<Response> {
  for (const node of NODES) {
    try {
      const res = await fetch(`${node}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
      if (res.ok || init?.method === "POST") return res;
    } catch { continue; }
  }
  throw new Error("Network unavailable");
}
```

- [ ] **Step 2: Install @noble/hashes if not already available**

```bash
cd /c/Users/51847/Documents/btcqianbao
npm ls @noble/hashes 2>&1 || npm install @noble/hashes
```

- [ ] **Step 3: Commit**

```bash
git add src/services/transaction.ts package.json package-lock.json
git commit -m "feat: add transaction build/sign/broadcast service"
```

---

### Task 10: Create SendScreen

**Files:**
- Create: `src/components/FeeSelector.tsx`
- Create: `src/screens/SendScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx` — wire up SendScreen

- [ ] **Step 1: Create `src/components/FeeSelector.tsx`**

```tsx
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";

export type FeeTier = "slow" | "medium" | "fast";

export function FeeSelector({
  tiers,
  selected,
  onSelect,
  labels
}: {
  tiers: { slow: number; medium: number; fast: number };
  selected: FeeTier;
  onSelect: (tier: FeeTier) => void;
  labels: { slow: string; medium: string; fast: string; slowTime: string; mediumTime: string; fastTime: string };
}) {
  const { theme } = useTheme();
  const options: Array<{ key: FeeTier; label: string; time: string; rate: number }> = [
    { key: "slow", label: labels.slow, time: labels.slowTime, rate: tiers.slow },
    { key: "medium", label: labels.medium, time: labels.mediumTime, rate: tiers.medium },
    { key: "fast", label: labels.fast, time: labels.fastTime, rate: tiers.fast }
  ];

  return (
    <View style={styles.row}>
      {options.map((opt) => (
        <Pressable
          key={opt.key}
          onPress={() => onSelect(opt.key)}
          style={[styles.tier, { backgroundColor: theme.card, borderColor: selected === opt.key ? theme.accent : theme.border }, selected === opt.key && styles.selected]}
        >
          <Text style={{ color: selected === opt.key ? theme.accent : theme.text, fontWeight: "800" }}>{opt.label}</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>{opt.time}</Text>
          <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{opt.rate} sat/vB</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  tier: { flex: 1, padding: 12, borderRadius: 10, borderWidth: 1.5, alignItems: "center" },
  selected: { borderWidth: 2 }
});
```

- [ ] **Step 2: Create `src/screens/SendScreen.tsx`**

```tsx
import * as Clipboard from "expo-clipboard";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { useBlockchain } from "../hooks/useBlockchain";
import { fetchFeeEstimates } from "../services/blockchain";
import { buildAndSendTx } from "../services/transaction";
import { FeeSelector, type FeeTier } from "../components/FeeSelector";

const satsPerBtc = 100_000_000;

export function SendScreen({ address, text, onBack }: {
  address: string;
  text: { [key: string]: string };
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const { chain, price } = useBlockchain(address);
  const [recipient, setRecipient] = useState("");
  const [amountBtc, setAmountBtc] = useState("");
  const [feeTier, setFeeTier] = useState<FeeTier>("medium");
  const [fees, setFees] = useState({ slow: 2, medium: 5, fast: 20 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchFeeEstimates().then(setFees).catch(() => {});
  }, []);

  const amountSats = useMemo(() => {
    const val = Number(amountBtc);
    if (!Number.isFinite(val)) return 0;
    return Math.round(val * satsPerBtc);
  }, [amountBtc]);

  const feeEstimate = useMemo(() => {
    return Math.ceil(140 * fees[feeTier]);
  }, [fees, feeTier]);

  const availableSats = chain?.balanceSats ?? 0;

  async function handlePaste() {
    const text = await Clipboard.getStringAsync();
    setRecipient(text);
  }

  async function handleSend() {
    if (!recipient.trim()) return Alert.alert("BitNest", text.invalidAddress);
    if (amountSats <= 0 || amountSats + feeEstimate > availableSats) return Alert.alert("BitNest", text.insufficientFunds);

    setBusy(true);
    try {
      await buildAndSendTx(recipient.trim(), amountSats, fees[feeTier], address);
      Alert.alert("BitNest", text.sendSuccess, [{ text: "OK", onPress: onBack }]);
    } catch (error) {
      Alert.alert("BitNest", `${text.sendFailed}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack}><Text style={{ color: theme.accent, fontWeight: "800" }}>← {text.walletTab}</Text></Pressable>
      </View>

      <Text style={[styles.title, { color: theme.text }]}>{text.sendTitle}</Text>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.text }]}>{text.recipientAddress}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            value={recipient}
            onChangeText={setRecipient}
            placeholder={text.recipientPlaceholder}
            placeholderTextColor={theme.textMuted}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text, flex: 1 }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable onPress={handlePaste} style={[styles.pasteBtn, { backgroundColor: theme.secondaryButton }]}>
            <Text style={{ color: theme.secondaryButtonText, fontWeight: "800", fontSize: 12 }}>{text.paste}</Text>
          </Pressable>
        </View>

        <Text style={[styles.label, { color: theme.text }]}>{text.amountBtc}</Text>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput
            value={amountBtc}
            onChangeText={setAmountBtc}
            keyboardType="decimal-pad"
            placeholder="0.001"
            placeholderTextColor={theme.textMuted}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text, flex: 1 }]}
          />
          <Pressable onPress={() => setAmountBtc(String((availableSats - feeEstimate) / satsPerBtc))} style={[styles.pasteBtn, { backgroundColor: theme.secondaryButton }]}>
            <Text style={{ color: theme.secondaryButtonText, fontWeight: "800", fontSize: 12 }}>{text.max}</Text>
          </Pressable>
        </View>
        <Text style={{ color: theme.textSecondary, fontSize: 12 }}>{text.available}: {(availableSats / satsPerBtc).toFixed(8)} BTC</Text>

        <Text style={[styles.label, { color: theme.text }]}>{text.networkFee}</Text>
        <FeeSelector
          tiers={fees}
          selected={feeTier}
          onSelect={setFeeTier}
          labels={{ slow: text.feeSlow, medium: text.feeMedium, fast: text.feeFast, slowTime: text.feeSlowTime, mediumTime: text.feeMediumTime, fastTime: text.feeFastTime }}
        />

        <View style={[styles.totalRow, { borderTopColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary }}>{text.total}</Text>
          <Text style={{ color: theme.text, fontWeight: "800" }}>{((amountSats + feeEstimate) / satsPerBtc).toFixed(8)} BTC</Text>
        </View>
      </View>

      <Pressable disabled={busy} onPress={handleSend} style={[styles.sendBtn, { backgroundColor: theme.primaryButton }]}>
        {busy ? <ActivityIndicator color={theme.primaryButtonText} /> : <Text style={{ color: theme.primaryButtonText, fontWeight: "800", fontSize: 16 }}>{text.confirmSend}</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 80 },
  header: { marginBottom: 4 },
  title: { fontSize: 24, fontWeight: "900" },
  card: { padding: 16, borderRadius: 12, gap: 12, borderWidth: 1 },
  label: { fontWeight: "800", marginTop: 4 },
  input: { minHeight: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  pasteBtn: { paddingHorizontal: 12, borderRadius: 8, justifyContent: "center" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: 12, borderTopWidth: 1, marginTop: 4 },
  sendBtn: { minHeight: 54, borderRadius: 10, alignItems: "center", justifyContent: "center" }
});
```

- [ ] **Step 3: Update `src/navigation/TabNavigator.tsx` — import SendScreen and wire up**

Replace the send placeholder with:

```tsx
import { SendScreen } from "../screens/SendScreen";

// In the render, replace the send placeholder:
if (screen === "send") return <SendScreen address={walletAddress} text={text} onBack={() => navigate("wallet")} />;
```

Also add `onBack` prop to ReceiveScreen and BuyScreen:

```tsx
// ReceiveScreen — add onBack to props and navigation
if (screen === "receive") return <ReceiveScreen address={walletAddress} copiedLabel={text.copied} copyLabel={text.copy} titleLabel={text.address} onBack={() => navigate("wallet")} />;

// BuyScreen — add onBack to props
if (screen === "buy") return <BuyScreen btcAddress={walletAddress} price={null} text={text} onBack={() => navigate("wallet")} />;
```

Update ReceiveScreen and BuyScreen to accept and render `onBack`:

In `ReceiveScreen.tsx`, add `onBack` prop and render a back button at the top:
```tsx
export function ReceiveScreen({ address, copiedLabel, copyLabel, titleLabel, onBack }: {
  address: string;
  copiedLabel: string;
  copyLabel: string;
  titleLabel: string;
  onBack: () => void;
}) {
  // ... add at top of render:
  // <Pressable onPress={onBack}><Text style={{ color: theme.accent }}>← Back</Text></Pressable>
```

In `BuyScreen.tsx`, add `onBack` prop:
```tsx
export function BuyScreen({ btcAddress, price, text, onBack }: {
  btcAddress: string;
  price: number | null;
  text: { [key: string]: string };
  onBack: () => void;
}) {
  // ... add at top of render:
  // <Pressable onPress={onBack}><Text style={{ color: theme.accent }}>← Back</Text></Pressable>
```

- [ ] **Step 4: Commit**

```bash
git add src/components/FeeSelector.tsx src/screens/SendScreen.tsx src/navigation/TabNavigator.tsx src/screens/ReceiveScreen.tsx src/screens/BuyScreen.tsx
git commit -m "feat: add Send screen with fee selector and transaction broadcasting"
```

---

## Phase 3: Reliability & Security

### Task 11: Add biometric authentication

**Files:**
- Create: `src/services/auth.ts`
- Modify: `src/screens/SendScreen.tsx` — add auth before send
- Modify: `src/screens/SettingsScreen.tsx` — add auth before showing mnemonic

- [ ] **Step 1: Create `src/services/auth.ts`**

```ts
import * as LocalAuthentication from "expo-local-authentication";

export async function authenticate(reason: string): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return true;

  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  if (!isEnrolled) return true;

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    fallbackLabel: "Use passcode",
    cancelLabel: "Cancel"
  });

  return result.success;
}
```

- [ ] **Step 2: Add auth gate to SendScreen `handleSend`**

In `src/screens/SendScreen.tsx`, add import and wrap the send logic:

```ts
import { authenticate } from "../services/auth";

// In handleSend, before buildAndSendTx:
const authorized = await authenticate(text.biometricPrompt);
if (!authorized) return;
```

- [ ] **Step 3: Add auth gate to SettingsScreen mnemonic reveal**

In `src/screens/SettingsScreen.tsx`:

```ts
import { authenticate } from "../services/auth";

// Change the mnemonic toggle to require auth:
const handleToggleMnemonic = async () => {
  if (!showMnemonic) {
    const authorized = await authenticate(text.biometricPrompt);
    if (!authorized) return;
  }
  setShowMnemonic((v) => !v);
};

// Use handleToggleMnemonic instead of inline toggle in the Pressable
```

- [ ] **Step 4: Commit**

```bash
git add src/services/auth.ts src/screens/SendScreen.tsx src/screens/SettingsScreen.tsx
git commit -m "feat: add biometric auth for send and mnemonic reveal"
```

---

### Task 12: Final integration test and build

- [ ] **Step 1: Run typecheck**

```bash
cd /c/Users/51847/Documents/btcqianbao
npx tsc --noEmit
```

- [ ] **Step 2: Build release APK**

```bash
cd /c/Users/51847/Documents/btcqianbao/android
export ANDROID_HOME="/c/Users/51847/AppData/Local/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/34.0.0:$PATH"
./gradlew assembleRelease
```

- [ ] **Step 3: Install on device**

```bash
adb -s 8DONONFM4DTO5DYL install -r /c/Users/51847/Documents/btcqianbao/android/app/build/outputs/apk/release/app-release.apk
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final integration and release build"
```
