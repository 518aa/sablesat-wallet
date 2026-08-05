import React from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../hooks/useTheme";
import { hapticImpact } from "../utils/haptics";
import { press } from "../theme-tokens";
import { type Language, type ReturnTypeT } from "../i18n";
import { HomeScreen } from "../screens/HomeScreen";
import { ReceiveScreen } from "../screens/ReceiveScreen";
import { SendScreen } from "../screens/SendScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { TransactionScreen } from "../screens/TransactionScreen";
import { VaultListScreen } from "../screens/VaultListScreen";
import { VaultCreateScreen } from "../screens/VaultCreateScreen";

import { VaultDetailScreen } from "../screens/VaultDetailScreen";
import { VaultSendScreen } from "../screens/VaultSendScreen";
import { VaultCosignScreen } from "../screens/VaultCosignScreen";
import type { Wallet } from "../services/wallet";

export type Screen =
  | "wallet"
  | "history"
  | "settings"
  | "send"
  | "receive"
  | "vault"
  | "vaultCreate"
  | "vaultDetail"
  | "vaultSend"
  | "vaultCosign";

export function TabNavigator({
  wallet,
  language,
  text,
  onLanguageChange,
  onLock,
  onReset
}: {
  wallet: Wallet;
  language: Language;
  text: ReturnTypeT;
  onLanguageChange: (lang: Language) => void;
  onLock: () => void;
  onReset: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [screen, setScreen] = React.useState<Screen>("wallet");
  const [tab, setTab] = React.useState<"wallet" | "history" | "vault" | "settings">("wallet");
  const [activeVaultId, setActiveVaultId] = React.useState<string | null>(null);

  function navigate(s: Screen) {
    setScreen(s);
    if (s === "wallet" || s === "history" || s === "vault" || s === "settings") {
      setTab(s);
    }
  }

  function openVault(id: string) {
    setActiveVaultId(id);
    navigate("vaultDetail");
  }

  React.useEffect(() => {
    if (
      screen === "wallet" ||
      screen === "history" ||
      screen === "settings" ||
      screen === "vault"
    ) {
      return;
    }
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (screen === "vaultDetail") navigate("vault");
      else if (screen === "vaultCreate") navigate("vault");
      else if (screen === "vaultSend") navigate("vaultDetail");
      else if (screen === "vaultCosign") navigate("vault");
      else navigate("wallet");
      return true;
    });
    return () => sub.remove();
  }, [screen]);

  if (screen === "receive") {
    return (
      <ReceiveScreen
        btcAddress={wallet.address}
        evmAddress={wallet.evmAddress}
        copiedLabel={text.copied}
        copyLabel={text.copyAddress}
        titleLabel={text.address}
        hintLabel={text.receiveHint}
        backLabel={text.backToWallet}
        onBack={() => navigate("wallet")}
        text={text}
      />
    );
  }
  if (screen === "send") {
    return <SendScreen btcAddress={wallet.address} evmAddress={wallet.evmAddress} text={text} onBack={() => navigate("wallet")} />;
  }
  if (screen === "vaultCreate") {
    return (
      <VaultCreateScreen
        text={text}
        onCreated={(id) => openVault(id)}
        onBack={() => navigate("vault")}
      />
    );
  }
  if (screen === "vaultDetail" && activeVaultId) {
    return (
      <VaultDetailScreen
        vaultId={activeVaultId}
        text={text}
        onBack={() => navigate("vault")}
        onSend={() => navigate("vaultSend")}
        onCosign={() => navigate("vaultCosign")}
      />
    );
  }
  if (screen === "vaultSend" && activeVaultId) {
    return <VaultSendScreen vaultId={activeVaultId} text={text} onBack={() => navigate("vaultDetail")} />;
  }
  if (screen === "vaultCosign") {
    return (
      <VaultCosignScreen
        text={text}
        onBack={() => navigate("vault")}
        onDone={() => navigate("vault")}
      />
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.screenWrap}>
        {tab === "wallet" && (
          <HomeScreen
            wallet={wallet}
            language={language}
            text={text}
            onSend={() => navigate("send")}
            onReceive={() => navigate("receive")}
            onHistory={() => navigate("history")}
          />
        )}
        {tab === "history" && (
          <TransactionScreen
            wallet={wallet}
            titleLabel={text.txHistory}
            emptyLabel={text.noTxs}
            emptyHintLabel={text.emptyTxHint}
            loadingLabel={text.loadingTx}
            refreshHint={text.txRefreshHint}
            confirmedLabel={text.confirmed}
            pendingLabel={text.pending}
            loadMoreLabel={text.loadMore}
            language={language}
          />
        )}
        {tab === "vault" && (
          <VaultListScreen
            text={text}
            onCreate={() => navigate("vaultCreate")}
            onOpen={openVault}
          />
        )}
        {tab === "settings" && (
          <SettingsScreen language={language} text={text} onLanguageChange={onLanguageChange} onLock={onLock} onReset={onReset} />
        )}
      </View>

      <View style={[styles.tabBar, { backgroundColor: theme.tabBg, borderColor: theme.border, bottom: Math.max(18, insets.bottom + 8) }]}>
        {(["wallet", "history", "vault", "settings"] as const).map((item) => {
          const active = tab === item;
          const label = item === "wallet" ? text.walletTab : item === "history" ? text.historyTab : item === "vault" ? text.vaultTab : text.settingsTab;
          const iconName =
            item === "wallet" ? "wallet-outline" : item === "history" ? "time-outline" : item === "vault" ? "lock-closed-outline" : "settings-outline";
          return (
            <Pressable
              key={item}
              onPress={() => { if (tab !== item) { hapticImpact("light"); navigate(item); } }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={label}
              style={({ pressed }) => [
                styles.tabItem,
                active && { backgroundColor: theme.surface },
                pressed && !active && { opacity: 0.7, transform: [{ scale: press.scale }] },
              ]}
            >
              <Ionicons name={iconName} size={21} color={active ? theme.accent : theme.tabInactiveText} />
              <Text style={[styles.tabText, { color: active ? theme.accent : theme.tabInactiveText }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  screenWrap: { flex: 1 },
  tabBar: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 }
  },
  tabItem: { flex: 1, minHeight: 48, borderRadius: 10, alignItems: "center", justifyContent: "center", gap: 2 },
  tabText: { fontSize: 10, fontWeight: "900" },
  backButton: { alignSelf: "flex-start", marginHorizontal: 16, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }
});
