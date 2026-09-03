/**
 * Guard 策略与止血开关路由（施工单 TD-03，FL-30 F-30-01/02/03）。
 *
 * `GET  /console/guard/policy`      当前策略 + 止血开关 + 变更历史
 * `POST /console/guard/policy`      写策略值
 * `POST /console/guard/kill`        写止血开关
 * `GET  /console/guard/disclaimer`  话术开关 + 文案 + 变更历史
 * `POST /console/guard/disclaimer`  写话术开关与文案
 * `GET  /console/guard/redlines`    **admin 独有**：红线只读展示
 *
 * # 分权：与 config.ts 正好相反
 *
 * `config.ts` 是 admin 独有（接入面：模型端点、API key）——让运营持有
 * "把审核指向任意端点"的能力等于给内容安全开后门。
 *
 * 本路由是**运营可写**（策略值、止血开关）：出事时要能立刻按下去，
 * 而"运营找不到管理员就按不下止血开关"是比越权更现实的风险。
 *
 * 红线（硬禁清单、capability 白名单）**两边都不可写**——它们不在
 * `guard_settings` 表里，压根没有落点。这里只对 admin 提供只读展示，
 * 让他能回答"到底哪些是永远不可改的"。ops 连看都不给：
 * 把一份"你改不了的清单"摆在运营面前，只会诱发绕过它的尝试。
 */

import { Router } from "express";
import type { Response } from "express";

/*
 * 网关引 `@carlife/guardrails` 只取**纯校验函数与默认值**。
 *
 * 这不越"网关不含业务逻辑"的界：`validatePolicy` 判的是策略值本身合不合法
 * （两侧不能同时 fail-open、至少启用一个分类），属于入参校验，
 * 与"跑管线"是两回事——本文件不 import 任何 `runInputPipeline` / `ContentGuard`。
 *
 * 放在网关而不是转一趟 agent-runtime：非法策略要在**写库之前**挡住，
 * 而写库发生在这一侧。多一跳只会让"库里已经是非法值"这个窗口变大。
 */
import { DEFAULT_POLICY, validatePolicy, type GuardPolicy } from "@carlife/guardrails";
import type { GuardSettingRepository, KillSwitch } from "@carlife/db";

import { requireRole, requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction } from "./audit";

/** 可被止血开关关停的 Agent 名——白名单校验，防止写进一个不存在的名字后毫无感觉。 */
const KNOWN_AGENTS = ["supervisor", "buying", "ownership", "trip", "cabin", "service"] as const;

export interface GuardPolicyDeps {
  settings: GuardSettingRepository;
  /** 硬禁清单的只读快照，由 agent-runtime 侧提供（红线在代码里，不在库里）。 */
  redlines: () => Promise<{ hardBlocks: string[]; capabilities: string[] }>;
  /** 改完立刻让 agent-runtime 的 TTL 缓存失效，否则最多要等 30s 才生效。 */
  invalidate: () => Promise<void>;
  /** 编译期默认话术与长度上限，由 agent-runtime 提供（业务规则在那边）。 */
  disclaimerDefaults: () => Promise<{ policy: unknown; text: unknown; maxChars: number }>;
  /** 话术校验，同样转发——网关不重写业务红线。 */
  validateDisclaimer: (body: { policy?: unknown; text?: unknown }) => Promise<{ error?: string }>;
}

