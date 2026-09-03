/**
 * 后台路由（施工单 M3-01）—— 全部挂在 `/console/*` 前缀下。
 *
 * 与端上 `/v1/*` **物理分离**：两条路径各自鉴权、互不影响，
 * 也便于按前缀做对外暴露面检查（M3-03 会加断言）。
 *
 * 本文件只负责装配；具体资源路由分散在同目录下：
 *   session.ts  身份     （M3-01）
 *   audit.ts    审计中间件（M3-01）
 *   config.ts   配置读写  （M3-02）
 *   sessions.ts 会话浏览  （M3-04）
 *   memory.ts   记忆浏览  （M3-05）
 *   replay.ts   轨迹回放  （M9-01）
 *   knowledge.ts 知识库管理（M8-01 后台部分）
 *   demo.ts     演示大屏聚合（M9-07）
 *   finance.ts  外部账户余额与订阅状态
 *   system-status.ts 系统状态（运维大屏的子服务探活聚合）
 *   trace-stream.ts 实时轨迹转发（大屏"现在流到哪了"）
 *   identity.ts 用户体系：账号 / 车辆与授权 / 终端设备（M68-01 只读，M68-02 治理动作）
 */

import { Router, json } from "express";
import type { Response } from "express";

import type {
  AuditRepository,
  ChatRepository,
  ConfigStore,
  DeviceRepository,
  MessageAudioRepository,
  GuardSettingRepository,
  IdentityConsoleRepository,
  TraceRepository,
  TripPlanRepository,
  TripRouteAuditRepository,
  UsageRepository,
  UserRepository,
  VehicleGrantRepository,
} from "@carlife/db";

import type { RagClient } from "@carlife/rag";

