import { STABLECOINS, type StablecoinToken } from "../chains/stablecoins";
import { EVM_CHAINS, type AssetDef, type ChainId, type EvmChainConfig } from "../chains/tokens";
import { AbiCoder, Contract, JsonRpcProvider, SigningKey, Wallet, parseUnits, formatEther, getAddress } from "ethers";
import { getEvmPrivateKey } from "./wallet";
import { safeFetch } from "./hosts";
import { SelfSendError } from "./errors";
import { logger } from "./logger";

const BALANCE_OF_SELECTOR = "0x70a08231";
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const NAME_SELECTOR = "0x06fdde03";
const SYMBOL_SELECTOR = "0x95d89b41";
const DECIMALS_SELECTOR = "0x313ce567";

export type StablecoinBalance = {
  token: StablecoinToken;
  rawBalance: bigint;
  displayBalance: string;
};

function padAddress(address: string) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function formatUnits(value: bigint, decimals: number) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const trimmed = padded.length > 6 ? padded.slice(0, 6) : padded;
  return `${whole}.${trimmed}`;
}

async function rpcCall<T>(cfg: EvmChainConfig, method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (const rpcUrl of cfg.rpcUrls) {
    try {
      const response = await safeFetch(
        rpcUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        },
        12000
      );
      if (!response.ok) throw new Error(`RPC ${response.status}`);
      const json = await response.json();
      if (json.error) throw new Error(json.error.message || "RPC error");
      return json.result as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All RPC endpoints failed");
}

export function validateEvmAddress(address: string) {
  return EVM_ADDRESS_REGEX.test(address.trim());
}

// EIP-55 checksum 校验：格式合法 + mixed-case 地址 checksum 必须匹配。
// 纯小写/大写地址不做 checksum 校验（用户可粘贴无 checksum 形式）；
// mixed-case 输入若与预期 checksum 不符则视为手误/损坏，入口即拒绝。
export function assertEvmAddress(address: string): string {
  const trimmed = address.trim();
  if (!EVM_ADDRESS_REGEX.test(trimmed)) throw new Error("Invalid EVM address");
  return getAddress(trimmed);
}

async function fetchErc20Balance(token: StablecoinToken, ownerAddress: string): Promise<StablecoinBalance> {
  if (!validateEvmAddress(ownerAddress)) throw new Error("Invalid EVM address");
  const data = `${BALANCE_OF_SELECTOR}${padAddress(ownerAddress)}`;
  const result = await rpcCall<string>(EVM_CHAINS[token.chainId], "eth_call", [{ to: token.contractAddress, data }, "latest"]);
  const rawBalance = BigInt(result || "0x0");
  return {
    token,
    rawBalance,
    displayBalance: formatUnits(rawBalance, token.decimals)
  };
}

export async function fetchErc20BalanceFor(asset: AssetDef, ownerAddress: string): Promise<{ asset: AssetDef; rawBalance: bigint; displayBalance: string }> {
  if (!asset.contractAddress || asset.decimals === undefined) throw new Error("Missing ERC-20 contract info");
  if (!validateEvmAddress(ownerAddress)) throw new Error("Invalid EVM address");
  const data = `${BALANCE_OF_SELECTOR}${padAddress(ownerAddress)}`;
  const result = await rpcCall<string>(EVM_CHAINS[asset.chainId as ChainId], "eth_call", [{ to: asset.contractAddress, data }, "latest"]);
  const rawBalance = BigInt(result || "0x0");
  return { asset, rawBalance, displayBalance: formatUnits(rawBalance, asset.decimals) };
}

export async function fetchStablecoinBalances(ownerAddress: string): Promise<StablecoinBalance[]> {
  const balances = await Promise.allSettled(STABLECOINS.map((token) => fetchErc20Balance(token, ownerAddress)));
  return balances
    .map((result) => result.status === "fulfilled" ? result.value : null)
    .filter((balance): balance is StablecoinBalance => Boolean(balance));
}

/**
 * 只读操作可以在多个 RPC 之间重试。
 *
 * ⚠️ 绝不能用于包含 sendTransaction 的逻辑：若广播已成功但 tx.wait() 超时抛错，
 * 重试会在下一个 RPC 上**再发一次交易**。nonce 相同时后者会被拒，但若期间
 * nonce 已推进就是真的重复转账。写操作请用 withProviderOnce。
 */
async function withProviderCfg<T>(cfg: EvmChainConfig, run: (provider: JsonRpcProvider) => Promise<T>) {
  let lastError: unknown;
  for (const rpcUrl of cfg.rpcUrls) {
    try {
      const provider = new JsonRpcProvider(rpcUrl, Number.parseInt(cfg.chainHexId, 16), { staticNetwork: true });
      return await run(provider);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All RPC endpoints failed");
}

/**
 * 写操作专用：**只在广播之前**允许切换 RPC。
 * connect 阶段（选一个能用的 provider）可以重试；一旦进入 send 阶段就锁定该
 * provider，失败直接上抛，绝不换节点重发。
 */
async function withProviderOnce<T>(
  cfg: EvmChainConfig,
  run: (provider: JsonRpcProvider) => Promise<T>,
): Promise<T> {
  let provider: JsonRpcProvider | null = null;
  let lastError: unknown;
  for (const rpcUrl of cfg.rpcUrls) {
    const candidate = new JsonRpcProvider(rpcUrl, Number.parseInt(cfg.chainHexId, 16), {
      staticNetwork: true,
    });
    try {
      await candidate.getBlockNumber(); // 探活，仅此一步可重试
      provider = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!provider) {
    throw lastError instanceof Error ? lastError : new Error("All RPC endpoints failed");
  }
  // 从这里开始不再重试
  return run(provider);
}

/**
 * 解码 ERC-20 的 name/symbol 返回值。
 *
 * 旧实现是手写 ABI 解码器：对 64 位十六进制长度字段用 parseInt，可能超过
 * Number.MAX_SAFE_INTEGER 并产生垃圾切片。改用 ethers 的 AbiCoder；
 * 部分老代币（如 MKR）返回 bytes32 而非 string，因此保留 bytes32 回退分支。
 */
function decodeStringResult(hex: string): string {
  const clean = hex && hex !== "0x" ? hex : "";
  if (!clean) return "";
  const coder = AbiCoder.defaultAbiCoder();
  try {
    return String(coder.decode(["string"], clean)[0]).replace(/\0+$/, "").trim();
  } catch {
    // bytes32 右补零形式
    try {
      const raw = coder.decode(["bytes32"], clean)[0] as string;
      const bytes = raw.replace(/^0x/, "").match(/.{2}/g) ?? [];
      let out = "";
      for (const b of bytes) {
        const code = parseInt(b, 16);
        if (code >= 32 && code <= 126) out += String.fromCharCode(code);
      }
      return out.trim();
    } catch {
      return "";
    }
  }
}

// 上链读取任意 ERC-20 的 name/symbol/decimals，用于“按合约地址搜索添加代币”的校验与展示。
export async function fetchTokenMetadata(chainId: ChainId, contractAddress: string) {
  if (!validateEvmAddress(contractAddress)) throw new Error("Invalid contract address");
  const cfg = EVM_CHAINS[chainId];
  const [nameRaw, symbolRaw, decimalsRaw] = await Promise.all([
    rpcCall<string>(cfg, "eth_call", [{ to: contractAddress, data: NAME_SELECTOR }, "latest"]),
    rpcCall<string>(cfg, "eth_call", [{ to: contractAddress, data: SYMBOL_SELECTOR }, "latest"]),
    rpcCall<string>(cfg, "eth_call", [{ to: contractAddress, data: DECIMALS_SELECTOR }, "latest"]),
  ]);
  const name = decodeStringResult(nameRaw) || "Unknown";
  const symbol = decodeStringResult(symbolRaw) || "???";

  // decimals=0 的代币是合法的（如某些 NFT-like ERC-20）。旧实现写的是
  // `... || 18`，0 会被 falsy 判定静默改成 18，金额显示与转账数量差 10^18 倍。
  let decimals: number;
  try {
    decimals = Number(AbiCoder.defaultAbiCoder().decode(["uint8"], decimalsRaw)[0]);
  } catch {
    decimals = Number.NaN;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Contract did not return a valid ERC-20 decimals value");
  }

  // 非 ERC-20 地址（EOA 或不实现该接口的合约）会让三个 eth_call 全返回 "0x"，
  // 旧实现会静默产出 {name:"Unknown", symbol:"???", decimals:18} 这样一个
  // 看起来正常的"代币"，用户可能据此添加一个根本不存在的资产。
  if (!nameRaw || nameRaw === "0x" || !symbolRaw || symbolRaw === "0x") {
    throw new Error("Address does not implement ERC-20 metadata");
  }

  return { name, symbol, decimals, contractAddress, chainId };
}

export async function fetchNativeBalance(chainId: ChainId, address: string): Promise<bigint> {
  if (!validateEvmAddress(address)) throw new Error("Invalid EVM address");
  const result = await rpcCall<string>(EVM_CHAINS[chainId], "eth_getBalance", [address, "latest"]);
  return BigInt(result || "0x0");
}

export async function estimateEvmGas(
  asset: AssetDef,
  from: string,
  to: string,
  amount: string,
): Promise<{ gasLimit: bigint; displayCost: string }> {
  // 与转账路径保持一致的 EIP-55 校验：旧实现这里只做格式校验，
  // 会先给出 gas 估算、真正转账时才因 checksum 不符被拒。
  assertEvmAddress(to);
  const trimmed = amount.trim();
  if (!trimmed || Number(trimmed) <= 0) throw new Error("Invalid amount");
  const cfg = EVM_CHAINS[asset.chainId as ChainId];
  return withProviderCfg(cfg, async (provider) => {
    let gasLimit: bigint;
    if (asset.kind === "native") {
      const value = parseUnits(trimmed, 18);
      gasLimit = await provider.estimateGas({ from, to: to.trim(), value });
    } else {
      if (!asset.contractAddress || asset.decimals === undefined) throw new Error("Missing ERC-20 contract info");
      const contract = new Contract(
        asset.contractAddress,
        ["function transfer(address to, uint256 amount) returns (bool)"],
        provider,
      );
      const parsedAmount = parseUnits(trimmed, asset.decimals);
      gasLimit = await contract.transfer.estimateGas(to.trim(), parsedAmount, { from });
    }
    const gasLimitWithBuffer = gasLimit * 120n / 100n;
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const gasCostWei = gasLimitWithBuffer * gasPrice;
    const displayCost = `${formatEther(gasCostWei)} ${cfg.feeSymbol}`;
    return { gasLimit, displayCost };
  });
}

/**
 * 优先使用 EIP-1559（maxFeePerGas / maxPriorityFeePerGas）。
 * 旧实现隐式走 legacy gasPrice，在 Polygon 上容易卡住不确认。
 */
async function buildFeeOverrides(provider: JsonRpcProvider): Promise<Record<string, bigint>> {
  try {
    const fee = await provider.getFeeData();
    if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
      return { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
    }
    if (fee.gasPrice) return { gasPrice: fee.gasPrice };
  } catch (err) {
    logger.warn("Fee data unavailable, letting provider decide", err);
  }
  return {};
}

async function transferNative(chainId: ChainId, to: string, amount: string) {
  assertEvmAddress(to);
  const trimmed = amount.trim();
  if (!trimmed) throw new Error("Invalid amount");
  const value = parseUnits(trimmed, 18);
  if (value <= 0n) throw new Error("Invalid amount");
  const privateKey = await getEvmPrivateKey();
  try {
    return await withProviderOnce(EVM_CHAINS[chainId], async (provider) => {
      const signer = new Wallet(new SigningKey(privateKey), provider);
      if (signer.address.toLowerCase() === to.trim().toLowerCase()) throw new SelfSendError();
      const balance = await provider.getBalance(signer.address);
      if (value > balance) throw new Error("Insufficient balance");
      const gasLimit = await signer.estimateGas({ to: to.trim(), value });
      const fees = await buildFeeOverrides(provider);
      const tx = await signer.sendTransaction({
        to: to.trim(),
        value,
        gasLimit: (gasLimit * 120n) / 100n,
        chainId: Number.parseInt(EVM_CHAINS[chainId].chainHexId, 16),
        ...fees,
      });
      // 广播后立即返回 pending。旧实现 await tx.wait(2) 会把 Promise 阻塞数分钟，
      // UI 上表现为"发送中"转圈很久；确认数应由交易列表在后台轮询。
      return { hash: tx.hash as string, pending: true };
    });
  } finally {
    privateKey.fill(0);
  }
}

// 统一的资产转账入口：原生币走 value 转账，ERC-20 走 transfer。
export async function transferAsset(asset: AssetDef, to: string, amount: string) {
  if (asset.kind === "native") {
    return transferNative(asset.chainId as ChainId, to, amount);
  }
  if (!asset.contractAddress || asset.decimals === undefined) throw new Error("Missing ERC-20 contract info");
  assertEvmAddress(to);
  const trimmedAmount = amount.trim();
  if (!trimmedAmount) throw new Error("Invalid amount");
  const parsedAmount = parseUnits(trimmedAmount, asset.decimals);
  if (parsedAmount <= 0n) throw new Error("Invalid amount");
  const privateKey = await getEvmPrivateKey();
  try {
    return await withProviderOnce(EVM_CHAINS[asset.chainId as ChainId], async (provider) => {
      const signer = new Wallet(new SigningKey(privateKey), provider);
      if (signer.address.toLowerCase() === to.trim().toLowerCase()) throw new SelfSendError();
      const balance = await fetchErc20BalanceFor(asset, signer.address).catch(() => null);
      if (!balance) {
        throw new Error("Unable to verify ERC-20 balance — RPC may be unavailable");
      }
      if (parsedAmount > balance.rawBalance) {
        throw new Error("Insufficient balance");
      }
      const contract = new Contract(asset.contractAddress as string, ["function transfer(address to, uint256 amount) returns (bool)"], signer);
      const gasLimit = await contract.transfer.estimateGas(to.trim(), parsedAmount);
      const fees = await buildFeeOverrides(provider);
      const tx = await contract.transfer(to.trim(), parsedAmount, {
        gasLimit: (gasLimit * 120n) / 100n,
        ...fees,
      });
      return { hash: tx.hash as string, pending: true };
    });
  } finally {
    privateKey.fill(0);
  }
}

async function transferStablecoin(token: StablecoinToken, to: string, amount: string) {
  return transferAsset(
    { id: token.id, kind: "erc20", symbol: token.symbol, name: token.name, chainId: token.chainId, contractAddress: token.contractAddress, decimals: token.decimals, feeSymbol: token.feeSymbol },
    to,
    amount,
  );
}
