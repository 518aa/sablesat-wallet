// 钱包生命周期钩子。
//
// 【为什么需要】deleteWallet() 必须清掉 SQLite 里的交易缓存，但 wallet.ts 直接
// import database 会形成循环依赖（database.native.ts 反过来要 wallet 的
// getWalletDataKey 来解密）。循环依赖在 Metro 下"通常能跑"，但一旦某天有人把
// 某个调用移到模块求值期，就会变成一个只在 release 包里复现的 undefined。
//
// 这个模块不 import 任何东西，两边都可以安全依赖它。
//
// 更一般的用途：任何"钱包被销毁时需要跟着清理"的模块（缓存、索引、临时文件）
// 都在自己模块里注册一次，不必让 wallet.ts 知道它们的存在。

type Hook = () => void | Promise<void>;

const deleteHooks = new Set<Hook>();

/** 注册"钱包被删除时"的清理动作。返回取消注册函数。 */
export function onWalletDeleted(hook: Hook): () => void {
  deleteHooks.add(hook);
  return () => {
    deleteHooks.delete(hook);
  };
}

/**
 * 依次执行全部清理钩子。**单个钩子失败不影响其余** ——
 * 删除钱包这类操作必须尽最大努力完成，不能因为某个缓存清不掉就中途放弃，
 * 留下一半数据在设备上。
 */
export async function runWalletDeletedHooks(
  onError: (err: unknown) => void = () => {},
): Promise<void> {
  for (const hook of deleteHooks) {
    try {
      await hook();
    } catch (err) {
      onError(err);
    }
  }
}
