// 热钱包「发币老是不成功」的回归测试。
//
// 两条独立的失败链，各自都足以让每一笔发送都失败：
//   1. blockchain.info /unspent 的 tx_hash 是**内部字节序**（与浏览器显示的 txid
//      逆序）。用它建 PSBT，每个 input 都指向不存在的 outpoint —— 本地签名全过，
//      广播时被节点以 bad-txns-inputs-missingorspent 拒绝，用户看到 400。
//   2. /pushtx **成功**时返回的是 "Transaction Submitted" 文本而不是 txid。
//      旧实现用 /^[0-9a-f]{64}$/ 校验应答，把成功当失败，接着 fallback 打
//      mempool.space —— 那笔交易此刻已在 mempool 里，mempool 以 400
//      txn-already-in-mempool 拒绝。钱其实已经发出去了，UI 却报「发送失败 400」。

import { safeFetch } from "../services/hosts";
import {
  fetchUtxosRawBlockchainInfo,
  fetchUtxosBatchBlockchainInfo,
  broadcastBlockchainInfo,
  isAlreadyBroadcast,
  redactTxids,
  chunkAddresses,
} from "../services/blockchainInfo";

jest.mock("../services/hosts", () => ({ safeFetch: jest.fn() }));

const mockSafeFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textRes(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => mockSafeFetch.mockReset());

