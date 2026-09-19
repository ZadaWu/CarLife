/**
 * 垫片：实现已搬进 `@carlife/acp`（施工单 M85-09 步 2，变更单 ACR-035）。
 *
 * # 为什么留着这个文件而不是改掉调用点
 *
 * 本单的红线是**行为零变化**，而"零变化"要能被回归证明——
 * 证明方式就是调用点与测试**逐字不动**。改了任何一处，
 * 回归绿就不再说明"搬家没搬坏"，只说明"改完之后也是绿的"。
 *
 * 所以这五个旧路径全部掏空成 re-export，导出符号一字不差。
 * 回滚也靠它：`git revert` 掉搬家的那个 commit，import 立刻回到旧实现，
 * 不需要动任何调用点。
 */

export { splitThinkBursts, THINK_GAP_MS, type ThinkBurst, type ThoughtTick } from "@carlife/acp";
