// gateway — 接入网关入口（REST + SSE，不用 WS；§3）
//
// 职责：协议转换与治理（鉴权/日志/上传/SSE 封套）。
// 红线：不含业务逻辑、不直接调 LLM/工具（依赖树中无 ai/@ai-sdk，e2e 有静态断言）。

import { loadRootEnv } from "./env";
loadRootEnv();

import express from "express";
import type { Express } from "express";

import {
  getPrisma,
  createChatRepository,
  createAuditRepository,
  createConfigStore,
  createAttachmentRepository,
  createMessageAudioRepository,
  createTraceRepository,
  createTripRepository,
  createTripPlanRepository,
  createTripRouteAuditRepository,
  createVehicleMemberRepository,
  createUserRepository,
  createIdentityConsoleRepository,
  createDeviceRepository,
  createVehicleGrantRepository,
  createMemberCombinationRepository,
  createOwnerProfileRepository,
  createGuardSettingRepository,
  createUsageRepository,
  createVehicleRepository,
  assertStartupConfig,
} from "@carlife/db";

// 必填配置缺失即快速失败，不留到第一次真实调用才炸（M3-02 / AC-35-11）。
assertStartupConfig();

import { createJwtAuth } from "./auth";
import { createAuthRouter } from "./http/auth";
import { createBoardingActorMiddleware } from "./auth/boarding-actor";
import { createVehicleRoleMiddleware } from "./auth/vehicle-role";
import { createVehicleGrantRouter } from "./http/vehicle-grant";
import { createDeviceRouter, createDevicePairingRouter } from "./http/device";
import { createPairingStore } from "./http/pairing-store";
import { requestLog } from "./middleware";
import { createAsrProvider, createConfiguredAsrProvider, type AsrProvider } from "./asr";
import { createDailyQuota } from "./quota/daily-quota";
import { SessionBus } from "./stream/session-bus";
import { createStreamRouter } from "./stream";
import { createHttpRouter } from "./http";
import { createTripPlanRouter } from "./http/trip-plan";
import { createGuideRouter } from "./http/guide";
import { createGuideJobsRouter } from "./http/guide-jobs";
import { createBuyingRouter } from "./http/buying";
import { createVehicleRouter } from "./http/vehicle";
import { createVehicleMemberRouter } from "./http/vehicle-member";
import { createVehicleCabinRouter } from "./http/vehicle-cabin";
import { createCabinMediaRouter } from "./http/cabin-media";
import { createCabinClient, createHttpCabinBackend, ToolError, type CabinBindingStore } from "@carlife/tools";
import { createRedisVehicleCacheBackend } from "./http/vehicle-cache-backend";
import {
  createCoverageProvider,
  createVehicleCatalogRouter,
  knowledgeFor,
} from "./http/vehicle-catalog";
import { createProfileDataRouter } from "./http/profile-data";
import { createMem0PreferenceReader } from "./http/preference-reader";
import { createCachedVehicleStore, vehicleOwnerKey, vehicleVinKey, type VehicleStore } from "@carlife/memory";
import { resolveTts } from "@carlife/db";
import { createTtsConfigRouter } from "./http/tts-config";
import { createAmapProxyRouter } from "./http/amap-proxy";
import { createTtsSpeechRouter } from "./http/tts-speech";
import { createTelemetryRouter } from "./telemetry";
import { createConsoleRouter } from "./console";
import { audioObjectKey } from "./console/message-audio";
import { createObjectStore, createUploadRouter } from "./upload";
import { createRagClient, type RagClient } from "@carlife/rag";

/*
 * 默认端口与 `.env.example`、`dev.sh`、文档、cockpit 的 vite proxy 全部一致取 **8790**。
 *
 * 这里曾经是 8787，而实配、脚本、文档全是 8790——一个**只在新 clone 上才现形**的分裂：
 * 老机器恒有 .env 兜着，谁都踩不到；照 .env.example 起服务的人则会发现 cockpit 的
 * dev 代理打不通，而错误信息里没有任何一处提到端口（M39-01）。
 */
const PORT = Number(process.env.GATEWAY_PORT ?? 8790);

