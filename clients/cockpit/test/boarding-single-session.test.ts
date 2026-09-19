/**
 * [F-56-07][AC-56-7] 上车声明：**同一次挂载只建一个会话**（M50-01 的漏网之鱼，2026-09-12）。
 *
 * # 它守的是什么
 *
 * M50-02 之后，车机在启动时唯一会建出会话的地方是上车声明这道门，
 * 而 M50-01 的在飞闸只加在了 `App.tsx` 的引导上——这道门一直没有闸。
 * StrictMode 把挂载 effect 跑成 effect → cleanup → effect，于是每次端启动
 * `create_session_as` 发两次：**用掉一个、丢掉一个**，后者永远零消息
 * （服务端是懒关闭，没人再访问它就永远不落 `closed_at`）。
 *
 * 2026-09-12 读 dev 库：最近 12 小时的零消息会话按「同一 device_id + 同一秒」
 * 聚簇，基本单元恰好是 2，两个车机 device id 各自成对——是一个 effect 跑了两遍，
 * 不是两个客户端各建一条。
 *
 * # 为什么这么测
 *
 * 本包没有 jsdom，组件渲染不了（与 account-events.test.ts 同一处境）。
 * 所以闸被摘成了 `declareSession.ts` 这个模块：前半段用真调用测行为
 * （并发两次只发一次、串行两次照常各发一次、失败也释放），
 * 后半段读源码钉住 `BoardingGate` 确实走了这道闸——
 * 绕过去重新写一句裸 `invoke("create_session_as")` 是编得过也跑得起来的。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { declareSession, probeBoardingOnce, type DeclareInvoke } from "../src/features/auth/declareSession";
import { INFLIGHT_BOARDING_PROBE, INFLIGHT_DECLARE } from "../src/data/inflight";

const SRC = readFileSync(
  new URL("../src/features/auth/BoardingGate.tsx", import.meta.url),
  "utf8",
);
/** 去掉注释：断言的对象必须是会真的跑起来的代码，不是解释它的那段话。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 记下每一次 `create_session_as`，每次回一个新 sid——合并没生效时两次的 sid 不同。 */
function fakeGateway(delayMs = 5) {
  const calls: Array<Record<string, unknown> | undefined> = [];
  let n = 0;
  const invoke: DeclareInvoke = async (cmd, args) => {
    assert.equal(cmd, "create_session_as");
    calls.push(args);
    n += 1;
    const sid = `sess-${n}`;
    await new Promise((r) => setTimeout(r, delayMs));
    return JSON.stringify({ sessionId: sid, guest: args?.activeUserId == null });
  };
  return { calls, invoke };
}

describe("[F-56-07][AC-56-7] 上车声明只建一个会话", () => {
  it("**同一次挂载的两次声明合并成一次**——StrictMode 的 effect → cleanup → effect", async () => {
    const { calls, invoke } = fakeGateway();
    const [a, b] = await Promise.all([
      declareSession("owner-1", invoke),
      declareSession("owner-1", invoke),
    ]);
    assert.equal(calls.length, 1, `建了 ${calls.length} 个会话——闸没挡住，多出来的那个永远零消息`);
    assert.equal(a.sessionId, b.sessionId, "两次运行必须拿到同一个 sid，否则第二次会自己再建一个");
    assert.equal(a, b, "返回的应当是同一个引用：各自 setState 时不该变成两份");
  });

  it("整段探测也合并：闸挡在**进入处**，不是挡在里面那句 create_session_as 上", async () => {
    const { calls, invoke } = fakeGateway();
    /*
     * 复刻真实的 await 串：两次运行都要先走 device_role → bound_vin → boarding_declared
     * 才到建会话。把闸只挡在建会话那一句上，先跑的那次会在后跑的那次到达之前就 settle，
     * 于是照样建两个——所以这里的 fake 探测**故意**在建会话之前 await 三次。
     */
    let entered = 0;
    const probe = async () => {
      entered += 1;
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      return declareSession("owner-1", invoke);
    };
    const [a, b] = await Promise.all([probeBoardingOnce(probe), probeBoardingOnce(probe)]);
    assert.equal(entered, 1, "第二次运行必须在进入处就被合并掉，不该把整段探测再跑一遍");
    assert.equal(calls.length, 1);
    assert.equal(a.sessionId, b.sessionId);
  });

  it("**不是缓存**：串行的两次照常各建一个——「更换使用人」必须真的换会话", async () => {
    const { calls, invoke } = fakeGateway(0);
    const a = await declareSession("owner-1", invoke);
    const b = await declareSession("owner-1", invoke);
    assert.equal(calls.length, 2);
    assert.notEqual(a.sessionId, b.sessionId);
  });

  it("**失败也释放**：网关没起来的那一次不能变成「永远建不出会话」", async () => {
    let n = 0;
    const invoke: DeclareInvoke = async () => {
      n += 1;
      if (n === 1) throw new Error("gateway down");
      return JSON.stringify({ sessionId: "sess-ok", guest: false });
    };
    await assert.rejects(() => declareSession("owner-1", invoke));
    const ok = await declareSession("owner-1", invoke);
    assert.equal(ok.sessionId, "sess-ok");
  });

  it("按声明的人分键：访客与车主是两个诉求，不能被合并成一个身份", async () => {
    const { calls, invoke } = fakeGateway();
    const [owner, guest] = await Promise.all([
      declareSession("owner-1", invoke),
      declareSession(null, invoke),
    ]);
    assert.equal(calls.length, 2, "合并了的话，后到的那次会拿到别人的身份");
    assert.equal(owner.guest, false);
    assert.equal(guest.guest, true);
    assert.deepEqual(calls, [{ activeUserId: "owner-1" }, { activeUserId: null }]);
  });

  it("BoardingGate 的两条路都走这道闸，没有第二份裸 create_session_as", () => {
    assert.match(
      CODE,
      /import \{ declareSession, probeBoardingOnce \} from "\.\/declareSession"/,
      "闸必须是模块级的：组件卸载又挂回来时，组件内的 state/ref 已经重来一遍",
    );
    assert.ok(
      !/invoke[^\n]*"create_session_as"/.test(CODE),
      "门里不许再有裸的 create_session_as——它绕过闸，编得过也跑得起来，只是每次启动多建一个空会话",
    );
    assert.match(CODE, /onDeclared\(await declareSession\(saved\.activeUserId \?\? null\)\)/, "续用已保存声明的那条路");
    assert.match(CODE, /onDeclared\(await declareSession\(userId\)\)/, "手点成员／访客／自动车主那条路");
    assert.match(
      CODE,
      /const probe = useCallback\(\(\) => probeBoardingOnce\(probeOnce\)/,
      "挂载 effect 调的那个 probe 必须是包过闸的那层——闸要挡在进入处",
    );
  });

  it("闸的键是常量，不是各写一份字面量", () => {
    assert.equal(INFLIGHT_BOARDING_PROBE, "boarding:probe");
    assert.equal(INFLIGHT_DECLARE, "session:declare");
  });
});
