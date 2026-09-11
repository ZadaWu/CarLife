/**
 * `literal` 里不许出现的结论词（施工单 M71-02，ACR-024）。
 *
 * 观察层提示词第 5 条铁律的机器版。它拦的不是脏话，是**解读**：「故障」「正常」「可以」
 * 这些词一出现，字面描述就变成了判断。命中时不整体失败——该项 `literal` 置空、
 * `undeterminable` 加 `elements_detail`，观察照常进链路（M71-02 任务 3）。
 *
 * 评测 runner（`evals/vision-observe/lib.ts`）与这里必须是同一份正则——评测与生产同一把尺子。
 */

export const FORBIDDEN_LITERAL = /故障|损坏|异常|正常|危险|安全|可以|建议|需要|可能|应该|表示|意味/;

export function violatesForbidden(literal: string): boolean {
  return FORBIDDEN_LITERAL.test(literal);
}
