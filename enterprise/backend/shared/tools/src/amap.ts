/**
 * 高德开放平台客户端（施工单 M10-01，§5 工具表「地图 API」）。
 *
 * # 为什么是注入而不是在这里读配置
 *
 * 与 `ragflow.ts` 同一条规矩：`enterprise/backend/shared/tools` 不读环境变量、不连数据库，
 * 它要能脱离 Agent 与 LLM 直接单测（AC-34-4）。key 由装配层
 * （`agent-runtime` 启动时）经 `setAmapClient` 注入；未注入即"未接入"。
 *
 * # 高德的失败不在 HTTP 状态码里
 *
 * 它一律返回 **200**，靠 `status:"0"` + `infocode` 表达失败。把"200 即成功"
 * 直接写进代码，是接高德最容易踩的坑——限流会被当成正常空结果，
 * key 填错会被当成"这条路查不到"。因此本文件只有 `ok()` 一个出口，
 * 所有响应都必须过它，并按 infocode 分成**可重试**与**不可重试**两类：
 * 限流/QPS 类重试有意义，key 非法与参数错重试多少次都一样。
 *
 * # 两把 key 不能互换
 *
 * Web 服务（REST，本文件用的）与 Web 端（JS API，前端用的）是两种应用类型。
 * 拿错会得到 `10009 USERKEY_PLAT_NOMATCH`——错误信息里明说，省得去翻文档。
 */

import { ToolError } from "./external";

/** 经纬度。高德全程用 GCJ-02，**不做坐标系转换**——转换错了比不转更难查。 */
export interface LngLat {
  lat: number;
  lon: number;
}

export interface AmapPlace extends LngLat {
  name: string;
  adcode: string;
  city: string;
}

/**
 * 行政区（`/v3/config/district`）。**`adcode` 是唯一没有歧义的 region 入参。**
 *
 * 中文地名当 region 传给 place/text 是一场赌博：高德只认它自己的行政区名，
 * 认不出来时**不报错**，忽略 `city_limit` 按全国搜（见 `textSearch` 的注释与
 * 内部文档）。adcode 没有这个问题——它要么是一个行政区，要么不是。
 */
export interface AmapRegion {
  adcode: string;
  /** 高德给的规范名，如「杭州市」。 */
  name: string;
  /** 只收这三级；街道/乡镇级不足以当限定范围（「西溪」是街道，不是「西溪湿地那一片」）。 */
  level: "province" | "city" | "district";
}

/** 逆地理结果，只取天气与展示要用的几项。 */
export interface AmapRegeo {
  adcode: string;
  city: string;
  district: string;
  formatted: string;
}

/** 高德预报的一天（`extensions=all` 的 `casts[]`）。 */
export interface AmapCast {
  date: string;
  dayWeather: string;
  nightWeather: string;
  dayTempC: number | null;
  nightTempC: number | null;
  dayWind: string;
  dayPower: string;
}

export interface AmapForecast {
  city: string;
  adcode: string;
  reportTime: string;
  casts: AmapCast[];
}

export interface AmapStep {
  instruction: string;
  /** 米 */
  distanceM: number;
  /** 秒 */
  durationS: number;
  /** 该段折线的点序列（`show_fields=polyline` 才有） */
  points: LngLat[];
}

export interface AmapPath {
  distanceM: number;
  durationS: number;
  tollYuan: number;
  trafficLights: number;
  steps: AmapStep[];
}

export interface AmapPoi extends LngLat {
  id: string;
  name: string;
  type: string;
  typecode: string;
  address: string;
  cityName: string;
  /** 距检索中心的米数 */
  distanceM: number | null;
}

/**
 * 文本搜索 POI（v5/place/text，`show_fields=business`）。
 *
 * `rating` 是真实数据；**没有价格字段**——实测（2026-08-11）`business.cost`
 * 酒店类目恒空（含白天鹅宾馆），这里不建这个字段，模型就没有地方把房价编进来。
 */
export interface AmapTextPoi extends AmapPoi {
  /** 高德评分（如 "4.7"）；接口没给就是 undefined，不猜。 */
  rating?: string;
  /** 省（`pname`），如「浙江省」。 */
  province: string;
  /** 区县（`adname`），如「西湖区」。 */
  district: string;
  /** 命中点所在区县的 adcode——`cityLimit` 的**验证材料**，见 textSearch。 */
  adcode: string;
}

