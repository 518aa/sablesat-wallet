// 必须在任何其他 import 之前执行 —— 见 App.tsx 第一行。
//
// 背景：ESM 的 import 会全部提升到模块体之前执行。之前这段 polyfill 写在
// App.tsx 中部，导致 @noble/hashes/utils 在模块加载时读到的 globalThis.crypto
// 仍是 undefined（该模块在加载时就固化 crypto 引用），randomBytes() 生成
// salt/nonce 时可能拿不到熵源。放进独立文件并第一行导入，才能保证顺序。
import { secureRandomBytes, assertEntropyHealthy } from "./services/randomness";

const g = globalThis as unknown as { crypto?: Crypto };

if (typeof g.crypto === "undefined") {
  g.crypto = {} as Crypto;
}

if (typeof g.crypto.getRandomValues !== "function") {
  (g.crypto as { getRandomValues: <T extends ArrayBufferView>(a: T) => T }).getRandomValues = (
    array,
  ) => {
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    view.set(secureRandomBytes(view.byteLength));
    return array;
  };
}

/**
 * 启动自检。委托给 randomness.assertEntropyHealthy —— 关键是**结构性**检查
 * （是否落进 expo-crypto 的 Math.random 降级分支），因为统计检验发现不了
 * Math.random：它的输出非零、不重复、分布均匀，看起来完全正常。
 */
export function assertEntropyAvailable(): void {
  assertEntropyHealthy();
}
