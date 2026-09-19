/**
 * `@carlife/research`：研究面的**纯函数库**（施工单 M82-01）。
 *
 * # 零 IO、零依赖，这是它的全部价值
 *
 * 分析单位怎么切、哪些证据不能采、四道门怎么判、置信怎么算、机会怎么排序——
 * 这些是研究面里**唯一需要被反复复核的东西**，也是唯一能在几毫秒内跑完
 * 一整套单测的东西。把它们和数据库、LLM、HTTP 放在一起，复核就变成了
 * "起个库、连个模型、跑二十分钟"，于是没人复核。
 *
 * 所以本包不 import `@carlife/db` / `@carlife/guardrails` / `ai` / `@langchain/*`。
 * `check:arch` 的 `research-pure` 一条守这件事。
 *
 * 唯一的例外是 `node:crypto`（sha256 指纹）——它是纯计算，不碰外界。
 */

export * from "./types";
export * from "./passport";
export * from "./fingerprint";
export * from "./unitize";
export * from "./screen";
export * from "./population";
export * from "./suppression";
export * from "./gates";
export * from "./confidence";
export * from "./ods";
export * from "./agreement";
export * from "./system-events";
export * from "./capabilities";
export * from "./agent-note";
export * from "./red-team";
