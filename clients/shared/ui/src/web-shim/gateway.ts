/**
 * 垫片用的网关客户端（ACR-049）。
 *
 * 只发**同源相对路径** `/v1/*`——线上由 nginx 反代到网关，开发期由 vite 的 proxy 代劳。
 * 这与 `clients/demo-web` 是同一个地基：浏览器眼里没有跨源，网关不需要 CORS。
 *
 * 鉴权头不用 `Authorization`：魔搭创空间的边缘把它连同 `X-modelscope-*` / `X-studio-*`
 * 保留给平台自己，带着它的请求到不了容器（403）。换成 `x-carlife-auth` 并同时写一个
 * 同源 cookie，nginx 把它翻回标准头再发给网关（ACR-048 已验证两条通道都通）。
 */

export const AUTH_HEADER = "x-carlife-auth";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 响应体原文。网关的拒绝带面向用户的 `reason`（F-09-10），丢了它界面只剩一个状态码。 */
    readonly body: string = "",
  ) {
    super(message);
  }
}

export interface Credentials {
  username: string;
  password: string;
}

export interface AuthUser {
  id: string;
  displayName: string | null;
}

type FetchLike = typeof fetch;

export class Gateway {
  private token: string | null = null;
  private user: AuthUser | null = null;
  private loggingIn: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: FetchLike,
    private credentials: Credentials,
    private readonly setCookie: (value: string) => void = () => undefined,
  ) {}

  currentUser(): AuthUser | null {
    return this.user;
  }

  /** 换账号登录（端上登录门手输口令时走这里）。 */
  async login(credentials?: Credentials): Promise<AuthUser> {
    if (credentials) this.credentials = credentials;
    const res = await this.fetchImpl("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.credentials),
    });
    if (!res.ok) throw new GatewayError("/v1/auth/login → " + res.status, res.status);
    const body = (await res.json()) as { accessToken: string; user: AuthUser };
    this.token = body.accessToken;
    this.user = body.user;
    // cookie 只存裸 token：带空格的 "Bearer " 在 cookie 值里非法，编码后 nginx 拼出的头是坏的（实测 401）
    this.setCookie(body.accessToken);
    return body.user;
  }

  logout(): void {
    this.token = null;
    this.user = null;
    this.setCookie("");
  }

  /** 并发的首批请求只登录一次——端启动时十几个命令同时进来，各登各的会把限流打满。 */
  private ensureLogin(): Promise<void> {
    if (this.token) return Promise.resolve();
    this.loggingIn ??= this.login().then(
      () => {
        this.loggingIn = null;
      },
      (err) => {
        this.loggingIn = null;
        throw err;
      },
    );
    return this.loggingIn;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra ?? {}), ...(this.token ? { [AUTH_HEADER]: "Bearer " + this.token } : {}) };
  }

  /**
   * 发一个带鉴权的请求。access token 只有 15 分钟，而访客多半是"开着页面看一会儿再动手"，
   * 所以 401 时重登一次再发——只重试一次，口令真错了不会死循环。
   */
  async request(method: string, path: string, init?: { json?: unknown; body?: BodyInit; headers?: Record<string, string> }): Promise<Response> {
    await this.ensureLogin();
    const send = () =>
      this.fetchImpl(path, {
        method,
        headers: this.authHeaders({
          ...(init?.json !== undefined ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        }),
        body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      });
    let res = await send();
    if (res.status === 401) {
      this.token = null;
      await this.ensureLogin();
      res = await send();
    }
    if (!res.ok) throw new GatewayError(path + " → " + res.status, res.status, await res.text().catch(() => ""));
    return res;
  }

  /** 原样返回响应体文本——Rust 那侧大多数命令就是把网关的 JSON 串原样交给 WebView。 */
  async text(method: string, path: string, json?: unknown): Promise<string> {
    return (await this.request(method, path, json === undefined ? undefined : { json })).text();
  }

  async json<T>(method: string, path: string, json?: unknown): Promise<T> {
    return (await this.request(method, path, json === undefined ? undefined : { json })).json() as Promise<T>;
  }

  /** 打开一条 SSE。返回响应，调用方自己读流；AbortSignal 用来关。 */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    await this.ensureLogin();
    const open = () =>
      this.fetchImpl(path, { headers: this.authHeaders({ accept: "text/event-stream" }), signal });
    let res = await open();
    if (res.status === 401) {
      this.token = null;
      await this.ensureLogin();
      res = await open();
    }
    if (!res.ok || !res.body) throw new GatewayError(path + " → " + res.status, res.status);
    return res;
  }
}