export function createGatewayApp(): Express {
  const prisma = getPrisma();
  const repo = createChatRepository(prisma);
  const audit = createAuditRepository(prisma);
  const config = createConfigStore(prisma);
  const usage = createUsageRepository(prisma);
  // 轨迹只读（M9-01）。网关这一侧**只读不写**——采集在 agent-runtime，
  // 两边共用同一张表但职责不重叠。
  const trace = createTraceRepository(prisma);
  // Guard 策略与止血开关（TD-03）。与 config 分两个仓储：那张表只承载
  // A 密钥/B 接入面，C 策略值归运营、D 红线永远只在代码里（§8.2 三分边界）。
  const guardSettings = createGuardSettingRepository(prisma);
  // M24-10：console 座舱视图的依赖。vehicleStore 与 cabin client 在下方才装配，
  // 这里用**转发句柄**（与 line ~182 的 get/listByOwner 包装同一先例）晚绑定。
  let consoleCabinClient: import("@carlife/tools").CabinClient | undefined;

  // RAGFlow（M8-01 后台）。未配置即 undefined——知识库页据此显示"未接入"。
  const ragBase = process.env.RAGFLOW_BASE_URL?.trim();
  const ragKey = process.env.RAGFLOW_API_KEY?.trim();
  const rag: RagClient | undefined =
    ragBase && ragKey
      ? createRagClient({
          baseUrl: ragBase,
          apiKey: ragKey,
          datasetIds: {
            "vehicle-manuals": process.env.RAGFLOW_DATASET_VEHICLE_MANUALS ?? "",
            "repair-kb": process.env.RAGFLOW_DATASET_REPAIR_KB ?? "",
            "car-catalog": process.env.RAGFLOW_DATASET_CAR_CATALOG ?? "",
          },
        })
      : undefined;
  const bus = new SessionBus();
  // 按配置版本缓存的工厂：改配置后下一次转写自动用新值，**不重启**（M3-02 约束 2）。
  const asr = createConfiguredAsrProvider(config);

  /*
   * 日用量闸门（ACR-016）。装配层持有它是因为"超限了该降到哪"是这一层的知识：
   * 只有它知道本地档配没配、URL 是什么。路由层只问"这次用谁转写"。
   *
   * 免费兜底 provider **单独构造一份**，不复用上面那个 `asr`——后者跟着后台的
   * ASR_ENGINE 走，超限时它指的正是那个要被绕开的云档。
   */
  const quota = createDailyQuota(process.env.REDIS_URL?.trim());
  const freeAsr = createAsrProvider({ ...process.env, ASR_ENGINE: "mock" });
  /**
   * 当前生效的 ASR 档位——计价与闸门都要按它分账，不能硬编码 vendor 名。
   * 只问配置层（env-override 的优先级由 store 解析，ACR-017）。
   */
  const currentAsrEngine = async (): Promise<string> =>
    (await config.get("ASR_ENGINE"))?.trim() || "ark";
  // 旧逃生阀退休（ACR-017）：发现即打显眼告警。**不生效**——继续生效等于保留第二套开关。
  if (process.env.CARLIFE_ASR) {
    console.warn(
      `[config] ⚠️ CARLIFE_ASR=${process.env.CARLIFE_ASR} 已废弃且未生效（ACR-017）——` +
        "选档请用 ASR_ENGINE（.env 写死即钉档，后台可热切）；请从 .env 删除该行",
    );
  }
  const asrGate = async (): Promise<{ provider: AsrProvider; engine: string } | null> => {
    const engine = await currentAsrEngine();
    // 本机 mock 档与 Fake 不花钱，不进闸也不计数——闸门记的是"发给供应商多少"。
    if (engine === "mock" || engine === "fake") return { provider: asr, engine };
    const limit = Number(await config.get("ASR_DAILY_CALL_LIMIT"));
    const decision = await quota.consume("asr", 1, Number.isFinite(limit) ? limit : 0);
    if (decision.allowed) return { provider: asr, engine };
    // 超限：本地档能顶就顶（免费且已容器化），顶不了就让调用方明确失败。
    const localUrl = (await config.get("LOCAL_ASR_URL"))?.trim();
    console.warn(
      `[quota] 云 ASR 今日用量 ${decision.used} 已超上界 ${decision.limit}——` +
        (localUrl ? "本次降级本地档（免费）" : "且未配本地档，本次明确失败"),
    );
    // 降级后 engine 报的是 **mock**，不是配置里那个云档——会话详情的标签
    // 要说的是"这句实际谁转的"，报成云档等于记了一笔没花的钱。
    return localUrl ? { provider: freeAsr, engine: "mock" } : null;
  };

  /*
   * 对象存储（M8-04 起）。**在建 app 之前构造一次**，因为它有两个消费方：
   * 端上的多模态上传，与后台的会话试听（M60-02）。原来它建在上传那一段里，
   * 而后台路由挂载得更早——不提前就只能建第二个客户端，两份配置迟早分家。
   *
   * 三项缺一即视为未接入：接一个连不上存储的口子，用户会拍完照片等半天
   * 才看到失败；试听那侧则是点了播放键必然 404。
   */
  const s3Endpoint = process.env.S3_ENDPOINT?.trim();
  const s3Key = process.env.S3_ACCESS_KEY_ID?.trim();
  const s3Secret = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const objectStore =
    s3Endpoint && s3Key && s3Secret
      ? createObjectStore({
          endpoint: s3Endpoint,
          accessKeyId: s3Key,
          secretAccessKey: s3Secret,
          bucket: process.env.S3_BUCKET ?? "carlife-attachments",
        })
      : undefined;
  if (objectStore) {
    // 建桶是幂等的；失败不阻塞启动——**对话不该因为上传不可用而起不来**。
    void objectStore.ensureBucket().catch((err: unknown) =>
      console.error("[upload] 建桶失败，附件上传与会话试听将不可用", err),
    );
  }
  /** 消息音频索引（M60-02）：试听端点与建轮时的录音转存共用一份。 */
  const messageAudioRepo = createMessageAudioRepository(prisma);

  const app = express();
  app.use(requestLog);
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  /*
   * 账号、设备与授权仓储：登录路由、鉴权中间件、车辆角色中间件、后台账号管理与
   * 后台治理动作（M68-02）共用同一份（M48-02 起）。共用而不是各建一份，是因为它们
   * 判定的是同一件事——"这个账号/设备/授权现在还有效吗"，两份实例迟早在缓存或连接上分叉。
   * 建在后台路由之前：后台的撤销走的就是这几个仓储的软删，不另写一份撤销（R11）。
   */
  const userRepo = createUserRepository(prisma);
  const deviceRepo = createDeviceRepository(prisma);
  const grantRepo = createVehicleGrantRepository(prisma);

  // 后台路由自带鉴权，必须挂在端上 jwtAuth 之前——两条路径互不影响（M3-01 约束 1）。
  app.use(
    createConsoleRouter({
      audit,
      chat: repo,
      config,
      usage,
      trace,
      ragClient: () => rag,
      guardSettings,
      /*
       * 会话试听（M60-02）。**对象存储没接就整体不给**——界面据此不渲染
       * 播放键；给一个点了必然失败的按钮比没有按钮更难解释。
       * 闸门与端上播报同一个池子：补合成花的是同一笔钱。
       */
      ...(objectStore
        ? { messageAudio: { repo: messageAudioRepo, store: objectStore, quota } }
        : {}),
      runtimeUrl: process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788",
      // 今日云用量（ACR-016）：状态页要看得见闸门，否则超限那天只表现为
      // "声音怎么变了 / 识别怎么变差了"，没人会想到是额度用完了。
      quotaSnapshot: async () => {
        const [asrUsed, ttsUsed, asrLimit, ttsLimit] = await Promise.all([
          quota.snapshot("asr"),
          quota.snapshot("tts"),
          config.get("ASR_DAILY_CALL_LIMIT"),
          config.get("TTS_DAILY_CHAR_LIMIT"),
        ]);
        const num = (v: string | undefined): number => {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        };
        return {
          asr: { ...asrUsed, limit: num(asrLimit) },
          tts: { ...ttsUsed, limit: num(ttsLimit) },
        };
      },
      tripRoute: {
        audits: createTripRouteAuditRepository(prisma),
        plans: createTripPlanRepository(prisma),
      },
      // 评测台（M67-02）：仓库根缺省从本文件反推（gateway/src → 根）；Docker 形态下目录不在，路由自己回 503。
      evals: { root: process.env.CARLIFE_EVALS_ROOT ?? new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "") },
      users: userRepo,
      // 用户体系（M68-01 只读 / M68-02 治理动作）：只读仓储只在后台注入，端上路由拿不到它；
      // 撤销走与端上同一份 deviceRepo / grantRepo 的软删。
      identity: createIdentityConsoleRepository(prisma),
      identityActions: { devices: deviceRepo, grants: grantRepo },
      cabinView: {
        vehicles: {
          get: (v) => vehicleStore.get(v),
          listByOwner: (o) => vehicleStore.listByOwner(o),
          upsert: (pf) => vehicleStore.upsert(pf),
          setDefault: (o, v) => vehicleStore.setDefault(o, v),
          appendMaintenance: (v, r) => vehicleStore.appendMaintenance(v, r),
          appendRepair: (v, r) => vehicleStore.appendRepair(v, r),
          advanceOdometer: (v, k) => vehicleStore.advanceOdometer(v, k),
        },
        members: createVehicleMemberRepository(prisma),
        combinations: createMemberCombinationRepository(prisma),
        trips: createTripRepository(prisma),
        cabin: {
          bind: (v) => requireConsoleCabin().bind(v),
          status: (v) => requireConsoleCabin().status(v),
          apply: (v, a) => requireConsoleCabin().apply(v, a),
          changes: (v) => requireConsoleCabin().changes(v),
          energy: (v) => requireConsoleCabin().energy(v),
          // 媒体三件（M27）控制台目前不用，但代理要是全的——缺一个方法这里就编译红。
          // 逐个转调而不是 `...client` 展开：每次调用都要重新过一遍"车机接没接入"，
          // 展开会把未接入时的那次抛错固化成启动期的一次判断。
          mediaLibrary: () => requireConsoleCabin().mediaLibrary(),
          mediaPlayer: (v) => requireConsoleCabin().mediaPlayer(v),
          mediaCommand: (v, c) => requireConsoleCabin().mediaCommand(v, c),
          mediaDuck: (d) => requireConsoleCabin().mediaDuck(d),
          mediaSink: (v, b) => requireConsoleCabin().mediaSink(v, b),
          mediaTrack: (t, r) => requireConsoleCabin().mediaTrack(t, r),
        },
      },
    }),
  );
  function requireConsoleCabin(): import("@carlife/tools").CabinClient {
    if (!consoleCabinClient) {
      throw new ToolError("cabin", "unconfigured", "车机未接入（MOCK_CABIN_URL 未配）", false);
    }
    return consoleCabinClient;
  }


  /*
   * 高德 JS API 的服务接口代理（ACR-019）。挂在 jwtAuth **之前**，因为高德 SDK
   * 自己发这些请求、带不了我们的头——这条不鉴权的路径与它的三重硬约束
   * （路径前缀 / 上游硬编码 / 只放行 GET-HEAD）在 `http/amap-proxy.ts` 里说明。
   * 端上因此不必再把安全密钥打进产物。
   */
  app.use(createAmapProxyRouter(config));

  // 登录与刷新挂在鉴权**之前**：调它的时候本来就还没有身份（M48-02）。
  app.use(createAuthRouter({ users: userRepo, devices: deviceRepo }));

  /*
   * 车机配对确认（M48-04）同样在鉴权之前：车机走到这一步时还没有任何凭证，
   * 它就是来换凭证的。凭据是配对码本身（60 秒、一次性、绑定 deviceId）。
   */
  const pairingStore = createPairingStore(process.env.REDIS_URL?.trim());
  app.use(createDevicePairingRouter({ devices: deviceRepo, pairing: pairingStore }));

  // M48-02：demo-token 万能钥匙已删除，这里是真的 JWT 校验。
  app.use(createJwtAuth({ users: userRepo, devices: deviceRepo }));

  /*
   * 车辆角色解析（M48-03，F-55-04）。挂在鉴权之后、一切车辆路由之前：
   * 它只**注入** `req.grantRole`，拒绝留给各端点——那里才知道这次是读还是写，
   * 而读（成员即可）与写（只有车主）的门槛不同。
   *
   * 撤销的生效机制就是它：每个带 vin 的请求查一次库，被移除的人下一次请求
   * 就在端点处被判非成员（设计裁决 R11，不建撤销名单）。
   */
  /*
   * 上车声明的代理身份（M54-13）。必须夹在 jwtAuth 与 vehicleRole 之间：
   * 前者填 deviceId/vehicleVin（本中间件的输入），后者按 userId 算 grantRole
   * （本中间件的输出）。顺序错了的症状是"车机看得到自己的东西，但角色恒为空"。
   */
  app.use(createBoardingActorMiddleware(repo));
  app.use(createVehicleRoleMiddleware(grantRepo));
  app.use(createDeviceRouter({ devices: deviceRepo, grants: grantRepo, pairing: pairingStore }));
  app.use(
    createVehicleGrantRouter({
      grants: grantRepo,
      users: userRepo,
      ownerOf: async (vin) => (await vehicleStore.get(vin))?.ownerId ?? null,
    }),
  );

  // 多模态上传（M8-04）。**未配置 S3 时不挂载**——
  // 挂一个连不上存储的上传接口，用户会拍完照片等半天再看到失败。
  // 不挂载则直接 404，端上据此隐藏入口。存储客户端在上面已经建好（见 objectStore）。
  if (objectStore) {
    app.use(createUploadRouter(objectStore, createAttachmentRepository(prisma)));
    console.log(`[upload] 对象存储已接入（${s3Endpoint}）`);
  } else {
    console.log("[upload] 对象存储未接入（S3_ENDPOINT / KEY / SECRET 未配置），附件上传与会话试听不可用");
  }

  // ⑥用车流水上报（M11-01）：两段式的第一段。挂在 jwtAuth 之后——
  // 归属只认鉴权上下文，不认请求体里的 userId。
  // 人员仓储一并注入：带归属的流水要校验"这个成员属于这辆车"（M17-02，F-46-05）。
  // 合成端点下发（后台 TTS 引擎开关的端上一侧）。挂在 jwtAuth 之后：
  // 它按鉴权身份放行，但内容与身份无关——全局一份配置。
  app.use(createTtsConfigRouter(config));
  // 端上的合成端点（ACR-018）：**三档共用**，端上不再直连任何供应商。
  // 同样挂在 jwtAuth 之后——它花真钱，不能像 mock-tts 那样裸奔。
  app.use(createTtsSpeechRouter(config, { quota }));
  app.use(createTelemetryRouter(createTripRepository(prisma), createVehicleMemberRepository(prisma)));
  // 已确认行程 + 常住地只读（M13-03 / M13-10）：座舱 HUD 轮询入口，
  // 按鉴权身份查、不含业务逻辑。常住地是"没有行程时地图落在哪"。
  app.use(
    createTripPlanRouter(
      createTripPlanRepository(prisma),
      createOwnerProfileRepository(prisma),
      // 打开 App 时的读时重算（M20-06）走 runtime；地址与其它内部调用同源。
      process.env.AGENT_RUNTIME_URL ?? "http://localhost:8791",
    ),
  );
  // 景区导览触发通道（M36-02）：点击景点 → runtime 三分支采集。同步挂等，预算见 guide.ts。
  // 仓储用于 body 缺省时补行程上下文（M40-02：缓存键与队列路径同源）。
  app.use(
    createGuideRouter(
      process.env.AGENT_RUNTIME_URL ?? "http://localhost:8791",
      undefined,
      createTripPlanRepository(prisma),
    ),
  );
  // 导览后台任务面（ACR-008）：逐景点进度/状态 + 手动「获取」。行程归属只认鉴权身份。
  app.use(
    createGuideJobsRouter(
      createTripPlanRepository(prisma),
      process.env.AGENT_RUNTIME_URL ?? "http://localhost:8791",
    ),
  );
  // 购车候选与成本只读（M15-05）：手机端购车页入口。代理到 runtime 读检查点——
  // 候选没有落库（本 Sprint 无 schema 变更），它只活在①Working 里。
  app.use(createBuyingRouter(repo));
  /*
   * ④车辆档案（M14-04）：档案 tab 数据面 + 建档向导地基。
   *
   * 缓存与 agent-runtime **共用键空间**（carlife:vehicle:），网关侧写
   * 会同步失效那边正在读的 key——写后立即可见跨进程成立（F-23-13）。
   * Redis 连接是异步的，而本函数是同步装配：用委托 store 起步直连 PG
   * （直连=正确只是慢），连上后切到缓存包装，不为此把装配改成 async。
   */
  const vehicleRepo = createVehicleRepository(prisma);
  let vehicleStore: VehicleStore = vehicleRepo;
  // 供 replaceVin 手动失效（M29-04）：主键迁移绕过缓存装饰器，旧 vin 的缓存要自己删。
  let vehicleCacheBackend: Awaited<ReturnType<typeof createRedisVehicleCacheBackend>>;
  void createRedisVehicleCacheBackend(process.env.REDIS_URL?.trim()).then((backend) => {
    if (backend) {
      vehicleStore = createCachedVehicleStore(vehicleRepo, backend);
      vehicleCacheBackend = backend;
      console.log("[vehicle] ④档案读缓存已接入（与 agent-runtime 共用键空间）");
    } else {
      console.log("[vehicle] ④档案读缓存未接入（Redis 不可用或未配置）——读直连 PG");
    }
  });
  /*
   * 车型 ↔ 知识库的关联关系（M14-08）。带 TTL 缓存 + 并发去重：
   * 建档向导与档案页都要用它，而算一次要向 RAGFlow 打三次 listDocuments。
   * rag 未接入时 provider 返回 unavailable——端上说"读不到"，不说"没有资料"。
   */
  const coverage = createCoverageProvider(() => rag);
  app.use(createVehicleCatalogRouter(coverage));
  app.use(
    createVehicleRouter({
      get: (v) => vehicleStore.get(v),
      listByOwner: (o) => vehicleStore.listByOwner(o),
      upsert: (p) => vehicleStore.upsert(p),
      setDefault: (o, v) => vehicleStore.setDefault(o, v),
      appendMaintenance: (v, r) => vehicleStore.appendMaintenance(v, r),
      appendRepair: (v, r) => vehicleStore.appendRepair(v, r),
      // source 必须透传（M29-03）：吞掉第三个参数会让手录里程的来源永远是空。
      advanceOdometer: (v, k, s) => vehicleStore.advanceOdometer(v, k, s),
    },
    (model) => knowledgeFor(coverage, model),
    /*
     * 自助写路径的留痕（M29-01，AC-23-9）。`record` 而不是 `recordStrict`：
     * 补录是系统代用户写（失败要可见，M26-05 用 strict），自助操作是用户亲手做的——
     * 档案写入成功优先，审计失败走 record 内部的错误日志。
     */
    (e) =>
      audit.record({
        actor: e.ownerId,
        actorRole: "owner",
        action: e.action,
        result: e.result,
        target: e.vin,
        detail: e.detail ?? null,
      }),
    /*
     * VIN 补录（M29-04）：仓储扩展方法直连，绕过缓存装饰器——所以迁移成功后
     * 手动删旧 vin / 新 vin / 车主列表三类 key，守住"写后立即可见"（F-23-13）。
     */
    async (oldVin, newVin) => {
      const fresh = await vehicleRepo.replaceVin(oldVin, newVin);
      const backend = vehicleCacheBackend;
      if (backend) {
        await backend
          .del([vehicleVinKey(oldVin), vehicleVinKey(newVin), vehicleOwnerKey(fresh.ownerId)])
          .catch((err: unknown) => console.warn("[vehicle] VIN 补录后缓存失效失败", err));
      }
      return fresh;
    },
    // 变更记录读端（M29-05）：只递"按 target 翻页"这一种查询，不递整个审计仓储。
    async (q) => {
      const page = await audit.page({ target: q.target, limit: q.limit, cursor: q.cursor });
      return {
        entries: page.entries.map((e) => ({
          id: e.id,
          at: e.at,
          actorRole: e.actorRole,
          action: e.action,
          result: e.result,
          detail: e.detail ?? null,
        })),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      };
    },
    /*
     * 被授权使用的车（M48-03，F-55-05）：列表 = 拥有的 ∪ 被授权的。
     * 只列自己名下的话，被分享的那辆永远不出现——而"开别人的车"正是
     * REQ-0002 的主场景。
     */
    (userId) =>
      grantRepo
        .listActiveByUser(userId)
        .then((gs) => gs.map((g) => ({ vin: g.vin, role: g.role }))),
    ),
  );
  /*
   * 车机绑定（M24-05）。网关自装一份 CabinClient——绑定回写走同一个④档案 store
   * （写后缓存失效，agent-runtime 侧立即可见）。语义全部在 @carlife/tools，
   * 这里只是把它接到 REST 上。
   */
  const cabinUrl = (process.env.MOCK_CABIN_URL ?? "").trim();
  const cabinBindingStore: CabinBindingStore = {
    async load(vin) {
      const profile = await vehicleStore.get(vin);
      return profile ? { model: profile.model, cabinVehicleId: profile.cabinVehicleId } : null;
    },
    async save(vin, cabinVehicleId) {
      const profile = await vehicleStore.get(vin);
      if (!profile) throw new Error(`车辆档案不存在，绑定无处回写：${vin}`);
      await vehicleStore.upsert({ ...profile, cabinVehicleId });
    },
  };
  const cabinClient = cabinUrl
    ? createCabinClient(createHttpCabinBackend(cabinUrl), cabinBindingStore)
    : undefined;
  consoleCabinClient = cabinClient;
  app.use(
    createVehicleCabinRouter({
      vehicles: vehicleStore,
      cabin: cabinClient,
    }),
  );
  // 让路（M27）：播报期间压低车内音乐。与绑定端点分开挂——那是设备接入，
  // 这是播放器命令，混在一起下次查"绑定为什么失败"会先读到一堆音量逻辑。
  app.use(
    createCabinMediaRouter({
      cabin: cabinClient,
    }),
  );

  // 常用人员（M17-04，F-46-11）。名单与档案同库；画像清理经 Mem0，未接入时降级为
  // "只删档案与归属"，不因此拒绝用户的删除操作。
  app.use(
    createVehicleMemberRouter({
      members: createVehicleMemberRepository(prisma),
      vehicles: vehicleStore,
      trips: createTripRepository(prisma),
      // 组合偏好（M24-06）：删人时级联失效（不删不重组，AC-50-10）
      combinations: createMemberCombinationRepository(prisma),
      /*
       * 审计走日志而不是 `audit_logs` 表：那张表的 `actorRole` 是 admin|ops
       * （后台操作审计），把车主自己的动作塞进去会污染它的语义。
       * **只记 id 与动作，不记称呼**——他人 PII 不进日志（M17-03 定的纪律）。
       */
      audit: (e) =>
        console.log(
          `[member] ${e.action} actor=${e.actor} target=${e.target ?? "-"} ${JSON.stringify(e.detail ?? {})}`,
        ),
    }),
  );
  /*
   * 档案页的数据面（M14-09 / M14-10）：⑥用车画像、按人画像、③偏好。
   *
   * Mem0 未配（`MEM0_*` / DATABASE_URL 缺）时不注入 preferences——端点据此 503
   * 且明说"未接入"。**混成 200 空结果会让"系统没接上"被说成"你没说过偏好"**。
   */
  const mem0Ready = Boolean(process.env.DATABASE_URL?.trim());
  app.use(
    createProfileDataRouter({
      vehicles: vehicleStore,
      members: createVehicleMemberRepository(prisma),
      trips: createTripRepository(prisma),
      preferences: mem0Ready ? createMem0PreferenceReader() : undefined,
    }),
  );
  app.use(createStreamRouter(repo, bus));
  app.use(
    createHttpRouter(repo, bus, asr, (sample) => {
      // ASR（豆包 omni）计价：音频输入按 ASR_PRICE_INPUT_PER_1K，输出按 OUTPUT。
      // 与 runtime 的 LLM 计价同一形态：单价是配置不是硬编码，fire-and-forget 不挡请求。
      void (async () => {
        const perK = async (key: string, fallback: number): Promise<number> => {
          const n = Number(await config.get(key));
          return Number.isFinite(n) ? n : fallback;
        };
        usage.record({
          /*
           * 哨兵段**不建轮**（AC-52-5：判定后即弃），所以没有真实的会话与轮次。
           * 这里填常量而不是编一个 uuid：编出来的 id 会让人以为它能 join 回
           * 会话表，查不到时又变成"数据丢了"的错觉。常量 `sentinel` 反而是
           * 一个可查的分组——`@@index([sessionId])` 让它天然可筛。
           */
          sessionId: sample.sessionId ?? "sentinel",
          turnId: sample.turnId ?? "sentinel",
          // 成本归因按入口分（§13 待确认 22 的"按端可拆解"）：哨兵段与对话轮次
          // 量级差一个数量级，混成一个 agent 名就说不清钱花在哪。
          agent: sample.source === "sentinel" ? "asr-sentinel" : "asr",
          // **不能硬编码 vendor 名**：ACR-015 接进 aliyun 档之后，写死 "ark"
          // 会把阿里云的调用记成火山的账，两条云 vendor 在 /console/usage 里
          // 从此分不开——而"按 vendor 看用量"正是这张表存在的理由。
          provider: await currentAsrEngine(),
          model: sample.model,
          promptTokens: sample.inputTokens,
          completionTokens: sample.outputTokens,
          durationMs: sample.durationMs,
          status: "ok",
          costEstimate:
            (sample.inputTokens / 1000) * (await perK("ASR_PRICE_INPUT_PER_1K", 0.003)) +
            (sample.outputTokens / 1000) * (await perK("ASR_PRICE_OUTPUT_PER_1K", 0.002)),
        });
      })().catch((err: unknown) => console.error("[usage] ASR 成本估算失败", err));
    },
    /*
     * 上车声明的成员集合（M48-05）：车机建会话时校验"声明的这个人在不在名单里"。
     * 与成员管理端点用**同一个** grantRepo 与车表——两处各查一份迟早对不上，
     * 而对不上的表现是"车主刚移除的人还能在车机上被选中"。
     */
    {
      ownerOf: async (vin) => (await vehicleStore.get(vin))?.ownerId ?? null,
      activeMemberIds: async (vin) =>
        (await grantRepo.listActiveByVin(vin)).map((g) => g.userId),
    },
    asrGate,
    // 助手回复落库时记下当前下发的 TTS 档位（M60-01）。走 resolveTts 而不是
    // 直接读 TTS_ENGINE：aliyun 档的实际形态由它决定，两处各判一次迟早分家。
    async () => {
      try {
        return resolveTts(await config.runtimeValues()).engine;
      } catch {
        return null;
      }
    },
    /*
     * 车主录音的转存（M60-02）。对象存储没接就不注入，路由回落本地落盘。
     * 只有建轮那条路会调到它——哨兵段不建轮，那条边界由结构保证（AC-52-5）。
     */
    objectStore
      ? async ({ sessionId, messageId, engine, bytes, mime }) => {
          const key = audioObjectKey(sessionId, messageId, "asr", mime);
          await objectStore.put(key, bytes, mime);
          await messageAudioRepo.put({
            messageId,
            kind: "asr",
            engine,
            // 车主这段是端上真录进来的波形，不是事后补的。
            origin: "captured",
            mime,
            bytes: bytes.length,
            objectKey: key,
          });
        }
      : undefined),
  );
  return app;
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  createGatewayApp().listen(PORT, () => {
    console.log(`[gateway] listening on :${PORT}`);
  });
}
