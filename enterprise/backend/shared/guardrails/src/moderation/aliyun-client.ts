/**
 * 阿里云 AI 安全护栏（green-cip）`MultiModalGuard` 客户端（施工单 TD-04，§8.2）。
 *
 * # 为什么手写签名而不引 SDK
 *
 * 阿里云只提供 Java / Python / PHP / Go 的 green-20220302 SDK，**没有 Node 版**
 * （见 内部文档 步骤三链接的 SDK 参考）。
 * 用通用 `@alicloud/openapi-client` 要拖进一整套 tea 运行时，
 * 而我们只需要一个 Action。RPC 签名是公开且稳定的算法，手写 40 行，零新依赖——
 * 与 `enterprise/backend/shared/tools/src/amap.ts` 手写高德客户端同一取舍。
 *
 * # 签名算法：RPC 风格 V1（HMAC-SHA1）
 *
 * 三处容易错、错了只表现为 `SignatureDoesNotMatch`：
 *  1. 百分号编码**不是** `encodeURIComponent`——除 `A-Za-z0-9-_.~` 外全部要编码，
 *     而 `encodeURIComponent` 放过了 `!'()*` 五个、还把空格编成 `+`、把 `~` 编成 `%7E`；
 *  2. 参数排序按**编码前**的键名字典序，且要包含全部公共参数；
 *  3. 密钥要在末尾**多加一个 `&`**（`AccessKeySecret + "&"`），这是 RPC 签名的历史遗留。
 */

/*
 * 用 WebCrypto 而不是 `node:crypto`。
 *
 * `enterprise/backend/shared/guardrails` 是零 Node 依赖的纯包——`check:arch` 的 guardrails-purity
 * 守着它"可被其它服务复用、可脱离 CarLife 单测"的定位。引一个 `node:` 内置
 * 就把它钉死在 Node 上了，而 HMAC-SHA1 与随机 UUID 在 WebCrypto 里都是标准件。
 * 代价是签名变成 async——调用点本来就是 async，没有实际影响。
 */

/** API 版本。green-cip 的 `MultiModalGuard` 属 Green 2022-03-02。 */
export const ALIYUN_GREEN_VERSION = "2022-03-02";

/** 审核服务类型（doc 请求参数表 `Service`）。 */
export type AliyunGuardService =
  | "query_security_check"
  | "response_security_check"
  | "query_security_check_pro"
  | "response_security_check_pro";

export interface AliyunGuardConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 接入地址，如 `https://green-cip.cn-shanghai.aliyuncs.com`。 */
  endpoint: string;
  /**
   * 超时。默认 5s。
   *
   * **不宜太长**：输入侧审核挡在图执行之前，用户在等第一个 token。
   * 超时的后果由 fail 模式接管（input fail-open / output fail-closed），
   * 不是把用户晾在那里。
   */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** doc 表 1 ServiceParameters 的子集——只保留文本审核用得上的。 */
export interface AliyunGuardParams {
  content: string;
  /** 唯一标识一轮「用户输入 + 大模型输出」，用于把 query/response 串起来看。 */
  chatId?: string;
  /**
   * 流式审核会话 id：同一 `sessionId` 的切片由**审核引擎自动拼接**后再判。
   * 这正是跨 chunk 脱敏（F-26-05）的服务端解法，见 `aliyun-guard.ts` 文件头。
   */
  sessionId?: string;
  /** 流式终止标识。传 `sessionId` 时建议一并传。 */
  done?: boolean;
  /** 账户维度：传了会结合同账号前后文一起判。 */
  accountId?: string;
  dataId?: string;
}

/** doc 表 3 Detail 的 `Type`（防护维度）。 */
export type AliyunGuardDimension =
  | "contentModeration"
  | "promptAttack"
  | "sensitiveData"
  | "modelHallucination"
  | "maliciousFile"
  | "maliciousUrl"
  | "waterMark"
  | "customLabel";

export type AliyunSuggestion = "pass" | "watch" | "mask" | "block";

export interface AliyunGuardResultItem {
  Label?: string;
  Description?: string;
  Confidence?: number;
  Level?: string;
  Ext?: {
    RiskWords?: string;
    Riskwords?: string;
    SensitiveData?: string[];
    /** 敏感内容检测给出的**脱敏后文本**——服务端已经替我们打好码。 */
    Desensitization?: string;
    CustomizedHit?: { LibName?: string; KeyWords?: string; Keywords?: string }[];
  };
}

export interface AliyunGuardDetail {
  Type?: AliyunGuardDimension;
  Suggestion?: AliyunSuggestion;
  Level?: string;
  Result?: AliyunGuardResultItem[];
}

export interface AliyunGuardResponse {
  Code?: number;
  Message?: string;
  RequestId?: string;
  Data?: {
    Suggestion?: AliyunSuggestion;
    Detail?: AliyunGuardDetail[];
  };
}

/**
 * 调用失败。`retryable` 由 Code 决定，**不由调用方猜**——
 * 408 权限/欠费重试一万次也一样，而 500/581 重试是对的（doc Code 说明）。
 */
export class AliyunGuardError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "AliyunGuardError";
  }
}

