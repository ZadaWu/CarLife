/**
 * e2e / smoke 脚本的端口工具（施工单 M46-01）。
 *
 * # 为什么值得一个共享模块
 *
 * 2026-08-29 的一次追查：`e2e:m3` 报了三条「admin token → unauthorized」，
 * 人照着这条线索查了鉴权链路、查了数据库切换、查了 token 传递——**全都没问题**。
 * 真正的原因是上一轮 e2e 留下的孤儿 agent-runtime 还占着端口：
 * 本轮 spawn 的网关 EADDRINUSE 起不来，脚本不检查、继续发请求，
 * 请求落到那个残留进程上，而它的 env 里根本没有 `CARLIFE_ADMIN_TOKEN`。
 *
 * 清空端口后同一份代码 18 条断言全过。**脚本本身一直是好的**，
 * 但它报出的错误把人指向了完全错误的方向，还害得这条 e2e 被当成「既有故障」
 * 排除出 CI 门禁。
 *
 * 所以预检的价值不在"提前发现端口被占"——那只是手段；在于**不让一个环境问题
 * 伪装成业务故障**。同理，它必须是硬失败：警告会淹没在几十行启动日志里。
 *
 * # 为什么不自动杀掉占用进程
 *
 * 杀进程不可逆，而占用者完全可能是开发者自己正在用的服务。预检只负责说清楚
 * "谁占着、怎么清"，处置交给人。
 */

import { execFile, type ChildProcess } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);

/**
 * 端口空不空。**用 `net.connect` 试探而不是 `lsof`**：后者在 Linux 容器里未必装，
 * 而这套脚本要在 CI 的 ubuntu runner 上跑。
 *
 * 连上 = 有人听 = 不空闲；连不上或超时 = 空闲。
 */
export async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (free: boolean) => {
      sock.destroy();
      resolve(free);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    setTimeout(() => done(true), 500);
  });
}

/**
 * 尽力问出占用者是谁。**拿不到就返回 undefined，不抛**——
 * `lsof` 在 Linux 容器里常常没有，但"拿不到 PID"绝不能降级成"那就放行"。
 */
async function occupant(port: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`]);
    const pid = stdout.trim().split("\n")[0];
    if (!pid) return undefined;
    try {
      const { stdout: cmd } = await execFileAsync("ps", [
        "-o",
        "command=",
        "-p",
        pid,
      ]);
      return `PID ${pid}：${cmd.trim().slice(0, 120)}`;
    } catch {
      return `PID ${pid}`;
    }
  } catch {
    return undefined;
  }
}

/**
 * spawn 之前调它。任一端口被占即抛，错误信息里点名端口、用途与占用者。
 *
 * **必须在 spawn 之前**：放在之后就成了"起失败了才发现"，而 spawn 失败是异步的、
 * 脚本可能已经往下走——那正是本次事故的形态。
 */
export async function assertPortsFree(
  ports: ReadonlyArray<[number, string]>,
): Promise<void> {
  const busy: string[] = [];
  for (const [port, label] of ports) {
    if (await portFree(port)) continue;
    const who = await occupant(port);
    busy.push(
      `  ${port}（${label}）被占用——${who ?? "拿不到占用进程信息（本机没有 lsof？）"}`,
    );
  }
  if (busy.length === 0) return;

  throw new Error(
    `端口被占，本次不启动：\n${busy.join("\n")}\n\n` +
      `多半是上一轮 e2e 留下的孤儿进程。**不会自动杀**——占用者也可能是你正在用的服务。\n` +
      `确认无关后清理：lsof -ti :${ports.map(([p]) => p).join(" -ti :")} | xargs kill\n` +
      `（不预检的话，请求会打到那个残留进程上，报出看起来像业务故障的假错误——` +
      `2026-08-29 就是这么白查了两小时鉴权，见 M46-01。）`,
  );
}

/** 等端口释放；到点还占着就抛——**静默留下孤儿正是要修的病**。 */
export async function waitPortFree(
  port: number,
  label: string,
  tries = 40,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await portFree(port)) return;
    await sleep(250);
  }
  throw new Error(
    `${label}：端口 ${port} 在 ${(tries * 250) / 1000}s 后仍被占用——进程没收干净`,
  );
}

/** 等端口被听起来（新进程真的起来了）。 */
export async function waitPortBusy(
  port: number,
  label: string,
  tries = 60,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (!(await portFree(port))) return;
    await sleep(250);
  }
  throw new Error(
    `${label}：端口 ${port} 在 ${(tries * 250) / 1000}s 后仍无人监听`,
  );
}

/**
 * 杀掉整个进程组。
 *
 * # 为什么不能只 `child.kill()`
 *
 * `npx tsx src/index.ts` 起的是**三层**：npx 壳 → tsx → 真正 listen 的 node。
 * `child.kill()` 只打到最外层那个 npx，最里层被系统收养后**继续占着端口**。
 * 这与内部开发指引 里「监护层已死、端口照常应答、改代码却不生效」是同一形态的坑。
 *
 * 前提是 spawn 时带了 `detached: true`（子进程自成进程组），
 * `process.kill(-pid)` 才能把整组一锅端。
 *
 * ⚠️ `detached` 的代价：Ctrl-C 不再自动传给子进程，所以**收尾必须自己动手**，
 * 否则手动中断留下的孤儿比不加还多。
 */
export function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // 组已经没了；再对单个 pid 补一刀，两者都失败就是真的已经退了
    try {
      child.kill(signal);
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 收尾：杀掉自己 spawn 的进程并**等端口真的释放**。
 *
 * 进程收到 SIGTERM 到端口释放之间有窗口期，不等的话下一条命令仍会撞上——
 * CI 里 `e2e:m2-02` → `e2e:m3` 背靠背跑就是这么红的（M46-02）。
 *
 * **故意不抛**：测试此刻已经跑完了，收尾不干净不该把绿判成红。
 * 但必须 `warn` 出来——静默才是这一串工单一直在修的病。
 */
export async function shutdownSpawned(
  procs: ReadonlyArray<ChildProcess>,
  ports: ReadonlyArray<number>,
): Promise<void> {
  for (const p of procs) killTree(p, "SIGTERM");
  for (const port of ports) {
    if (await waitPortFreeQuiet(port, 24)) continue; // 6s
    for (const p of procs) killTree(p, "SIGKILL");
    if (await waitPortFreeQuiet(port, 12)) continue; // 再 3s
    console.warn(
      `⚠ 收尾：端口 ${port} 仍被占用——下一条 e2e 会被预检拦下。` +
        `手动清理：lsof -ti :${port} | xargs kill`,
    );
  }
}

/** 等端口释放，超时返回 false 而不抛（收尾场景不该因此失败）。 */
async function waitPortFreeQuiet(
  port: number,
  tries: number,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await portFree(port)) return true;
    await sleep(250);
  }
  return false;
}
