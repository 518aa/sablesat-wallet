import { secureRandomBytes } from "./randomness";

// ───────────────────────────────────────────────────────────────────────────
// 币选算法：Branch and Bound（无找零解优先） + 单次随机抽取（SRD）回退。
//
// 【为什么要换掉 largest-first】旧实现每次都从最大的 UTXO 开始拿，这在三个
// 维度上都是最差的：
//
//   1. **隐私**：永远动最大的那笔，链上分析可以稳定识别"这个钱包的找零模式"；
//      而且每笔交易都产生找零，等于持续把新地址与旧 UTXO 绑定在一起。
//   2. **UTXO 集恶化**：大 UTXO 被不断劈碎成找零，小 UTXO 永远不被消耗，
//      钱包里的 UTXO 数量单调上升，未来每笔交易的手续费也随之上升。
//   3. **手续费**：几乎必然产生找零输出（+31 vB），而无找零解本可以省掉。
//
// Bitcoin Core 从 0.17 起用的就是 BnB：先穷举有没有"刚好够、不用找零"的组合，
// 找不到再退回随机抽取。无找零交易同时省手续费、少一个输出、且不产生新的
// 可关联找零 —— 三个目标在这里是一致的。
//
// 【与 Core 的差异】Core 的 BnB 用 effective value（扣除该 input 的边际手续费）
// 并允许最多 100k 次尝试。这里同样用 effective value，但把上限降到 10k 次
// —— 手机上 100k 次递归在低端 Android 上是肉眼可见的卡顿，而实测 10k 次足以
// 覆盖普通钱包（UTXO 数 < 100）的绝大多数情形。
// ───────────────────────────────────────────────────────────────────────────

export type SelectableUtxo = { value: number };

export type CoinSelectionParams<T extends SelectableUtxo> = {
  utxos: readonly T[];
  targetSats: number;
  feeRate: number;
  /** 单个输入的 vbytes（P2WPKH ≈ 68，P2WSH 多签更大）。 */
  inputVbytes: number;
  /** 单个输出的 vbytes（P2WPKH ≈ 31）。 */
  outputVbytes: number;
  /** 交易固定开销 vbytes。 */
  overheadVbytes: number;
  /** 找零低于此值就不值得创建。 */
  dustThreshold: number;
};

export type CoinSelectionResult<T> = {
  selected: T[];
  feeSats: number;
  changeSats: number;
  /** 用了哪条路径，便于诊断与测试断言。 */
  strategy: "bnb-no-change" | "srd-with-change" | "srd-no-change";
};

/** BnB 的搜索次数上限。见文件头关于与 Core 差异的说明。 */
const MAX_BNB_TRIES = 10_000;

/**
 * 「刚好够」的容差窗口上界。
 *
 * Core 的做法：超出目标但少于「再加一个找零输出的成本」时，把多余部分给矿工
 * 反而比创建找零更划算。窗口大小 = 一个找零输出的成本 + 花掉它的成本。
 */
function costOfChange(p: CoinSelectionParams<SelectableUtxo>): number {
  const createCost = p.outputVbytes * p.feeRate;
  const spendLaterCost = p.inputVbytes * p.feeRate;
  return Math.ceil(createCost + spendLaterCost);
}

/** 该 input 扣除自身边际手续费后的净贡献。负值说明这笔 UTXO 花它还亏钱。 */
function effectiveValue(value: number, p: CoinSelectionParams<SelectableUtxo>): number {
  return value - Math.ceil(p.inputVbytes * p.feeRate);
}

function txFee(
  inputCount: number,
  outputCount: number,
  p: CoinSelectionParams<SelectableUtxo>,
): number {
  return Math.ceil(
    (inputCount * p.inputVbytes + outputCount * p.outputVbytes + p.overheadVbytes) * p.feeRate,
  );
}

/**
 * Branch and Bound：寻找**无需找零**的输入组合。
 *
 * 目标区间 [target, target + costOfChange]。命中即返回 —— 这样的交易少一个
 * 输出、手续费更低、且不产生新的可被关联的找零地址。
 *
 * @returns 命中的输入子集；找不到返回 null（调用方回退 SRD）
 */
