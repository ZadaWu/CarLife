/**
 * [F-09-06][AC-09-3] `/messages` 的附件绑定：句柄形状与上限、归属 / 会话 / 类型 / 已绑过 四种拒绝、取件后的转发体形状。
 * [F-09-10][AC-09-9] M80-01：视频进白名单；每轮 ≤ 9 张照片 + ≤ 1 段视频，超出按类别各有错误码。
 * 仓储与对象存储用桩；整轮拒绝而不是部分成功。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AttachmentMeta, AttachmentRepository } from "@carlife/db";

import { MAX_TURN_ATTACHMENTS, parseAttachmentRefs, resolveTurnAttachments } from "../src/http/attachments";
import type { ObjectStore } from "../src/upload/storage";

const meta = (over: Partial<AttachmentMeta>): AttachmentMeta => ({
  id: "handle_aaaaaaaa",
  sessionId: "s1",
  userId: "u1",
  kind: "image",
  contentType: "image/png",
  bytes: 3,
  objectKey: "k/handle_aaaaaaaa",
  createdAt: 0,
  ...over,
});

function repoWith(rows: AttachmentMeta[]): AttachmentRepository {
  return {
    async create() {},
    async get(h) {
      return rows.find((r) => r.id === h) ?? null;
    },
    async findByIdempotencyKey() {
      return null;
    },
    async list() {
      return rows;
    },
    async bindTurn() {
      return true;
    },
  };
}
const store: ObjectStore = {
  async put() {},
  async get(key) {
    return key.endsWith("missing") ? null : { body: new Uint8Array([1, 2, 3]), contentType: "image/png" };
  },
  async remove() {},
  async ensureBucket() {},
} as ObjectStore;

describe("[F-09-06][AC-09-3] parseAttachmentRefs", () => {
  it("缺省无附件；非法形状 400；超过上限 400；重复句柄去重", () => {
    assert.deepEqual(parseAttachmentRefs({}), { handles: [] });
    assert.deepEqual(parseAttachmentRefs({ attachments: "x" }), { error: "attachment_invalid" });
    assert.deepEqual(parseAttachmentRefs({ attachments: ["short"] }), { error: "attachment_invalid" });
    assert.deepEqual(parseAttachmentRefs({ attachments: Array.from({ length: MAX_TURN_ATTACHMENTS + 1 }, (_, i) => `handle_${i}aaaaaaa`) }), { error: "attachment_too_many" });
    assert.deepEqual(parseAttachmentRefs({ attachments: ["handle_aaaaaaaa", "handle_aaaaaaaa"] }), { handles: ["handle_aaaaaaaa"] });
  });
});

describe("[F-09-06][AC-09-3] resolveTurnAttachments", () => {
  it("存在 + 本会话本人 + 图片 + 未绑 → 取件并转 base64", async () => {
    const r = await resolveTurnAttachments({ handles: ["handle_aaaaaaaa"], sessionId: "s1", userId: "u1", repo: repoWith([meta({})]), store });
    assert.ok(r.ok);
    assert.equal(r.attachments[0].bytesBase64, Buffer.from([1, 2, 3]).toString("base64"));
    assert.equal(r.attachments[0].contentType, "image/png");
  });
  it("四种拒绝各有错误码，且整轮拒绝", async () => {
    const cases: Array<[AttachmentMeta[], string | undefined, string, string]> = [
      [[], "u1", "s1", "attachment_not_found"],
      [[meta({ userId: "u2" })], "u1", "s1", "attachment_not_owned"],
      [[meta({})], "u1", "s2", "attachment_not_owned"],
      [[meta({})], undefined, "s1", "attachment_not_owned"],
      [[meta({ kind: "audio", contentType: "audio/wav" })], "u1", "s1", "attachment_kind_unsupported"],
      [[meta({ turnId: "turn-old" })], "u1", "s1", "attachment_already_bound"],
      [[meta({ objectKey: "k/missing" })], "u1", "s1", "attachment_unavailable"],
    ];
    for (const [rows, userId, sessionId, expected] of cases) {
      const r = await resolveTurnAttachments({ handles: ["handle_aaaaaaaa"], sessionId, userId, repo: repoWith(rows), store });
      assert.ok(!r.ok && r.error === expected, `${expected}：实际 ${JSON.stringify(r)}`);
    }
    const mixed = await resolveTurnAttachments({ handles: ["handle_aaaaaaaa", "handle_bbbbbbbb"], sessionId: "s1", userId: "u1", repo: repoWith([meta({})]), store });
    assert.ok(!mixed.ok && mixed.handle === "handle_bbbbbbbb");
  });
});

describe("[F-09-10][AC-09-9] 每轮附件上限按类别计（M80-01）", () => {
  const rows = (n: number, kind: "image" | "video") =>
    Array.from({ length: n }, (_, i) => meta({ id: `handle_${kind}${String(i).padStart(6, "0")}`, kind, contentType: kind === "image" ? "image/jpeg" : "video/mp4", filename: `${kind}-${i}` }));
  it("9 张照片 + 1 段视频放行；转发体带 kind / bytes / filename", async () => {
    const all = [...rows(9, "image"), ...rows(1, "video")];
    const r = await resolveTurnAttachments({ handles: all.map((m) => m.id), sessionId: "s1", userId: "u1", repo: repoWith(all), store });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.attachments.length, 10);
    assert.equal(r.attachments.filter((a) => a.kind === "video").length, 1);
    assert.equal(r.attachments[0].filename, "image-0");
    assert.equal(r.attachments[0].bytes, 3);
    assert.equal(MAX_TURN_ATTACHMENTS, 10);
  });
  it("第 10 张照片 → attachment_too_many_images；第 2 段视频 → attachment_too_many_videos，且指出是哪个句柄", async () => {
    const tenImages = rows(10, "image");
    const a = await resolveTurnAttachments({ handles: tenImages.map((m) => m.id), sessionId: "s1", userId: "u1", repo: repoWith(tenImages), store });
    assert.ok(!a.ok && a.error === "attachment_too_many_images" && a.handle === tenImages[9].id);
    const twoVideos = rows(2, "video");
    const b = await resolveTurnAttachments({ handles: twoVideos.map((m) => m.id), sessionId: "s1", userId: "u1", repo: repoWith(twoVideos), store });
    assert.ok(!b.ok && b.error === "attachment_too_many_videos" && b.handle === twoVideos[1].id);
  });
});

describe("[F-09-06][AC-09-3] 端上的框随消息上行（ACR-045）", () => {
  const H = "handle_aaaaaaaa";
  const det = { width: 300, height: 400, items: [{ bbox: [111, 197, 189, 222], name: "parking_lights", conf: 0.97 }], inferMs: 120 };

  it("parseAttachmentRefs：detections 按句柄索引、形状对 → 一起带回；老端上不带就没有这个键", () => {
    const r = parseAttachmentRefs({ attachments: [H], detections: { [H]: det } });
    assert.ok(!("error" in r));
    assert.deepEqual(r.handles, [H]);
    assert.deepEqual(r.detections, { [H]: det });
    const plain = parseAttachmentRefs({ attachments: [H] });
    assert.ok(!("error" in plain) && !("detections" in plain));
  });

  it("parseAttachmentRefs：键不在附件里 / bbox 越界 / 超 24 条 / 没附件却带框 → attachment_invalid（不静默丢）", () => {
    assert.deepEqual(parseAttachmentRefs({ attachments: [H], detections: { handle_bbbbbbbb: det } }), { error: "attachment_invalid" });
    assert.deepEqual(parseAttachmentRefs({ attachments: [H], detections: { [H]: { ...det, items: [{ bbox: [0, 0, 1001, 1], name: "x", conf: 0.5 }] } } }), { error: "attachment_invalid" });
    assert.deepEqual(parseAttachmentRefs({ attachments: [H], detections: { [H]: { ...det, items: Array.from({ length: 25 }, () => det.items[0]) } } }), { error: "attachment_invalid" });
    assert.deepEqual(parseAttachmentRefs({ detections: { [H]: det } }), { error: "attachment_invalid" });
  });

  it("resolveTurnAttachments：框挂到对应的照片上；挂到视频句柄上按 attachment_kind_unsupported 拒", async () => {
    const store: ObjectStore = { async put() { throw new Error("no"); }, async get() { return { body: Buffer.from("abc"), contentType: "image/png" }; }, async delete() {} } as never;
    const ok = await resolveTurnAttachments({ handles: [H], sessionId: "s1", userId: "u1", repo: repoWith([meta({ id: H })]), store, detections: { [H]: det } });
    assert.ok(ok.ok);
    assert.deepEqual(ok.attachments[0].detections, det);
    const V = "handle_vvvvvvvv";
    const bad = await resolveTurnAttachments({ handles: [V], sessionId: "s1", userId: "u1", repo: repoWith([meta({ id: V, kind: "video", contentType: "video/mp4" })]), store, detections: { [V]: det } });
    assert.deepEqual(bad, { ok: false, error: "attachment_kind_unsupported", handle: V });
  });
});