// ───────────────────────────────────────────────────────────────────────────
describe("UTXO txid 字节序（根因：广播被节点拒绝）", () => {
  // 同一笔输出的两种表示。big_endian 才是浏览器上、以及 PSBT 里该用的那个。
  const DISPLAY = "e6452a2cb71aa864aaa959e647e7a4726a22e640560f199f79b56b5502114c37";
  const INTERNAL = "374c1102556bb5799f190f5640e6226a72a4e747e659a9aa64a81ab72c2a45e6";

  it("优先取 tx_hash_big_endian，而不是逆序的 tx_hash", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonRes({
        unspent_outputs: [
          {
            tx_hash: INTERNAL,
            tx_hash_big_endian: DISPLAY,
            tx_output_n: 1,
            value: 100000,
            confirmations: 3,
          },
        ],
      }),
    );
    const utxos = await fetchUtxosRawBlockchainInfo("bc1qtest");
    expect(utxos).toHaveLength(1);
    expect(utxos[0].txid).toBe(DISPLAY);
    // 旧实现返回的就是这个值——PSBT 会指向一个不存在的 outpoint。
    expect(utxos[0].txid).not.toBe(INTERNAL);
  });

  it("上游只给 tx_hash 时自行逆序，绝不原样使用", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonRes({
        unspent_outputs: [{ tx_hash: INTERNAL, tx_output_n: 0, value: 5000, confirmations: 1 }],
      }),
    );
    const utxos = await fetchUtxosRawBlockchainInfo("bc1qtest");
    expect(utxos[0].txid).toBe(DISPLAY);
  });

  it("confirmations=0 如实标记为未确认，不再一律写死 confirmed:true", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonRes({
        unspent_outputs: [
          { tx_hash_big_endian: DISPLAY, tx_output_n: 0, value: 5000, confirmations: 0 },
        ],
      }),
    );
    const utxos = await fetchUtxosRawBlockchainInfo("bc1qtest");
    expect(utxos[0].status?.confirmed).toBe(false);
  });

  it("整批地址无 UTXO 时上游返回 500，视为空集而非错误", async () => {
    mockSafeFetch.mockResolvedValue(textRes("No free outputs to spend", 500));
    await expect(fetchUtxosRawBlockchainInfo("bc1qtest")).resolves.toEqual([]);
  });

  // 【金库确认发送按钮一直是灰的 / 余额忽有忽无的根因】
  // 旧实现把**任何** 500 都当成"这个地址没有 UTXO"。而 500 同样是反代过载、
  // 上游限流、上游故障的状态码——于是"查不到"被静默翻译成"你没钱"：
  // 余额显示 0、utxos 为空、canBuild 里的 utxos.length > 0 永远不成立。
  it("非「无可花输出」的 500 必须抛错，不能当成空集", async () => {
    mockSafeFetch.mockResolvedValue(textRes("<html>502 Bad Gateway</html>", 500));
    await expect(fetchUtxosRawBlockchainInfo("bc1qtest")).rejects.toThrow(/HTTP 500/);
  });

  it("反代吃掉错误体只剩空响应的 500 仍按空集处理（旧行为，不能收紧成硬错误）", async () => {
    mockSafeFetch.mockResolvedValue(textRes("", 500));
    await expect(fetchUtxosRawBlockchainInfo("bc1qtest")).resolves.toEqual([]);
  });

  it("429 限流必须抛错，不能被当成空集", async () => {
    mockSafeFetch.mockResolvedValue(textRes("rate limited", 429));
    await expect(fetchUtxosRawBlockchainInfo("bc1qtest")).rejects.toThrow(/HTTP 429/);
  });

  it("结果触及 limit 上限必须抛错——静默截断会少算可花余额", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonRes({
        unspent_outputs: Array.from({ length: 1000 }, (_, i) => ({
          tx_hash_big_endian: DISPLAY,
          tx_output_n: i,
          value: 1000,
          confirmations: 1,
        })),
      }),
    );
    await expect(fetchUtxosRawBlockchainInfo("bc1qtest")).rejects.toThrow(/truncated/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("批量地址查询（根因：逐地址请求被限流 → 余额跳变）", () => {
  it("42 个地址压成 3 批，而不是 42 次请求", () => {
    const addrs = Array.from({ length: 42 }, (_, i) => `addr${i}`);
    const batches = chunkAddresses(addrs);
    expect(batches).toHaveLength(3);
    expect(batches.flat()).toEqual(addrs);
  });

  it("按本地派生的 scriptPubKey 归属 UTXO，不信任 API 返回的地址", async () => {
    const scriptA = "0014" + "11".repeat(20);
    const scriptB = "0014" + "22".repeat(20);
    mockSafeFetch.mockResolvedValue(
      jsonRes({
        unspent_outputs: [
          { tx_hash_big_endian: "a".repeat(64), tx_output_n: 0, value: 111, confirmations: 1, script: scriptA },
          { tx_hash_big_endian: "b".repeat(64), tx_output_n: 0, value: 222, confirmations: 1, script: scriptB },
          // 陌生 script：必须被丢弃，不能塞进任何一个地址。
          { tx_hash_big_endian: "c".repeat(64), tx_output_n: 0, value: 999, confirmations: 1, script: "0014" + "99".repeat(20) },
        ],
      }),
    );
    const result = await fetchUtxosBatchBlockchainInfo(
      ["addrA", "addrB"],
      new Map([
        ["addrA", scriptA],
        ["addrB", scriptB],
      ]),
    );
    expect(result.get("addrA")?.map((u) => u.value)).toEqual([111]);
    expect(result.get("addrB")?.map((u) => u.value)).toEqual([222]);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  // `|` 不是合法 URL 字符。iOS 的 NSURLSession 对非法字符直接返回 nil（fetch 立刻
  // 失败），Android 的 OkHttp 会自己编码 —— 一个只在 iOS 上整批扫描失败的差异 bug。
  it("多地址分隔符必须百分号编码，不能裸写 |", async () => {
    mockSafeFetch.mockResolvedValue(jsonRes({ unspent_outputs: [] }));
    await fetchUtxosBatchBlockchainInfo(["addrA", "addrB"], new Map());
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain("addrA%7CaddrB");
    expect(url).not.toContain("|");
  });

  // 上游给了输出却一条都对不上本地派生的 script：不是"没钱"，是归属逻辑失效。
  // 静默返回空集会把它伪装成余额 0，必须抛错让上层退回逐地址路径。
  it("有输出但没有一条匹配本地 script 时必须抛错，而不是静默返回空集", async () => {
    mockSafeFetch.mockResolvedValue(
      jsonRes({
        unspent_outputs: [
          { tx_hash_big_endian: "a".repeat(64), tx_output_n: 0, value: 111, confirmations: 1, script: "0014" + "ee".repeat(20) },
        ],
      }),
    );
    await expect(
      fetchUtxosBatchBlockchainInfo(["addrA"], new Map([["addrA", "0014" + "11".repeat(20)]])),
    ).rejects.toThrow(/no outputs matched/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("广播应答判定（根因：把成功当失败 → fallback → 400）", () => {
  it('"Transaction Submitted" 是成功，不是拒绝', async () => {
    mockSafeFetch.mockResolvedValue(textRes("Transaction Submitted"));
    await expect(broadcastBlockchainInfo("00")).resolves.toEqual({ txid: null });
  });

  it("返回 64 位 hex 时按 txid 采纳", async () => {
    const txid = "f".repeat(64);
    mockSafeFetch.mockResolvedValue(textRes(txid.toUpperCase()));
    await expect(broadcastBlockchainInfo("00")).resolves.toEqual({ txid });
  });

  it('"already in mempool" 等同于广播成功——报错会诱使用户重发', async () => {
    mockSafeFetch.mockResolvedValue(textRes("txn-already-in-mempool", 400));
    await expect(broadcastBlockchainInfo("00")).resolves.toEqual({ txid: null });
  });

  it("真正的拒绝要把节点给的理由带上，而不是只剩一个 400", async () => {
    mockSafeFetch.mockResolvedValue(textRes("bad-txns-inputs-missingorspent", 400));
    await expect(broadcastBlockchainInfo("00")).rejects.toThrow(/bad-txns-inputs-missingorspent/);
  });

  it("错误文本里的 txid 要脱敏后才允许流向 UI / 日志", () => {
    expect(redactTxids(`rejected ${"a".repeat(64)} bad`)).toBe("rejected <txid> bad");
  });

  it("已广播判定覆盖各家节点的措辞", () => {
    expect(isAlreadyBroadcast("Transaction already in block chain")).toBe(true);
    expect(isAlreadyBroadcast("txn-already-known")).toBe(true);
    expect(isAlreadyBroadcast("min relay fee not met")).toBe(false);
  });
});