/** doc「Code说明」。408 与 588 是配置/配额问题，重试无用。 */
function explain(code: number, message?: string): { text: string; retryable: boolean } {
  switch (code) {
    case 400:
      return { text: `请求参数有误：${message ?? ""}`, retryable: false };
    case 408:
      return {
        text: "权限被拒——账号未授权 / 未开通 AI 安全护栏 / 欠费 / 被禁（重试无用，请查控制台）",
        retryable: false,
      };
    case 500:
      return { text: `服务端临时错误：${message ?? ""}`, retryable: true };
    case 581:
      return { text: "审核服务超时", retryable: true };
    case 588:
      return { text: "超出配额（QPS 上限 50/s），已被限流", retryable: false };
    default:
      return { text: `未知返回码 ${code}：${message ?? ""}`, retryable: false };
  }
}

/**
 * RPC 签名用的百分号编码。
 *
 * 规范是：**只有** `A-Za-z0-9-_.~` 原样保留，其余一律 `%XX`。
 * `encodeURIComponent` 与它有四处出入——它把空格编成 `+`、把 `~` 编成 `%7E`，
 * 并且**原样放过 `!'()*` 五个字符**。差一处就是 `SignatureDoesNotMatch`，
 * 而那个错误信息不会告诉你是哪一处。
 *
 * # 漏掉的是 `!'()` 四个，不是五个
 *
 * 2026-09-18/19 车机端连撤 8 轮"这条回答我收回了"，审计里一条 block 都没有、
 * 全是 fail-closed。根因是这里漏掉的 `(` 与 `)`：高德 POI 名里带半角括号
 * （`如家精选酒店(上海外滩南京路步行街店)`），它一旦被念进助手的回答，
 * 那一片送审就必然验签失败 → `finish()` 抛 → 整轮撤回。
 * 也就是说，**这条安全边界的可用性取决于回答里有没有半角括号**。
 *
 * ⚠️ 别把 `*` 也算进这次的故障范围：`encodeURIComponent` 确实放过它，但**旧版补丁
 * 已经显式把 `*` 单独 replace 成 `%2A` 了**，所以 markdown 加粗的两个星号从来
 * 没有触发过这次事故。真正漏的是 `!`、`'`、`(`、`)` 四个。把 `*` 一起说成根因，
 * 会让下一个人照着错误的触发条件去复现，怎么也复现不出来。
 *
 * 所以这里不再"从 `encodeURIComponent` 的结果上补丁"，而是直接按白名单编码：
 * 补丁式写法的问题是它只覆盖已经想到的字符，而规范给的是一份白名单。
 */
function percentEncode(v: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(v)) {
    // A-Z a-z 0-9 - _ . ~ 原样，其余按 UTF-8 字节逐个 %XX
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x2e ||
      byte === 0x7e
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** 规范化查询串：按**编码前**的键名排序，再逐对编码拼接。 */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
}

/** 待签名串（doc RPC 签名规范）。抽出来是为了能单测——签名错时它是唯一能对照的中间物。 */
export function stringToSign(method: "POST" | "GET", params: Record<string, string>): string {
  return `${method}&${percentEncode("/")}&${percentEncode(canonicalQuery(params))}`;
}

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 按 RPC 规范算 HMAC-SHA1 签名。 */
export async function signRpc(
  method: "POST" | "GET",
  params: Record<string, string>,
  accessKeySecret: string,
): Promise<string> {
  const enc = new TextEncoder();
  // 密钥末尾多一个 `&`——RPC 签名的历史遗留，漏了必然验签失败
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`${accessKeySecret}&`),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(stringToSign(method, params)));
  return toBase64(sig);
}

export interface AliyunGuardClient {
  moderate(service: AliyunGuardService, params: AliyunGuardParams): Promise<AliyunGuardResponse>;
}

export function createAliyunGuardClient(cfg: AliyunGuardConfig): AliyunGuardClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 5_000;

  return {
    async moderate(service, params) {
      const common: Record<string, string> = {
        Action: "MultiModalGuard",
        Version: ALIYUN_GREEN_VERSION,
        Format: "JSON",
        AccessKeyId: cfg.accessKeyId,
        SignatureMethod: "HMAC-SHA1",
        SignatureVersion: "1.0",
        SignatureNonce: crypto.randomUUID(),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        Service: service,
        // ServiceParameters 是 JSONString——**整个对象序列化成一个字符串参数**，
        // 不是展开成多个查询参数。展开的话签名能过，但服务端拿不到内容。
        ServiceParameters: JSON.stringify(params),
      };
      const signature = await signRpc("POST", common, cfg.accessKeySecret);

      const body = new URLSearchParams({ ...common, Signature: signature });

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(cfg.endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: ac.signal,
        });
      } catch (err) {
        // 网络层失败（含超时）算可重试：它与"账号没权限"是两回事
        throw new AliyunGuardError(
          -1,
          `审核服务不可达：${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      let json: AliyunGuardResponse;
      try {
        json = JSON.parse(text) as AliyunGuardResponse;
      } catch {
        throw new AliyunGuardError(res.status, `返回不是合法 JSON：${text.slice(0, 200)}`, res.status >= 500);
      }

      // HTTP 层非 200 时优先报 HTTP 状态：此时 body 里多半是网关错误而不是业务码
      if (!res.ok && json.Code === undefined) {
        throw new AliyunGuardError(res.status, `HTTP ${res.status}：${text.slice(0, 200)}`, res.status >= 500);
      }

      const code = json.Code ?? res.status;
      if (code !== 200) {
        const { text: why, retryable } = explain(code, json.Message);
        throw new AliyunGuardError(code, why, retryable, json.RequestId);
      }
      return json;
    },
  };
}