export function createGuardPolicyRouter(deps: GuardPolicyDeps): Router {
  const router = Router();

  router.get(
    "/console/guard/policy",
    requireAnyRole(CONSOLE_READERS),
    async (_req: ConsoleRequest, res: Response) => {
      const [policy, kill, history] = await Promise.all([
        deps.settings.get<GuardPolicy>("policy"),
        deps.settings.get<KillSwitch>("kill_switch"),
        deps.settings.history("policy", 20),
      ]);
      res.json({
        // 从未写过时如实回落到默认并标注来源：界面上"默认值"与"运营设过同样的值"
        // 看起来一样，但前者意味着这套策略从没被人确认过。
        policy: policy?.value ?? DEFAULT_POLICY,
        policySource: policy ? "db" : "default",
        policyUpdatedBy: policy?.updatedBy,
        policyUpdatedAt: policy?.updatedAt,
        killSwitch: kill?.value ?? { agents: [], capabilities: [] },
        killUpdatedBy: kill?.updatedBy,
        history,
      });
    },
  );

  router.post(
    "/console/guard/policy",
    auditAction("guard.policy.update"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const policy = (req.body ?? {}) as GuardPolicy;

      // 形状校验在语义校验之前：validatePolicy 假定字段都在，
      // 少一个分类开关时它会把 undefined 当成"未关闭"而放过去。
      if (!policy?.categories || typeof policy.categories !== "object") {
        res.status(400).json({ error: "invalid_body", detail: "缺少 categories" });
        return;
      }
      for (const key of Object.keys(DEFAULT_POLICY.categories)) {
        if (typeof (policy.categories as unknown as Record<string, unknown>)[key] !== "boolean") {
          res.status(400).json({ error: "invalid_body", detail: `分类开关 ${key} 缺失或非布尔` });
          return;
        }
      }

      const problem = validatePolicy(policy);
      if (problem) {
        // 硬校验而不是提示：两侧同时 fail-open 等于审核层被关闭且无任何症状。
        res.status(400).json({ error: "invalid_policy", detail: problem });
        return;
      }

      const identity = req.console!;
      const saved = await deps.settings.put("policy", policy, {
        subject: identity.subject,
        role: identity.role,
      });
      await deps.invalidate();
      res.json({ ok: true, policy: saved.value, updatedAt: saved.updatedAt });
    },
  );

  router.post(
    "/console/guard/kill",
    auditAction("guard.kill.update"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const body = (req.body ?? {}) as Partial<KillSwitch>;
      const agents = Array.isArray(body.agents) ? body.agents.map(String) : [];
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];

      // 未知 Agent 名直接拒绝：写进去不报错、但也不生效，
      // 而运营会以为已经关停了——这正是止血开关最不能有的失败形态。
      const unknown = agents.filter((a) => !(KNOWN_AGENTS as readonly string[]).includes(a));
      if (unknown.length) {
        res.status(400).json({
          error: "unknown_agent",
          detail: `未知 Agent：${unknown.join("、")}。可选：${KNOWN_AGENTS.join("、")}`,
        });
        return;
      }

      const identity = req.console!;
      const saved = await deps.settings.put<KillSwitch>(
        "kill_switch",
        { agents, capabilities },
        { subject: identity.subject, role: identity.role },
      );
      await deps.invalidate();
      res.json({ ok: true, killSwitch: saved.value, updatedAt: saved.updatedAt });
    },
  );

  /*
   * 话术（F-30-01 第三档 / F-30-02）。
   *
   * 校验**转发给 agent-runtime** 而不是在网关重写一份：话术是 CarLife 的业务规则，
   * 落在 `guard/disclaimers.ts`（§10 要点 3，`check:arch` 的 guardrails-purity
   * 拦着把它塞进通用包）。网关抄一份校验就有了第二份真相，
   * 而两份校验漂移时通常是这边放宽了。
   */
  router.get(
    "/console/guard/disclaimer",
    requireAnyRole(CONSOLE_READERS),
    async (_req: ConsoleRequest, res: Response) => {
      const [policy, text, history] = await Promise.all([
        deps.settings.get("disclaimer_policy"),
        deps.settings.get("disclaimer_text"),
        deps.settings.history("disclaimer_text", 20),
      ]);
      const defaults = await deps.disclaimerDefaults();
      res.json({
        policy: policy?.value ?? defaults.policy,
        policySource: policy ? "db" : "default",
        text: text?.value ?? defaults.text,
        textSource: text ? "db" : "default",
        updatedBy: text?.updatedBy ?? policy?.updatedBy,
        maxChars: defaults.maxChars,
        history,
      });
    },
  );

  router.post(
    "/console/guard/disclaimer",
    auditAction("guard.disclaimer.update"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const body = (req.body ?? {}) as { policy?: unknown; text?: unknown };
      const identity = req.console!;

      // 交给 agent-runtime 判：售后免责不可关、空串、超长三条红线都在那边
      const verdict = await deps.validateDisclaimer(body);
      if (verdict.error) {
        res.status(400).json({ error: "invalid_disclaimer", detail: verdict.error });
        return;
      }

      const actor = { subject: identity.subject, role: identity.role };
      if (body.policy !== undefined) await deps.settings.put("disclaimer_policy", body.policy, actor);
      if (body.text !== undefined) await deps.settings.put("disclaimer_text", body.text, actor);
      await deps.invalidate();
      res.json({ ok: true });
    },
  );

  router.get(
    "/console/guard/redlines",
    requireRole("admin"),
    async (_req: ConsoleRequest, res: Response) => {
      // 只读，无对应的 POST。红线不在 guard_settings 表里，没有写入路径。
      res.json({ ...(await deps.redlines()), writable: false });
    },
  );

  return router;
}
