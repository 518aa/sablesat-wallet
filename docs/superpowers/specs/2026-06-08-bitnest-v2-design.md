# BitNest Wallet v2 — Design Spec

## Overview

Refactor BitNest from a single-file Expo app into a well-structured multi-screen wallet with send BTC capability, theme switching, improved reliability, and security enhancements.

## Navigation Structure

**3-Tab bottom navigation** with Home acting as the central hub:

- **Tab 1 — Wallet (Home)**: Balance display + 3 action buttons (Send / Receive / Buy) + recent transactions
- **Tab 2 — Transactions**: Full transaction history with pull-to-refresh and pagination
- **Tab 3 — Settings**: Language toggle, theme toggle (dark/light), beginner guide toggle, mnemonic backup, wallet management

## File Structure

```
src/
  components/
    BalanceCard.tsx        # Balance display with BTC amount + CNY conversion
    ActionButtons.tsx      # 3 circular action buttons (Send/Receive/Buy)
    TransactionItem.tsx    # Single transaction row
    FeeSelector.tsx        # 3-tier fee selector (Slow/Medium/Fast)
    ThemeToggle.tsx        # Dark/Light mode switch
  screens/
    HomeScreen.tsx         # Main wallet overview
    TransactionScreen.tsx  # Full transaction history
    SettingsScreen.tsx     # App settings
    SendScreen.tsx         # Send BTC flow
    ReceiveScreen.tsx      # Receive BTC with address display
    BuyScreen.tsx          # Alipay buy flow
  services/
    wallet.ts              # Existing — wallet create/import/load
    blockchain.ts          # Improved — multi-node fallback, local cache
    transaction.ts         # New — build/sign/broadcast BTC transactions
    alipay.ts              # Existing — Alipay integration
    theme.ts               # New — theme management (AsyncStorage)
    i18n.ts                # Existing — i18n with CN/EN
  hooks/
    useWallet.ts           # Wallet state management
    useTheme.ts            # Theme preference + system detection
    useBlockchain.ts       # Blockchain data with caching
  navigation/
    TabNavigator.tsx       # Bottom tab navigation config
App.tsx                    # Root — theme provider + navigation wrapper
```

## Feature Details

### 1. Send BTC (New)

**Flow**: Enter address + amount → Fee tier selection → Confirmation screen → Biometric/PIN verification → Sign + Broadcast

- Address input with QR scan support (future) and paste from clipboard
- Amount input in BTC with CNY equivalent shown
- Fee tiers: Slow (~1 sat/vB, hours), Medium (~5 sat/vB, ~30min), Fast (~20 sat/vB, ~10min)
- Confirmation screen showing: recipient, amount, fee, total
- Biometric or PIN verification before signing
- Transaction built using `@scure/btc-signer`, broadcast via Blockstream/mempool.space API

### 2. Theme Switching (New)

- Dark theme as default (colors defined in spec below)
- Light theme alternative
- Preference stored in AsyncStorage, persists across sessions
- Respects system preference on first launch
- Toggle in Settings tab

**Dark theme palette**:
- Background: `#0f0f23` (deep), `#1a1a2e` (card), `#16213e` (surface)
- Text: `#f0f0f0` (primary), `#888` (secondary), `#555` (muted)
- Accent: `#3b82f6` (blue), `#4ade80` (green/incoming), `#ef4444` (red/outgoing)
- Action buttons: orange gradient (Send), blue gradient (Receive), green gradient (Buy)

**Light theme palette**:
- Background: `#F8F4EA` (warm white), `#FFFFFF` (card), `#F0ECE3` (surface)
- Text: `#1a1a1a` (primary), `#666` (secondary), `#999` (muted)
- Accent: same hues, adjusted for light backgrounds

### 3. Blockchain Reliability (Improved)

- **Multi-node fallback**: Blockstream.info (primary) → mempool.space (fallback)
- **Local cache**: Store last-fetched balance and transactions in AsyncStorage; serve from cache when offline
- **Auto-refresh**: On app foreground, every 30s on active screen
- **Error states**: Clear error messages with retry button; distinguish network vs API errors

### 4. Security Enhancements (New)

- **Biometric verification**: Before sending transactions and viewing mnemonic
- **PIN fallback**: 6-digit PIN when biometrics unavailable or user cancels
- **Mnemonic backup confirmation**: When viewing mnemonic, require re-authentication; offer backup verification flow
- **App lock**: Optional — require auth on app launch (configurable in settings)

### 5. Beginner Guide (Preserved)

- Migrated to new architecture, toggled from Settings
- Step-by-step guidance on Home screen for first-time users
- Educational content preserved from existing i18n strings

## API Endpoints

| Purpose | Primary | Fallback |
|---------|---------|----------|
| Address UTXO/txs | `blockstream.info/api` | `mempool.space/api` |
| BTC price | `api.coinbase.com` | `mempool.space/api` |
| Fee estimates | `mempool.space/api/v1/fees/recommended` | `blockstream.info/api/fee-estimates` |
| Broadcast tx | `blockstream.info/api/tx` | `mempool.space/api/tx` |

## Implementation Phases

### Phase 1: UI Refactor
- Restructure file layout, create component/screen/hook scaffolding
- Implement TabNavigator with 3 tabs
- Migrate existing functionality (wallet, balance, receive, buy, settings) into new screens
- Implement theme system (dark default + light toggle)

### Phase 2: Send BTC
- Implement transaction.ts service (UTXO fetching, tx building, signing, broadcasting)
- Build SendScreen with address input, amount input, fee selector
- Add confirmation screen with biometric/PIN verification
- Wire up broadcast and success/failure handling

### Phase 3: Reliability
- Add multi-node fallback to blockchain.ts
- Implement local caching with AsyncStorage
- Add error boundaries and retry logic
- Offline state handling

### Phase 4: Security
- Integrate expo-local-authentication for biometrics
- Implement PIN setup/verification flow
- Add auth gates to mnemonic view and send flow
- Optional app-lock on launch

## Dependencies to Add

- `@react-navigation/native` + `@react-navigation/bottom-tabs` — navigation
- `@react-native-async-storage/async-storage` — theme/cache persistence
- `expo-local-authentication` — biometric/PIN verification

## Out of Scope

- QR code scanning (future iteration)
- Multiple wallet support
- Address book / contacts
- Push notifications
- Dark mode color customization