/** 跨城公交方案里的一段火车（v3/direction/transit/integrated 的 railway 段）。 */
export interface AmapTrainLeg {
  /** 车次，如 "G1305(上海虹桥-广州南)"。 */
  no: string;
  /** 类别（G/D/K…），接口的 trip 字段。 */
  trip: string;
  /** 行车分钟数。 */
  durationMin: number;
  /** 各席别票价（元）。接口没给席别名，只给价——如实只存价。 */
  prices: number[];
}

/** 一条跨城方案：总时长 + 总票价 + 火车段序列（可能中转多段）。 */
export interface AmapTransit {
  durationMin: number;
  /** 整套方案票价（元），接口的 cost。 */
  costYuan: number | null;
  trains: AmapTrainLeg[];
}

export interface AmapClient {
  /**
   * 地名 → 行政区（`/v3/config/district`）。认不出来（或只到街道级）就是 undefined。
   *
   * 带进程内缓存：行政区划是静态数据，一次会话里同一个词不该反复问。
   */
  resolveRegion(name: string, signal?: AbortSignal): Promise<AmapRegion | undefined>;
  /**
   * POI 文本搜索（v5/place/text）。
   *
   * `cityLimit` 恒传 true 的责任在调用方（poi_search 工具）——
   * 实测搜「广州 酒店」不限市时排序跑到增城的公寓，结果不可用。
   */
  textSearch(
    params: { keywords: string; region: string; types?: string; cityLimit?: boolean; limit?: number },
    signal?: AbortSignal,
  ): Promise<AmapTextPoi[]>;
  /**
   * 跨城公交规划（v3/direction/transit/integrated），只保留含火车段的方案。
   *
   * ⚠️ 该接口的 segment 类型只有 bus/entrance/exit/railway/taxi/walking——
   * **航班结构性不存在**（实测沪→乌鲁木齐只回 41h 火车）。别在这找飞机。
   */
  transitIntegrated(
    params: { origin: LngLat; destination: LngLat; city: string; cityd: string; strategy?: number },
    signal?: AbortSignal,
  ): Promise<AmapTransit[]>;
  /** 地名 → 坐标（v3/geocode/geo）。取第一条，多义地名由调用方给 `city` 收敛。 */
  geocode(address: string, city?: string, signal?: AbortSignal): Promise<AmapPlace>;
  /** 坐标 → adcode（v3/geocode/regeo）。带进程内缓存，见 `regeoCacheKey`。 */
  regeo(at: LngLat, signal?: AbortSignal): Promise<AmapRegeo>;
  /** 城市预报（v3/weather，`extensions=all`）：**今天起 4 天**，再远没有。 */
  forecast(adcode: string, signal?: AbortSignal): Promise<AmapForecast>;
  /**
   * 驾车路径规划（v5/direction/driving）。
   *
   * `strategy` 是高德的算路策略码（M66-01）：`32` 默认推荐、`34` 高速优先、`35` 不走高速、`36` 少收费。
   * 不传 = 请求串里没有这个参数，与从前逐字相同。取值的枚举与语义在 `map-route.ts` 的 `AMAP_STRATEGY`，
   * 这里只透传数字——客户端不该知道"省钱"是哪一档。
   */
  driving(
    params: { origin: LngLat; destination: LngLat; waypoints?: LngLat[]; strategy?: number },
    signal?: AbortSignal,
  ): Promise<AmapPath>;
  /** 周边 POI（v5/place/around）。 */
  around(
    params: { at: LngLat; types: string; radiusM: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<AmapPoi[]>;
}

const BASE = "https://restapi.amap.com";

/**
 * 值得重试的 infocode：限流、并发超限、引擎临时异常。
 *
 * **配额用尽（10003 日调用量超限）不在其中**——今天重试一百次也还是超限，
 * 重试只会把日志刷满。它该冒到上层变成"今天的地图额度用完了"。
 */
const RETRYABLE_INFOCODES = new Set([
  "10004", // ACCESS_TOO_FREQUENT
  "10014", // QPS 超限（日承载量）
  "10015", // 批量并发超限
  "10019", // 服务响应超时
  "10020", // 服务并发超限
  "10021", // QPS 超限
  "10022", // 并发量超限
  "10023", // 单模块并发超限
  "10029", // 触发短时封禁
  "20800", // 规划路线时无法找到（偶发）
  "30000", // 引擎返回数据异常
  "30001",
  "30002",
  "30003",
]);

/** 常见错配的人话解释——这几条不解释的话，排查要去翻高德文档。 */
const EXPLAIN: Record<string, string> = {
  "10001": "key 不正确或已过期",
  "10003": "今日调用量已达上限（配额用尽，重试无用）",
  "10008": "MD5 安全码未通过验证",
  "10009": "key 与服务平台不匹配——服务端要用「Web 服务」类型的 key，不能用 Web 端(JS API) 的",
  "10012": "权限不足，该 key 未开通此服务",
  "20000": "请求参数非法",
  "20003": "请求可能存在异常，被高德拒绝",
};

interface AmapResponse {
  status?: string;
  info?: string;
  infocode?: string;
}

export interface AmapClientOptions {
  key: string;
  /** 注入 fetch 便于单测；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export function createAmapClient({ key, fetchImpl }: AmapClientOptions): AmapClient {
  const doFetch = fetchImpl ?? fetch;
  // regeo 的结果按坐标网格缓存：沿途取样点常常落在同一个区里，
  // 一条 400 公里的路线不该打十几次重复的逆地理（M10-01 约束 1）。
  const regeoCache = new Map<string, AmapRegeo>();
  // 行政区划是静态数据：同一个 region 词在一次会话里只该问一次（含"问不出来"）。
  const regionCache = new Map<string, AmapRegion | undefined>();

  async function get<T extends AmapResponse>(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, BASE);
    url.searchParams.set("key", key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await doFetch(url, { signal });
    if (!res.ok) {
      // 高德极少走到这里（它一律 200），真到了多半是网关问题 → 值得重试。
      throw new ToolError("amap", "upstream", `HTTP ${res.status}`, res.status >= 500);
    }
    const body = (await res.json()) as T;
    return ok(body, path);
  }

  /** 唯一出口：所有高德响应都必须过这里，不允许直接读 body。 */
  function ok<T extends AmapResponse>(body: T, path: string): T {
    const code = body.infocode ?? "";
    if (body.status === "1" && (code === "" || code === "10000")) return body;

    const explain = EXPLAIN[code];
    const detail = [`${path} 失败`, `infocode=${code || "?"}`, body.info, explain]
      .filter(Boolean)
      .join(" ");
    throw new ToolError(
      "amap",
      code === "10001" || code === "10009" || code === "10012" ? "unconfigured" : "upstream",
      detail,
      RETRYABLE_INFOCODES.has(code),
    );
  }

  /** 一次 district 查询，只收名字对得上的省/市/区。 */
  async function districtOf(name: string, signal?: AbortSignal): Promise<AmapRegion | undefined> {
    const body = await get<AmapResponse & { districts?: Array<Record<string, unknown>> }>(
      "/v3/config/district",
      { keywords: name, subdistrict: "0", extensions: "base" },
      signal,
    );
    for (const d of body.districts ?? []) {
      const level = textOf(d.level);
      if (level !== "province" && level !== "city" && level !== "district") continue;
      const adcode = textOf(d.adcode);
      const dn = textOf(d.name);
      if (!adcode || !dn) continue;
      // 接口对搜不到的词会回一堆模糊匹配（「西溪」回六个街道）——名字对不上就不算认出来。
      if (!nameOverlaps(name, dn)) continue;
      return { adcode, name: dn, level };
    }
    return undefined;
  }

  /*
   * 独立函数而不是只挂在返回对象上：`textSearch` 内部也要用它，而经 `this` 调用
   * 会在调用方解构（`const { textSearch } = client`）时炸掉。
   */
  async function resolveRegionCached(
    name: string,
    signal?: AbortSignal,
  ): Promise<AmapRegion | undefined> {
    const key = name.trim();
    if (!key) return undefined;
    if (regionCache.has(key)) return regionCache.get(key);
    /*
     * **失败不吞**：限流（10021）与"这个词不是行政区"是两回事，吞掉前者会让
     * 一次抖动变成整份行程一个坐标都不标。让它抛，交给调用方既有的重试
     * （`resolveTripPlanCoords` 隔 1s 再来一次）。
     */
    let hit = await districtOf(key, signal);
    /*
     * 认不出来时退到**前两个字**再试一次，且只收省/市级（M13-12 的「城市+片区」
     * 拼法：`上海嘉定` / `广州（演示）`）。
     *
     * 为什么不收区县级：两字前缀撞上别的城市的区名太容易——「西湖湖滨」的前两字
     * 是「西湖」，district 接口回的是**杭州西湖区**，这一次恰好对，
     * 下一次（比如某个「西湖」开头的北方片区）就是把整份行程圈到另一个城市。
     * 城市/省级的两字前缀没有这个歧义。
     */
    if (!hit && key.length > 2) {
      const head = await districtOf(key.slice(0, 2), signal);
      if (head && head.level !== "district") hit = head;
    }
    regionCache.set(key, hit);
    return hit;
  }

  return {
    resolveRegion: resolveRegionCached,

    async geocode(address, city, signal) {
      const body = await get<AmapResponse & { geocodes?: Array<Record<string, unknown>> }>(
        "/v3/geocode/geo",
        city ? { address, city } : { address },
        signal,
      );
      const first = body.geocodes?.[0];
      if (!first) {
        throw new ToolError("amap", "upstream", `地名解析不到坐标：${address}`, false);
      }
      const at = parseLngLat(String(first.location ?? ""));
      if (!at) {
        throw new ToolError("amap", "upstream", `地名解析返回的坐标不可读：${address}`, false);
      }
      return {
        ...at,
        name: textOf(first.formatted_address) || address,
        adcode: textOf(first.adcode),
        city: textOf(first.city) || textOf(first.province),
      };
    },

    async regeo(at, signal) {
      const cacheKey = regeoCacheKey(at);
      const hit = regeoCache.get(cacheKey);
      if (hit) return hit;

      const body = await get<AmapResponse & { regeocode?: Record<string, unknown> }>(
        "/v3/geocode/regeo",
        { location: `${round6(at.lon)},${round6(at.lat)}` },
        signal,
      );
      const comp = (body.regeocode?.addressComponent ?? {}) as Record<string, unknown>;
      const adcode = textOf(comp.adcode);
      if (!adcode) {
        throw new ToolError("amap", "upstream", `逆地理没有返回 adcode（${cacheKey}）`, false);
      }
      const value: AmapRegeo = {
        adcode,
        city: textOf(comp.city) || textOf(comp.province),
        district: textOf(comp.district),
        formatted: textOf(body.regeocode?.formatted_address),
      };
      regeoCache.set(cacheKey, value);
      return value;
    },

    async forecast(adcode, signal) {
      const body = await get<AmapResponse & { forecasts?: Array<Record<string, unknown>> }>(
        "/v3/weather/weatherInfo",
        { city: adcode, extensions: "all" },
        signal,
      );
      const f = body.forecasts?.[0];
      if (!f) {
        throw new ToolError("amap", "upstream", `没有 ${adcode} 的天气预报`, false);
      }
      const casts = ((f.casts ?? []) as Array<Record<string, unknown>>).map((c) => ({
        date: textOf(c.date),
        dayWeather: textOf(c.dayweather),
        nightWeather: textOf(c.nightweather),
        dayTempC: numOf(c.daytemp_float ?? c.daytemp),
        nightTempC: numOf(c.nighttemp_float ?? c.nighttemp),
        dayWind: textOf(c.daywind),
        dayPower: textOf(c.daypower),
      }));
      return {
        city: textOf(f.city),
        adcode: textOf(f.adcode) || adcode,
        reportTime: textOf(f.reporttime),
        casts,
      };
    },

    async driving({ origin, destination, waypoints, strategy }, signal) {
      const params: Record<string, string> = {
        origin: fmt(origin),
        destination: fmt(destination),
        show_fields: "cost,polyline",
      };
      if (waypoints?.length) params.waypoints = waypoints.map(fmt).join(";");
      if (strategy !== undefined) params.strategy = String(strategy);

      const body = await get<AmapResponse & { route?: Record<string, unknown> }>(
        "/v5/direction/driving",
        params,
        signal,
      );
      const path = ((body.route?.paths ?? []) as Array<Record<string, unknown>>)[0];
      if (!path) {
        throw new ToolError("amap", "upstream", "路径规划没有返回可行路线", false);
      }
      const cost = (path.cost ?? {}) as Record<string, unknown>;
      const steps = ((path.steps ?? []) as Array<Record<string, unknown>>).map((s) => {
        const sc = (s.cost ?? {}) as Record<string, unknown>;
        return {
          instruction: textOf(s.instruction),
          distanceM: numOf(s.step_distance) ?? 0,
          durationS: numOf(sc.duration) ?? 0,
          points: parsePolyline(textOf(s.polyline)),
        };
      });
      return {
        distanceM: numOf(path.distance) ?? 0,
        durationS: numOf(cost.duration) ?? 0,
        tollYuan: numOf(cost.tolls) ?? 0,
        trafficLights: numOf(cost.traffic_lights) ?? 0,
        steps,
      };
    },

    async around({ at, types, radiusM, limit }, signal) {
      const body = await get<AmapResponse & { pois?: Array<Record<string, unknown>> }>(
        "/v5/place/around",
        {
          location: fmt(at),
          types,
          radius: String(radiusM),
          page_size: String(Math.min(limit ?? 5, 25)),
        },
        signal,
      );
      const pois: AmapPoi[] = [];
      for (const p of (body.pois ?? []) as Array<Record<string, unknown>>) {
        const loc = parseLngLat(textOf(p.location));
        if (!loc) continue;
        pois.push({
          ...loc,
          id: textOf(p.id),
          name: textOf(p.name),
          type: textOf(p.type),
          typecode: textOf(p.typecode),
          address: textOf(p.address),
          cityName: textOf(p.cityname),
          distanceM: numOf(p.distance),
        });
      }
      return pois;
    },

    async textSearch({ keywords, region, types, cityLimit, limit }, signal) {
      const call = async (rg: string) => {
        const body = await get<AmapResponse & { pois?: Array<Record<string, unknown>> }>(
          "/v5/place/text",
          {
            keywords,
            region: rg,
            ...(types ? { types } : {}),
            ...(cityLimit ? { city_limit: "true" } : {}),
            show_fields: "business",
            page_size: String(Math.min(limit ?? 8, 25)),
          },
          signal,
        );
        return (body.pois ?? []) as Array<Record<string, unknown>>;
      };

      /*
       * **`city_limit` 会静默失效**（M13-12 起三次事故，见 内部文档）。
       *
       * 高德只认它自己的行政区名。上游给的常常不是行政区：「上海嘉定」这种
       * 城市+片区的拼法、「普陀山」这种景区名、「西湖湖滨」「灵隐-之江」这种
       * 行程片区名——**它解析不出来就忽略 city_limit 按全国搜，还照常 status=1**。
       *
       * 后果不是空结果那种一眼可见的失败，而是**看起来完全正常的错数据**。
       * 实测（2026-09-02，region 为片区名时的全国 top1）：
       *   · `雷峰塔` → 河南省南阳市淅川县的雷峰塔（111.55, 32.82）；
       *   · `西溪国家湿地公园`（region=西溪）→ 江西省上饶市广丰区（118.19, 28.46）。
       * 两个都排在杭州那个正主前面——因为全国范围内它们的**名字更贴合关键词**。
       *
       * 所以这一层不再拿中文地名去赌，改成两道硬判据：
       *
       *  1. **请求侧**：region 先经 `/v3/config/district` 归一成 **adcode** 再发
       *     （adcode 要么是一个行政区、要么不是，没有"解析不出来"这种中间态）。
       *     归一不出来就**不搜**——`cityLimit` 是个承诺，兑现不了就该空手而归，
       *     而不是拿一份全国结果冒充。
       *  2. **命中侧**：逐条比对 POI 自己的 `adcode` 前缀（省 2 位 / 市 4 位 / 区 6 位）。
       *     高德哪天又"忽略"一次 city_limit，也会被这一道拦下来。
       *
       * `cityLimit` 为 false（如 route_audit 没拿到 city）时行为不变：全国搜，
       * 不作承诺也就不必兑现。
       */
      let raw: Array<Record<string, unknown>>;
      let scope: AmapRegion | undefined;
      if (cityLimit && region.trim()) {
        scope = await resolveRegionCached(region, signal);
        if (!scope) {
          console.warn(`[amap] region「${region}」不是高德认识的行政区，city_limit 无法兑现——不返回结果`);
          return [];
        }
        raw = await call(scope.adcode);
      } else {
        raw = await call(region);
      }

      const pois: AmapTextPoi[] = [];
      for (const p of raw) {
        if (scope && !underRegion(textOf(p.adcode), scope)) continue;
        const loc = parseLngLat(textOf(p.location));
        if (!loc) continue;
        const business = (p.business ?? {}) as Record<string, unknown>;
        const rating = textOf(business.rating);
        pois.push({
          ...loc,
          id: textOf(p.id),
          name: textOf(p.name),
          type: textOf(p.type),
          typecode: textOf(p.typecode),
          address: textOf(p.address),
          cityName: textOf(p.cityname),
          province: textOf(p.pname),
          district: textOf(p.adname),
          adcode: textOf(p.adcode),
          distanceM: numOf(p.distance),
          ...(rating ? { rating } : {}),
        });
      }
      return pois;
    },

    async transitIntegrated({ origin, destination, city, cityd, strategy }, signal) {
      const body = await get<
        AmapResponse & { route?: { transits?: Array<Record<string, unknown>> } }
      >(
        "/v3/direction/transit/integrated",
        {
          origin: fmt(origin),
          destination: fmt(destination),
          city,
          cityd,
          strategy: String(strategy ?? 0),
        },
        signal,
      );
      const out: AmapTransit[] = [];
      for (const t of body.route?.transits ?? []) {
        const trains: AmapTrainLeg[] = [];
        for (const seg of (t.segments ?? []) as Array<Record<string, unknown>>) {
          const rw = (seg.railway ?? {}) as Record<string, unknown>;
          const no = textOf(rw.name);
          if (!no) continue;
          const prices = ((rw.spaces ?? []) as Array<Record<string, unknown>>)
            .map((s) => numOf(s.cost))
            .filter((x): x is number => x !== null);
          trains.push({
            no,
            trip: textOf(rw.trip),
            durationMin: Math.round((numOf(rw.time) ?? 0) / 60),
            prices,
          });
        }
        // 只留含火车段的方案：纯公交/步行的跨城组合对"沪→广"这类问题没有意义。
        if (trains.length === 0) continue;
        out.push({
          durationMin: Math.round((numOf(t.duration) ?? 0) / 60),
          costYuan: numOf(t.cost),
          trains,
        });
      }
      return out;
    },
  };
}

// ── 注入点（与 setRagClient 同形态）─────────────────────────────

let client: AmapClient | undefined;

/** 装配层注入。传 undefined 表示未接入（离线 / 未配 AMAP_SERVER_KEY）。 */
export function setAmapClient(c: AmapClient | undefined): void {
  client = c;
}

export function getAmapClient(): AmapClient | undefined {
  return client;
}

// ── 小工具 ───────────────────────────────────────────────────

/** 高德要求 `lon,lat` 且最多 6 位小数——顺序反了不会报错，只会给你另一个国家的天气。 */
function fmt(at: LngLat): string {
  return `${round6(at.lon)},${round6(at.lat)}`;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * regeo 的缓存键：约 0.05° 网格（纬度方向 ~5.5km）。
 * 取样点密度远小于一个区，同区的点落进同一格即可复用。
 */
function regeoCacheKey(at: LngLat): string {
  return `${(Math.round(at.lat * 20) / 20).toFixed(2)},${(Math.round(at.lon * 20) / 20).toFixed(2)}`;
}

/**
 * 两个地名是否指同一处：一方包含另一方即可（「杭州」↔「杭州市」）。
 * 用在 district 接口的模糊匹配上——它对搜不到的词会回一堆不相干的行政区。
 */
function nameOverlaps(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * POI 的 adcode 是否落在限定范围内。
 *
 * adcode 是 6 位分级编码（省 2 位 + 市 2 位 + 区 2 位），前缀相同即在范围内：
 * 330106（杭州西湖区）在 330100（杭州市）之下，118 开头的上饶不在。
 * 拿不到 adcode 的命中**一律不收**——没有证据就不能算通过（ADR-008）。
 */
function underRegion(adcode: string, scope: AmapRegion): boolean {
  if (!/^\d{6}$/.test(adcode)) return false;
  const width = scope.level === "province" ? 2 : scope.level === "city" ? 4 : 6;
  return adcode.slice(0, width) === scope.adcode.slice(0, width);
}

function parseLngLat(s: string): LngLat | null {
  const [lon, lat] = s.split(",").map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lat, lon };
}

function parsePolyline(s: string): LngLat[] {
  if (!s) return [];
  const out: LngLat[] = [];
  for (const pair of s.split(";")) {
    const p = parseLngLat(pair);
    if (p) out.push(p);
  }
  return out;
}

function textOf(v: unknown): string {
  // 高德把"没有值"表达成 `[]`（不是 null、不是空串），直接 String() 会得到 ""——
  // 巧合正确，但换个字段就是 "[object Object]"。显式判一次。
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function numOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
