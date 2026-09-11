/**
 * 读车机屏上的「警报」列表（施工单 M80-10）。
 *
 * # 与图标观察是两件事
 *
 * 图标观察（`observe.ts`）回答"仪表上亮着哪些灯"——形状与颜色，名称来自手册图标目录。
 * 警报页回答的是另一种照片：车主点开 控制 › 服务 › 警报 后拍下的**一张列表**，
 * 每行是一个代码（`VCFRONT_a004`）加一两句厂商写好的话。那上面没有图标可认，
 * 观察层过去在这种照片上返回零项，整条链路等于没看见。
 *
 * # 仍然只记录，不解释
 *
 * 代码、标题、副标题、图标颜色、在「活动警报」还是「今天稍早时」——**全部是屏幕上的字**，
 * 照抄不是判断。含义与措施来自知识库里的官方警报代码表（`kb:alerts` 抓的那两份），
 * 与"图标名称只能来自图标目录"同一条纪律：模型碰不到结论。
 *
 * # 代码是检索的钥匙，所以格式要卡死
 *
 * `VCFRONT_a004` 这种形状（前缀大写 + 下划线 + a/w + 数字）是官方代码的固定形态。
 * schema 用正则卡住它：模型把 `DI_a223` 抄成 `Dl_a223` 或 `DI a223` 都会被拒收重来一次，
 * 而**抄错一个字符，检索就查不到那一条**——比没抄到更糟，因为下游会以为查过了。
 */

import { z } from "zod";

/** 官方警报代码的形态：`APP_w009` / `VCFRONT_a004` / `DI_a223`。 */
export const ALERT_CODE_RE = /^[A-Z][A-Z0-9]*_[aw][0-9]+$/;

export const AlertEntrySchema = z
  .object({
    /** 屏幕上那一串代码，原样。认不全就不要这一项——见文件头。 */
    code: z.string().regex(ALERT_CODE_RE, "不是官方警报代码的形态"),
    /** 代码下面那一行粗体标题，原样抄。 */
    title: z.string().max(60).default(""),
    /** 标题下面那行小字（厂商给的一句处置提示），原样抄；没有就空。 */
    subtitle: z.string().max(120).default(""),
    /** 行首图标的颜色：红 = 三角感叹号，灰 = 已过去的，蓝/绿 = 信息类圆圈 i。 */
    iconColor: z.enum(["red", "gray", "blue", "green", "unknown"]).default("unknown"),
    /** 在「活动警报」分组里（true）还是「今天稍早时 / 昨天」这类历史分组里（false）。 */
    active: z.boolean().default(true),
    /** 历史分组里那行时间戳，原样（如 `16:12`、`2026年8月30日 17:43`）；没有就空。 */
    at: z.string().max(40).default(""),
  })
  .strict();
export type AlertEntry = z.infer<typeof AlertEntrySchema>;

export const AlertReadingSchema = z
  .object({
    /** 这张照片是不是警报列表页。不是的话 `entries` 必须为空。 */
    isAlertScreen: z.boolean(),
    entries: z.array(AlertEntrySchema).max(24).default([]),
    /** 明确显示「无活动警报」时为 true——这与"没读到"完全不同，下游话术不一样。 */
    noActiveAlerts: z.boolean().default(false),
    /** 读不清的地方，人话，≤ 60 字；不要写判断。 */
    notes: z.array(z.string().max(60)).max(4).default([]),
  })
  .strict();
export type AlertReading = z.infer<typeof AlertReadingSchema>;

export const EMPTY_ALERT_READING: AlertReading = { isAlertScreen: false, entries: [], noActiveAlerts: false, notes: [] };

export const ALERTS_PROMPT = `你是车机屏幕的「文字抄写员」。任务是把「警报」列表页上的文字原样抄成 JSON。
你不是助手、不是技师，不解释、不判断、不建议、不补全。

## 这是哪种照片
特斯拉车机的 控制 › 服务 › 警报 页面：分「活动警报」与「今天稍早时 / 昨天 / 具体日期」等分组，
每条形如：
    VCFRONT_a004
    自适应大灯功能不可用
    使用远光灯按钮手动控制
第一行是代码，第二行是标题，第三行（可能没有）是小字提示；左侧有一个图标（红色三角感叹号 / 灰色 / 蓝绿色圆圈 i）。

**不是这种页面**（仪表盘、充电界面、导航、行车画面、与车无关的截图）→ isAlertScreen: false，entries 留空。
页面上写着「无活动警报」→ noActiveAlerts: true；它下面历史分组里的条目照抄，active 填 false。

## 铁律
1. **代码必须逐字符抄准**，形态是「大写前缀_小写a或w+数字」，如 APP_w009、DI_a223、VCFRONT_a552。
   看不清哪怕一个字符，就**整条不要**，并在 notes 里写一句「有一条代码没看清」。宁可少一条，不能抄错一条。
2. 标题与小字**原样抄**，不改写、不缩写、不翻译、不补标点。看不全就抄看得见的部分。
3. 不要写含义、原因、严重程度、处理建议。这些不归你。
4. 被手指、反光、弹窗挡住的条目跳过，在 notes 里说明。
5. 只输出一个 JSON 对象，不要 markdown 围栏，不要任何解释文字。

## 输出结构
{
  "isAlertScreen": true | false,
  "noActiveAlerts": true | false,
  "entries": [
    {
      "code": "VCFRONT_a004",
      "title": "自适应大灯功能不可用",
      "subtitle": "使用远光灯按钮手动控制",
      "iconColor": "red" | "gray" | "blue" | "green" | "unknown",
      "active": true | false,
      "at": "16:12"
    }
  ],
  "notes": ["<≤30字，只说没看清什么>"]
}`;
