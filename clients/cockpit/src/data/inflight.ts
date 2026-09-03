/**
 * 在飞闸（施工单 M50-01）——**同一件事同时被要求两次时，只做一次**。
 *
 * # 它治的是一个真实且一直在发生的病
 *
 * 车机与手机端每启动一次就建**两个**会话，用掉一个、丢掉一个。
 * 2026-08-31 读 dev 库：1003 个会话里 73 个零消息，按「与上一条间隔 <100ms」聚类，
 * **每一簇恰好 2 个，从来没有 3 个**——`sess-bd8b22c0-0d5`（42 条消息）与
 * `sess-ba9cea3b-7db`（0 条）是同一毫秒建出来的一对。
 *
 * 成因是两件事凑在一起：
 *
 *   1. 两个端都渲染在 `<React.StrictMode>` 里，而 React 18 的**开发构建**
 *      会把每个 effect 跑成 effect → cleanup → effect（`target/debug/*` 连的是
 *      vite dev server，吃的正是 dev 构建，所以日常看到的就是它）；
 *   2. 引导流程从「读 localStorage 的旧 sid」到「写回新 sid」之间全是 await，
 *      **中间没有任何互斥**——两次运行都读到同一个旧值、都判"不可复用"、各建一个。
 *
 * 后完成的那个覆盖存储，先建的那个再也没人碰；而服务端的会话过期是**懒关闭**
 * （只在下次访问时才落 `closed_at`），于是它永远零消息、永远显示成"活着"。
 *
 * # 为什么是"共享 promise"而不是"丢弃第二次"
 *
 * `App.tsx` 里原本给「新建对话」按钮加的是丢弃式的闸（在飞就 `return`）。
 * 那对点击够用，对 StrictMode 不够：第二次运行**需要拿到 sid** 才能起流、绑哨兵。
 * 丢弃会让第二次运行拿到 undefined，于是它要么报错、要么自己再建一个。
 * 共享同一个 promise 则让两次运行拿到**同一个 sid**，行为与只跑一次完全一致。
 *
 * # 三条不变量
 *
 *   · **不是缓存**：settle 之后就释放，串行的两次调用照常各做一次；
 *   · **失败也释放**：否则"网关还没起来"那一次失败会变成"永远建不出会话"；
 *   · **按 key 隔离**：引导与「新建对话」是两件事，不该互相合并。
 */

export interface Inflight {
  /**
   * 同 key 有在飞的调用就返回**同一个 promise**，否则执行 `fn`。
   *
   * 返回值也是同一个引用——调用方各自 setState 时不会变成两份。
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 这个 key 此刻在飞吗。只给测试与诊断用。 */
  busy(key: string): boolean;
}

export function createInflight(): Inflight {
  const pending = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const running = pending.get(key);
      if (running) return running as Promise<T>;
      // `fn()` 抛同步异常时也要把 key 清掉，所以整段包在 try 之外用 finally 收尾。
      const p = (async () => fn())().finally(() => {
        // 只清掉自己那一次：慢的那次收尾时，新的一次可能已经在飞了。
        if (pending.get(key) === p) pending.delete(key);
      });
      pending.set(key, p);
      return p;
    },
    busy(key) {
      return pending.has(key);
    },
  };
}

/** 引导（复用或新建当前会话）。StrictMode 的两次运行合并在这里。 */
export const INFLIGHT_BOOTSTRAP = "session:bootstrap";
/** 显式新建一段对话（「新建对话」按钮、「退下」之后、会话过期重发）。 */
export const INFLIGHT_NEW_SESSION = "session:new";