import { consoleAuth, requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { consoleAudit } from "./audit";
import { createConfigRouter } from "./config";
import { createSessionsRouter } from "./sessions";
import { createMessageAudioRouter, type MessageAudioDeps } from "./message-audio";
import { createUsersRouter } from "./users";
import { createMemoryRouter } from "./memory";
import { createProbeRouter } from "./probe";
import { createSystemStatusRouter, type QuotaSnapshot } from "./system-status";
import { createDemoRouter } from "./demo";
import { createKnowledgeRouter } from "./knowledge";
import { createReplayRouter } from "./replay";
import { createTraceStreamRouter } from "./trace-stream";
import { createUsageRouter } from "./usage";
import { createFinanceRouter } from "./finance";
import { createGuardPolicyRouter } from "./guard-policy";
import { createConsoleCabinRouter, type ConsoleCabinDeps } from "./cabin";
import { createEvalsRouter } from "./evals";
import { EvalsStore } from "./evals-store";
import { createTripRouteRouter } from "./trip-route";
import { createIdentityConsoleRouter } from "./identity";

export interface ConsoleDeps {
  audit: AuditRepository;
  chat: ChatRepository;
  config: ConfigStore;
  usage: UsageRepository;
  /** agent-runtime 内部地址，供记忆只读查询转发（M3-05） */
  runtimeUrl: string;
  /**
   * 轨迹只读仓储（M9-01）。**只给仓储、不给任何执行句柄**——
   * "回放不是重跑"由结构保证：回放路由物理上拿不到 streamer 与工具注册表。
   */
  trace: TraceRepository;
  /**
   * RAGFlow 客户端工厂（M8-01 后台）。用工厂而不是实例：
   * 未配置时返回 undefined，路由据此明确回"未接入"而不是空列表——
   * 空列表看起来像"知识库是空的"，那是另一回事。
   */
  ragClient: () => RagClient | undefined;
  /**
   * Guard 策略与止血开关（TD-03）。
   *
   * 与 `config` 分开一个仓储而不是共用：那张表只承载 A 密钥/B 接入面，
   * C 策略值归运营、D 红线永远只在代码里（§8.2 三分边界）。
   */
  guardSettings: GuardSettingRepository;
  /**
   * 会话试听（M60-02）：音频索引仓储 + 对象存储 + 日字符闸门。
   *
   * **整体可缺省**：对象存储没接（S3_* 未配）时不挂这条路由——挂一个必然
   * 404 的试听按钮比没有按钮更难解释。界面据此不渲染播放键。
   */
  messageAudio?: Pick<MessageAudioDeps, "store" | "quota"> & { repo: MessageAudioRepository };
  /** 客户座舱视图（M24-10）。可缺省：未接入时相关端点如实报 unconfigured/503。 */
  cabinView?: Omit<ConsoleCabinDeps, "audit">;
  /** 行程路径优化对比（route_audit 的后台消费面）：审计记录 + 行程快照，只读。 */
  tripRoute: {
    audits: TripRouteAuditRepository;
    plans: TripPlanRepository;
  };
  /** 账号仓储（M48-02）：建账号与重置口令。端上鉴权用同一个仓储，见 `auth/`。 */
  users: UserRepository;
  /**
   * 用户体系只读面（M68-01）：账号 / 车辆与授权 / 终端设备的跨实体分页读。
   * 它是全仓唯一允许无键读的仓储，**只在这里注入**，不给 `/v1/*` 的任何路由。
   */
  identity: IdentityConsoleRepository;
  /**
   * 后台治理动作（M68-02）：撤销设备 / 解绑车机 / 撤销授权。复用端上同一份仓储的软删——
   * 撤销的语义只在那两个文件里写一份。可缺省：不注入时写端点不挂（只读部署形态）。
   */
  identityActions?: { devices: Pick<DeviceRepository, "revoke">; grants: Pick<VehicleGrantRepository, "roleFor" | "revoke"> };
  /**
   * 今日云 vendor 用量快照（ACR-016）。可缺省——不注入时状态页不显示这一块。
   * 只读，不参与任何判定：闸门本体在装配层，这里纯粹是让它看得见。
   */
  quotaSnapshot?: () => Promise<QuotaSnapshot>;
  /**
   * 评测台（M67-02）：仓库根路径。网关只 spawn `evals/lib/job.ts` 并读 `evals/runs/`，不 import evals。
   * 可缺省——不注入时评测路由整体不挂（页面按 503 显示"本部署没有评测面"）。
   */
  evals?: { root: string };
}

export function createConsoleRouter(deps: ConsoleDeps): Router {
  const router = Router();

  router.use(consoleAuth);
  router.use(consoleAudit(deps.audit));
  router.use(json());

  // 身份：前端据此渲染菜单（服务端仍独立判定，界面隐藏不算权限）
  router.post("/console/session", (req: ConsoleRequest, res: Response) => {
    if (!req.console) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(req.console);
  });

  router.get(
    "/console/audit",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const parseDate = (v: unknown): Date | undefined => {
        if (typeof v !== "string") return undefined;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d;
      };
      res.json(
        await deps.audit.page({
          limit,
          actor: typeof req.query.actor === "string" ? req.query.actor : undefined,
          action: typeof req.query.action === "string" ? req.query.action : undefined,
          role: req.query.role === "admin" || req.query.role === "ops" ? req.query.role : undefined,
          since: parseDate(req.query.since),
          until: parseDate(req.query.until),
          cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        }),
      );
    },
  );

  router.use(createConfigRouter(deps.config, deps.audit));
  if (deps.cabinView) {
    router.use(createConsoleCabinRouter({ ...deps.cabinView, audit: deps.audit }));
  }
  router.use(
    createGuardPolicyRouter({
      settings: deps.guardSettings,
      // 红线在 agent-runtime 的代码里，网关只转发只读快照——
      // 在网关侧抄一份清单等于制造第二份真相
      redlines: async () => {
        const r = await fetch(`${deps.runtimeUrl}/internal/guard/redlines`);
        if (!r.ok) throw new Error(`红线快照拉取失败：${r.status}`);
        return (await r.json()) as { hardBlocks: string[]; capabilities: string[] };
      },
      disclaimerDefaults: async () => {
        const r = await fetch(`${deps.runtimeUrl}/internal/guard/disclaimer/defaults`);
        if (!r.ok) throw new Error(`话术默认值拉取失败：${r.status}`);
        return (await r.json()) as { policy: unknown; text: unknown; maxChars: number };
      },
      validateDisclaimer: async (body) => {
        const r = await fetch(`${deps.runtimeUrl}/internal/guard/disclaimer/validate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) return { error: `校验服务不可用（${r.status}）` };
        return (await r.json()) as { error?: string };
      },
      invalidate: async () => {
        // 失败不抛：策略已经写进库了，最多等 TTL(30s) 自然生效。
        // 因为让缓存失效失败而把写入回滚，会让"改不了策略"的面更大。
        try {
          await fetch(`${deps.runtimeUrl}/internal/guard/invalidate`, { method: "POST" });
        } catch (err) {
          console.warn(`[console] 策略缓存失效通知失败，将在 TTL 内自然生效：${String(err)}`);
        }
      },
    }),
  );
  router.use(createSessionsRouter(deps.chat, deps.audit, deps.messageAudio?.repo, deps.tripRoute.plans));
  if (deps.messageAudio) {
    router.use(
      createMessageAudioRouter({
        chat: deps.chat,
        audit: deps.audit,
        audio: deps.messageAudio.repo,
        config: deps.config,
        store: deps.messageAudio.store,
        quota: deps.messageAudio.quota,
      }),
    );
  }
  // 账号管理（M48-02）：POC 期账号由管理员预置，不做自助注册（FL-07 负向验收）。
  router.use(createUsersRouter(deps.users));
  // 用户体系浏览（M68-01）：账号 / 车辆与授权 / 终端设备，ops 与 admin 均可读。
  router.use(createIdentityConsoleRouter({ identity: deps.identity, chat: deps.chat, ...(deps.identityActions ?? {}) }));
  router.use(createTripRouteRouter(deps.tripRoute.audits, deps.tripRoute.plans));
  if (deps.evals) {
    router.use(createEvalsRouter({ store: new EvalsStore(deps.evals.root) }));
  } else {
    router.use("/console/evals", (_req, res) => {
      res.status(503).json({ error: "evals_unavailable" });
    });
  }
  router.use(createMemoryRouter(deps.runtimeUrl, deps.chat, deps.audit));
  router.use(createProbeRouter(deps.config, deps.runtimeUrl));
  // 运维大屏：全部子服务（infra/scripts/dev.sh + docker-compose.yml 的投影）的探活聚合
  router.use(
    createSystemStatusRouter({
      config: deps.config,
      runtimeUrl: deps.runtimeUrl,
      quota: deps.quotaSnapshot,
    }),
  );
  router.use(createUsageRouter(deps.usage));
  // 外部账户余额（admin 独有）。余额与账单只读环境里的供应商凭据；唯一碰的仓储是
  // 用量表的只读聚合（卡片底部的吞吐图），类型收窄到 `throughput()` 一个方法——
  // 把整个仓储放进去会给人"财务页能改业务数据"的错觉。
  router.use(createFinanceRouter({ usage: deps.usage }));
  // audit 是 reveal 那条路要的：提示词原文的提权必须留痕（TD-08）
  router.use(createReplayRouter(deps.trace, deps.audit));
  // 实时轨迹（大屏"现在流到哪了"）。与回放共用同一套脱敏口径，见 trace-stream.ts。
  router.use(createTraceStreamRouter(deps.runtimeUrl));
  router.use(createKnowledgeRouter(deps.ragClient, deps.runtimeUrl, deps.chat));
  router.use(
    createDemoRouter({
      usage: deps.usage,
      audit: deps.audit,
      trace: deps.trace,
      config: deps.config,
      runtimeUrl: deps.runtimeUrl,
    }),
  );

  // `/console/*` 的未匹配请求在此终止，**不落入端上 `/v1` 的中间件链**。
  // 否则一个不存在的后台接口会被 demoAuth 判成 401，掩盖"这个路由根本不存在"
  // 这一事实——比如"审计有没有删除接口"就会得到误导性的答案。
  router.use("/console", (_req, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}
