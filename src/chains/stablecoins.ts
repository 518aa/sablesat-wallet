export type StablecoinSymbol = "USDT" | "USDC";
export type StablecoinChainId = "bsc" | "polygon";

export type StablecoinToken = {
  id: string;
  chainId: StablecoinChainId;
  chainName: string;
  chainShortName: string;
  chainHexId: string;
  rpcUrls: string[];
  explorerTxUrl: string;
  symbol: StablecoinSymbol;
  name: string;
  contractAddress: string;
  decimals: number;
  feeSymbol: string;
};

export const STABLECOINS: StablecoinToken[] = [
  {
    id: "usdt-bsc",
    chainId: "bsc",
    chainName: "BNB Smart Chain",
    chainShortName: "BSC",
    chainHexId: "0x38",
    rpcUrls: ["https://bsc-dataseed.binance.org", "https://bsc.publicnode.com"],
    explorerTxUrl: "https://bscscan.com/tx/",
    symbol: "USDT",
    name: "Tether USD",
    contractAddress: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18,
    feeSymbol: "BNB"
  },
  {
    id: "usdc-bsc",
    chainId: "bsc",
    chainName: "BNB Smart Chain",
    chainShortName: "BSC",
    chainHexId: "0x38",
    rpcUrls: ["https://bsc-dataseed.binance.org", "https://bsc.publicnode.com"],
    explorerTxUrl: "https://bscscan.com/tx/",
    symbol: "USDC",
    name: "USD Coin",
    contractAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
    feeSymbol: "BNB"
  },
  {
    id: "usdt-polygon",
    chainId: "polygon",
    chainName: "Polygon",
    chainShortName: "Polygon",
    chainHexId: "0x89",
    rpcUrls: ["https://polygon-rpc.com", "https://polygon-bor.publicnode.com"],
    explorerTxUrl: "https://polygonscan.com/tx/",
    symbol: "USDT",
    name: "Tether USD",
    contractAddress: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    decimals: 6,
    feeSymbol: "POL"
  },
  {
    id: "usdc-polygon",
    chainId: "polygon",
    chainName: "Polygon",
    chainShortName: "Polygon",
    chainHexId: "0x89",
    rpcUrls: ["https://polygon-rpc.com", "https://polygon-bor.publicnode.com"],
    explorerTxUrl: "https://polygonscan.com/tx/",
    symbol: "USDC",
    name: "USD Coin",
    contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    decimals: 6,
    feeSymbol: "POL"
  }
];

export function getStablecoin(id: string) {
  return STABLECOINS.find((token) => token.id === id);
}
