/**
 * 财务页的**防退化断言**。
 *
 * 这一页有三处判断错了也照样渲染得好好的，只是说的话不再是真的：
 *   ① 默认选中谁——选到一家查不了的，首屏是空表，看的人以为功能坏了；
 *   ② 空表格是哪一种空——"查不了"和"没花钱"合并成一句"暂无数据"就把线索抹了
 *      （记忆浏览页正是这么产生过一句谎话，见 memory-page.test.ts）；
 *   ③ 合计怎么算——把"金额未知"当 0 加进去，合计看起来精确却漏了一整笔。
 *
 * 所以判断逻辑抽在 model.ts，这里逐条钉住。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ageLabel,
  amountFallback,
  billsTotal,
  defaultAccountId,
  emptyKind,
  levelClass,
  showsAmount,
  type FinanceAccount,
  type FinanceBillPage,
} from "../src/pages/finance/model";

function account(over: Partial<FinanceAccount> & { id: string }): FinanceAccount {
  return {
    label: over.id,
    kind: "balance",
    status: "ok",
    exact: true,
    detail: [],
    consoleUrl: "",
    durationMs: 0,
    ...over,
  };
}

function page(over: Partial<FinanceBillPage> = {}): FinanceBillPage {
  return {
    accountId: "x",
    status: "ok",
    rows: [],
    coverage: "近 3 个账期",
    consoleUrl: "",
    durationMs: 0,
    ...over,
  };
}

describe("默认选中的账户", () => {
  it("跳过没有账单接口的，落在第一个查得了的上", () => {
    const accounts = [
      account({ id: "deepseek", billsSupported: false }),
      account({ id: "volcengine", billsSupported: true }),
      account({ id: "aliyun", billsSupported: true }),
    ];
    assert.equal(defaultAccountId(accounts), "volcengine");
  });

  it("一家都查不了时退回第一张卡，而不是留空", () => {
    assert.equal(defaultAccountId([account({ id: "deepseek" }), account({ id: "amap" })]), "deepseek");
  });

  it("没有账户时给 null，不抛", () => {
    assert.equal(defaultAccountId([]), null);
  });
});

describe("空表格的四种成因必须分得开", () => {
  it("「这家不给查」与「确实没花钱」是两回事", () => {
    assert.equal(emptyKind(page({ status: "unsupported" })), "unsupported");
    assert.equal(emptyKind(page({ status: "ok", rows: [] })), "none");
  });

  it("没配凭据与调用失败也各算各的", () => {
    assert.equal(emptyKind(page({ status: "unconfigured" })), "unconfigured");
    assert.equal(emptyKind(page({ status: "failed", error: "boom" })), "failed");
  });

  it("四种取值互不重叠——合并任意两种都会让这条红", () => {
    const kinds = (["ok", "unsupported", "unconfigured", "failed"] as const).map((s) =>
      emptyKind(page({ status: s })),
    );
    assert.equal(new Set(kinds).size, 4);
  });
});

describe("账单合计", () => {
  const rows = [
    { period: "2026-08", item: "语音合成", amount: 159.83, currency: "CNY" },
    { period: "2026-08", item: "对象存储", amount: 0, currency: "CNY" },
  ];

  it("按有金额的行求和", () => {
    const t = billsTotal(rows);
    assert.equal(t.total, 159.83);
    assert.equal(t.pricedCount, 2);
    assert.equal(t.unpricedCount, 0);
  });

  it("金额未知的行不当 0 加进去，另外计数说明", () => {
    const t = billsTotal([...rows, { period: "2026-08", item: "Starter 套餐", currency: "USD" }]);
    assert.equal(t.total, 159.83, "无金额的那行不得被当成 0 吞掉");
    assert.equal(t.pricedCount, 2);
    assert.equal(t.unpricedCount, 1);
    assert.equal(t.mixedCurrency, false, "无金额的行不参与币种判断");
  });

  it("币种混杂时标出来——加起来的数没有意义", () => {
    const t = billsTotal([rows[0], { period: "2026-08", item: "订阅", amount: 5, currency: "USD" }]);
    assert.equal(t.mixedCurrency, true);
  });

  it("全空时给 0 与默认币种，不抛", () => {
    assert.equal(billsTotal([]).total, 0);
    assert.equal(billsTotal([]).pricedCount, 0);
  });
});

describe("卡片：不确定的东西不许渲染成数字", () => {
  it("exact=false（高德）永远不显示金额", () => {
    assert.equal(showsAmount(account({ id: "amap", kind: "quota", exact: false, amount: 999 })), false);
    assert.equal(amountFallback(account({ id: "amap", kind: "quota", exact: false })), "余量不可查（见下）");
  });

  it("订阅制说的是「无余额口径」，不是「已读取」——后者会被当成页面坏了", () => {
    const a = account({ id: "ragflow", kind: "subscription", exact: true });
    assert.equal(showsAmount(a), false);
    assert.equal(amountFallback(a), "订阅制 · 无余额口径");
  });

  it("未配置与失败各说各的", () => {
    assert.equal(amountFallback(account({ id: "x", status: "unconfigured", exact: false })), "未配置凭据");
    assert.equal(amountFallback(account({ id: "x", status: "failed", exact: false })), "读取失败");
  });

  it("失败与 danger 走同一档红；未配置是灰不是红", () => {
    assert.equal(levelClass(account({ id: "x", status: "failed" })), "fin-card--danger");
    assert.equal(levelClass(account({ id: "x", level: "danger" })), "fin-card--danger");
    assert.equal(levelClass(account({ id: "x", status: "unconfigured" })), "fin-card--muted");
    assert.equal(levelClass(account({ id: "x", level: "warn" })), "fin-card--warn");
  });
});

describe("快照年龄标签", () => {
  const now = new Date("2026-08-26T12:00:00Z");

  it("按分钟/小时/天分档", () => {
    assert.equal(ageLabel("2026-08-26T11:59:30Z", now), "刚刚");
    assert.equal(ageLabel("2026-08-26T11:45:00Z", now), "15 分钟前");
    assert.equal(ageLabel("2026-08-26T09:00:00Z", now), "3 小时前");
    assert.equal(ageLabel("2026-08-24T12:00:00Z", now), "2 天前");
  });

  it("时间倒挂或解析失败按「刚刚」处理，不给人看负数", () => {
    assert.equal(ageLabel("2026-08-26T13:00:00Z", now), "刚刚");
    assert.equal(ageLabel("不是时间", now), "刚刚");
  });
});

describe("页面源码的防退化", () => {
  const raw = readFileSync(join(process.cwd(), "src/pages/finance/index.tsx"), "utf8");
  /*
   * 剥注释再扫。不剥的话这条规则会自伤——文件头那句
   * 「共用一句"暂无数据"等于把线索抹掉」正是我们希望多写的说明，
   * 扫到它就红了（check-arch-invariants 的 no-websocket 也踩过同一个坑）。
   */
  const src = raw
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  it("空态四支各自成文，没有被合并成一句「暂无数据」", () => {
    assert.ok(!/暂无数据/.test(src), "出现「暂无数据」说明四种空态又被合并了");
    for (const kind of ["unsupported", "unconfigured", "failed"]) {
      assert.ok(src.includes(`kind === "${kind}"`), `空态 ${kind} 的分支不见了`);
    }
  });

  it("账单是按需拉的，不是跟余额一起进首屏", () => {
    assert.ok(
      src.includes("/console/finance/bills/${selected}"),
      "账单请求应当依赖当前选中的账户",
    );
  });

  it("两段式加载：先秒开落盘快照，再等真实采集替换", () => {
    assert.ok(src.includes("/console/finance?stored=1"), "余额的 stored 快路径不见了");
    assert.ok(src.includes("?stored=1`"), "账单的 stored 快路径不见了");
    // stored 只许在画面还空着时应用——functional setState 是防"旧数据倒灌"的那道闸
    assert.ok(src.includes("setData((cur) => cur ?? snapshot)"), "stored 快照不得覆盖已到的采集结果");
    assert.ok(src.includes("setBills((cur) => cur ?? page)"), "stored 账单不得覆盖已到的采集结果");
  });
});
