/**
 * 标题后的问号：把"为什么这么设计"收进 hover / 聚焦才出现的浮层。
 *
 * # 为什么是收起而不是删掉
 *
 * 这些说明是本仓最值钱的东西——它们记的是踩过的坑与判据（"画成实线就成了
 * 编排层会路由到旁路"）。删掉等于把教训扔了。但**第一次读**与**第一百次看**
 * 需要的信息量完全不同：常来的人要的是那张图，说明每次都摊在图前面，
 * 就成了每次都要跳过的一段。收进问号后，两种人各取所需。
 *
 * # 为什么不用 title 属性
 *
 * 原生 `title` 有三个问题：延迟约 1 秒才出现、不能换行排版、
 * **触屏与键盘用户根本看不到**。这里用 `:hover` + `:focus-visible` 双触发，
 * 键盘 Tab 到问号也能看。
 *
 * # 纯 CSS 显隐
 *
 * 不挂 JS 状态：一页上有十几个问号，各自一个 useState 是白付的重渲染成本，
 * 而 CSS 的 :hover/:focus 本来就能表达"现在指着谁"。
 */

import type { ReactNode } from "react";

export function Hint({
  children,
  label = "查看说明",
}: {
  children: ReactNode;
  /** 无障碍名称。默认够用；同一页有多个同名问号时传具体的。 */
  label?: string;
}): JSX.Element {
  return (
    <span className="hint">
      {/*
        `type="button"` 不能省：本组件常落在表单/可点区域里，
        默认的 submit 会让点一下问号变成提交一次。
      */}
      <button type="button" className="hint-dot" aria-label={label}>
        ?
      </button>
      {/* role=note：它是补充说明，不是对话框——读屏不该把它念成需要关闭的东西 */}
      <span className="hint-pop" role="note">
        {children}
      </span>
    </span>
  );
}
