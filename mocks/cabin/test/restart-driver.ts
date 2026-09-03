/**
 * 「重启」的另一半：被 `persistence.test.ts` 用子进程跑两次的驱动脚本。
 *
 * 落盘要证明的事情只有真的换一个进程才算数——同一进程里再 `import` 一次，
 * 模块缓存与已经填好的 Map 都还在，测出来的是假绿。所以这里是一个独立入口：
 * 第一次 `write` 造车改设置，进程退出（触发 flush）；第二次 `read` 从零启动，
 * 看它能不能把同一辆车、同一个 id、同一段流水认回来。
 *
 * 文件名不带 `.test.ts`，不会被 `node --test test/*.test.ts` 当成用例收走。
 */

import { applyOps, createVehicle, getVehicle, newVehicleId } from "../src/state";

/**
 * 结果带前缀单独打一行。
 *
 * `state.ts` 启动时会往 stdout 打一行「已从 … 恢复 N 辆车」——那是服务该有的
 * 启动日志，不该为了让测试好解析而改掉它。所以由这一侧加标记，测试取带标记的那行。
 */
const MARK = "__RESULT__";
function emit(value: unknown): void {
  process.stdout.write(`\n${MARK}${JSON.stringify(value)}\n`);
}

const [action, arg] = process.argv.slice(2);

if (action === "write") {
  const id = newVehicleId();
  const record = createVehicle(id, "Model Y");
  applyOps(record, [{ domain: "climate", zone: "driver", set: { tempC: 25 } }]);
  applyOps(record, [{ domain: "media", zone: "cabin", set: { source: "kids", contentTag: "儿歌", volumeLimit: 35 } }]);
  emit({ id, changes: record.changes.length });
} else if (action === "read") {
  const record = getVehicle(arg!);
  emit(
    record
      ? {
          found: true,
          model: record.model,
          tempC: record.state.climate.driver?.tempC,
          media: record.state.media.cabin,
          changes: record.changes.length,
          maxSeq: Math.max(0, ...record.changes.map((c) => c.seq)),
          nextVehicleId: newVehicleId(),
        }
      : { found: false },
  );
} else {
  throw new Error(`unknown action: ${action}`);
}