function branchAndBound<T extends SelectableUtxo>(p: CoinSelectionParams<T>): T[] | null {
  // 按 effective value 降序。只保留正贡献的 UTXO —— 负贡献的花了反而亏。
  const pool = p.utxos
    .map((u) => ({ utxo: u, ev: effectiveValue(u.value, p) }))
    .filter((x) => x.ev > 0)
    .sort((a, b) => b.ev - a.ev);

  if (pool.length === 0) return null;

  // 目标也要算上"不含任何 input 的那部分手续费"（输出 + 固定开销）。
  const baseFee = Math.ceil((p.outputVbytes + p.overheadVbytes) * p.feeRate);
  const target = p.targetSats + baseFee;
  const upperBound = target + costOfChange(p);

  const totalAvailable = pool.reduce((s, x) => s + x.ev, 0);
  if (totalAvailable < target) return null;

  let tries = 0;
  const selection: boolean[] = new Array(pool.length).fill(false);
  let bestSelection: boolean[] | null = null;

  // 深度优先，含"剪枝 + 回溯"两个方向，与 Core 的 SelectCoinsBnB 同构。
  let depth = 0;
  let currentValue = 0;
  let remaining = totalAvailable;

  while (tries < MAX_BNB_TRIES) {
    tries++;
    let backtrack = false;

    if (currentValue > upperBound) {
      // 超出容差窗口 —— 这个分支不可能有解
      backtrack = true;
    } else if (currentValue >= target) {
      // 命中窗口内，记录并回溯继续找更优解（更少的输入）
      bestSelection = selection.slice();
      backtrack = true;
    } else if (depth >= pool.length) {
      backtrack = true;
    } else if (currentValue + remaining < target) {
      // 剩下的全拿上也不够
      backtrack = true;
    }

    if (backtrack) {
      if (bestSelection) break;
      // 退掉末尾连续的"未选中"位，把它们的 ev 还回可用余量
      while (depth > 0 && !selection[depth - 1]) {
        depth--;
        remaining += pool[depth].ev;
      }
      if (depth === 0) break;

      // 把最后一个"已选中"翻成"不选"。
      //
      // ⚠️ **depth 不能跟着回退**。翻转后这一位就成了"已决定：排除"，下一轮
      // 前进必须从 depth 这个位置继续往后探。如果这里再 depth--，前进步会
      // 重新选中刚刚排除掉的那一项 —— 死循环，BnB 永远只在第一个 UTXO 上打转，
      // 表现为"明明有精确解却总是回退到 SRD"。
      // 对应 Core SelectCoinsBnB 里的 `curr_selection.back() = false`：
      // vector 的 size（即 depth）保持不变，只改末位的值。
      selection[depth - 1] = false;
      currentValue -= pool[depth - 1].ev;
      continue;
    }

    // 前进：选中当前项
    remaining -= pool[depth].ev;
    selection[depth] = true;
    currentValue += pool[depth].ev;
    depth++;
  }

  if (!bestSelection) return null;
  return pool.filter((_, i) => bestSelection[i]).map((x) => x.utxo);
}

/**
 * 密码学安全的洗牌。
 *
 * 用 secureRandomBytes 而不是 Math.random：币选顺序会体现在链上（输入顺序、
 * 找零位置），可预测的 PRNG 让观察者更容易做钱包指纹识别。这里的成本可以忽略，
 * 没有理由用弱随机。
 */
function shuffle<T>(items: readonly T[]): T[] {
  const out = items.slice();
  if (out.length <= 1) return out;
  const bytes = secureRandomBytes(out.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = out.length - 1; i > 0; i--) {
    const j = view.getUint32(i * 4, false) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Single Random Draw：随机抽取直到够为止。
 *
 * 为什么是随机而不是"最大优先"或"最小优先"：任何确定性顺序都会在链上留下
 * 可识别的模式。随机抽取让输入组合无规律可循，是隐私上最保守的回退策略。
 */
function singleRandomDraw<T extends SelectableUtxo>(
  p: CoinSelectionParams<T>,
): { selected: T[]; feeSats: number; changeSats: number } | null {
  const pool = shuffle(p.utxos.filter((u) => effectiveValue(u.value, p) > 0));
  const selected: T[] = [];
  let sum = 0;

  for (const utxo of pool) {
    selected.push(utxo);
    sum += utxo.value;
    const feeWithChange = txFee(selected.length, 2, p);
    if (sum >= p.targetSats + feeWithChange) {
      const change = sum - p.targetSats - feeWithChange;
      if (change > p.dustThreshold) {
        return { selected, feeSats: feeWithChange, changeSats: change };
      }
      // 找零太小，试试不建找零输出
      const feeNoChange = txFee(selected.length, 1, p);
      const surplus = sum - p.targetSats - feeNoChange;
      if (surplus >= 0 && surplus <= p.dustThreshold) {
        return { selected, feeSats: feeNoChange + surplus, changeSats: 0 };
      }
      // 都不合适，继续多拿一个
    }
  }
  return null;
}

export class NoSolutionError extends Error {
  constructor(
    public readonly targetSats: number,
    public readonly availableSats: number,
  ) {
    super(`Cannot fund ${targetSats} sats from ${availableSats} sats of spendable UTXOs`);
  }
}

/**
 * 币选主入口。BnB 优先，SRD 回退。
 *
 * 返回的 feeSats 是**实际会付给矿工的总额**（无找零时包含被吸收的余数），
 * 调用方不需要再自己算差额。
 */
export function selectCoins<T extends SelectableUtxo>(
  params: CoinSelectionParams<T>,
): CoinSelectionResult<T> {
  const spendable = params.utxos.filter((u) => Number.isFinite(u.value) && u.value > 0);
  const available = spendable.reduce((s, u) => s + u.value, 0);
  const p = { ...params, utxos: spendable };

  // 1) 优先找无找零解
  const bnb = branchAndBound(p);
  if (bnb && bnb.length > 0) {
    const sum = bnb.reduce((s, u) => s + u.value, 0);
    const fee = sum - p.targetSats; // 余数全部作为手续费（这正是无找零解的定义）
    return { selected: bnb, feeSats: fee, changeSats: 0, strategy: "bnb-no-change" };
  }

  // 2) 回退随机抽取
  const srd = singleRandomDraw(p);
  if (srd) {
    return {
      ...srd,
      strategy: srd.changeSats > 0 ? "srd-with-change" : "srd-no-change",
    };
  }

  throw new NoSolutionError(p.targetSats, available);
}
