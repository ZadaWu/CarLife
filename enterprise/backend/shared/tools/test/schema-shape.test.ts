/**
 * 工具入参 schema 的形状约束。
 *
 * 这条守的是一个**症状与病因完全不搭边**的缺陷：
 * `calendar` 的 schema 曾经是 `z.discriminatedUnion`，生成的 JSON Schema 顶层是
 * `{anyOf: [...]}`，没有 `type: "object"`。注册工具表时被上游拒掉，
 * 后果是**持有它的 Agent 整个哑掉**——trip 与 ownership 问什么都回空字符串，
 * 而 supervisor / service / buying / cabin 一切正常，且没有任何报错。
 *
 * 排查这种问题的时间成本极高：现象指向 ACP、pi、模型、网络，唯独指不到 schema 的形状。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { TOOL_REGISTRY, describeForPi, assertObjectSchema, type AgentName } from "../src/registry";

const AGENTS: AgentName[] = ["supervisor", "trip", "ownership", "service", "buying", "cabin"];

describe("每个工具的顶层入参 schema 都必须是 object", () => {
  for (const t of TOOL_REGISTRY) {
    it(`${t.name}`, () => {
      const json = zodToJsonSchema(t.schema, { target: "jsonSchema7" }) as Record<string, unknown>;
      assert.equal(json.type, "object", `${t.name} 顶层是 ${JSON.stringify(Object.keys(json))}`);
    });
  }
});

describe("六个 Agent 的工具表都能被取出来", () => {
  for (const agent of AGENTS) {
    it(`${agent} 的工具表不抛错`, () => {
      // 取工具表时就炸，好过等到"这个 Agent 问什么都回空"才发现。
      assert.doesNotThrow(() => describeForPi(agent));
    });
  }
});

describe("assertObjectSchema", () => {
  it("**union 会被挡住**——这正是 calendar 踩过的那一脚", () => {
    const bad = zodToJsonSchema(
      z.discriminatedUnion("op", [z.object({ op: z.literal("a") }), z.object({ op: z.literal("b") })]),
      { target: "jsonSchema7" },
    );
    assert.throws(() => assertObjectSchema("demo", bad), /顶层 schema 必须是 object/);
  });

  it("扁平对象 + refine 通过——多态入参的正确写法", () => {
    const good = zodToJsonSchema(
      z.object({ op: z.enum(["a", "b"]), x: z.string().optional() }).refine(() => true),
      { target: "jsonSchema7" },
    );
    assert.doesNotThrow(() => assertObjectSchema("demo", good));
  });

  it("错误信息要指出怎么改，不是只说不合法", () => {
    const bad = zodToJsonSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), {
      target: "jsonSchema7",
    });
    assert.throws(() => assertObjectSchema("demo", bad), /扁平对象.*refine/);
  });
});
