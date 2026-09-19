/**
 * 上车声明这一步的在飞闸（M50-01 的漏网之鱼，2026-09-12）。
 *
 * # 病灶
 *
 * M50-01 给 `App.tsx` 的引导加了闸，M50-02 又把引导改成"只复用不新建"——
 * 于是**车机在启动时唯一还会建出会话的地方，是这道门**，而它一直没有闸。
 * `BoardingGate` 的挂载 effect 里 `probe()` 走到"已保存的声明 → 直接续用"，
 * 末尾发一次 `create_session_as`；StrictMode 把 effect 跑成
 * effect → cleanup → effect，于是**每次端启动建两个会话，用掉一个、丢掉一个**。
 *
 * 2026-09-12 读 dev 库（demo-user 5295 条会话里 775 条零消息）：最近 12 小时的
 * 零消息会话按「同一 device_id + 同一秒」聚簇，**基本单元恰好是 2**，
 * 更大的簇（9 / 6 / 4）是同一分钟里反复重载各自成对。两个车机 device id
 * 各自成对，没有一簇是跨设备凑出来的——所以它不是"两个客户端各建一条"，
 * 是单个进程里一个 effect 跑了两遍。
 *
 * # 两道闸，各挡一条路
 *
 * 两条路都会走到 `create_session_as`，而它们由**不同的 effect** 触发，
 * 组件状态（`busy` / `autoTried`）挡不住任何一条——StrictMode 的两次调用
 * 背靠背发生在同一个 commit 里，第二次读到的还是更新前的那份状态：
 *
 *  1. `probe()` 的"续用已保存的声明"——闸在 `INFLIGHT_BOARDING_PROBE`，挡在进入处；
 *  2. `declare()`（手点成员、访客、以及 `AUTO_DECLARE_OWNER` 替用户点车主）——
 *     闸在这里，按声明的人分键。
 *
 * # 为什么单独一个模块
 *
 * 闸必须是**模块级**的：组件被卸载又挂回来时（StrictMode、以及会话过期后
 * `onNeedBoarding` 把门挂回来），组件内的 ref/state 已经重来一遍，只有模块级的
 * Map 还在。顺带把它从 `BoardingGate.tsx` 里摘出来，这样"同一次挂载只建一个会话"
 * 这条能用真调用测（本包没有 jsdom，组件渲染不了）。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { createInflight, INFLIGHT_BOARDING_PROBE, INFLIGHT_DECLARE } from "../../data/inflight";

/** 服务端对 `POST /v1/session` 的应答（车机形态，带声明）。 */
export interface DeclaredSession {
  sessionId: string;
  guest: boolean;
}

/** 只用到 `create_session_as` 这一条，测试替身好写。 */
export type DeclareInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<string>;

const boardingInflight = createInflight();

/**
 * 建会话并声明"现在是谁在用"，**并发的两次合并成一次**。
 *
 * `activeUserId` 为 `null` = 显式声明访客（不是"忘了传"，见 `create_session_as` 的注释）。
 * 不是缓存：settle 之后就释放，串行的两次调用照常各建一个会话——
 * 「更换使用人」之后重新声明必须真的换一个会话。
 */
export function declareSession(
  activeUserId: string | null,
  invoke: DeclareInvoke = tauriInvoke as DeclareInvoke,
): Promise<DeclaredSession> {
  return boardingInflight.run(`${INFLIGHT_DECLARE}:${activeUserId ?? "__guest__"}`, async () => {
    const raw = await invoke("create_session_as", { activeUserId });
    return JSON.parse(raw) as DeclaredSession;
  });
}

/**
 * 整段上车探测走同一道闸，**挡在进入处**。
 *
 * 挡在里面那句 `create_session_as` 上不够：两次运行走的是同一串 await
 * （`device_role` → `bound_vin` → `boarding_declared`），先跑的那次若在后跑的那次
 * 到达之前就拿到了 201，闸已经释放，第二次照样建一个。实测两条记录相差 2~60ms，
 * 而一次 `POST /v1/session` 未必比这更慢——那是个会输的赛跑。
 */
export function probeBoardingOnce<T>(fn: () => Promise<T>): Promise<T> {
  return boardingInflight.run(INFLIGHT_BOARDING_PROBE, fn);
}

/** 这两道闸此刻在飞吗。只给测试与诊断用。 */
export const boardingBusy = (key: string): boolean => boardingInflight.busy(key);
