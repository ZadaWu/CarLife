/**
 * 评测里带图（施工单 M71-04）：把照片经网关上传成附件句柄，随消息一起发。
 *
 * 走的就是端上那条路（`POST /v1/session/:id/attachments` 原始 body + `content-type`），
 * 不绕网关直写对象存储——评的是链路，不是观察层本身（那在 eval:vision-observe）。
 */

import { readFileSync } from "node:fs";

export interface UploadedAttachment {
  handle: string;
  bytes: number;
  kind: string;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export async function uploadAttachment(
  gateway: string,
  sessionId: string,
  filePath: string,
  authedInit: (init?: RequestInit) => RequestInit,
): Promise<UploadedAttachment> {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME[ext];
  if (!mime) throw new Error(`不支持的图片扩展名：${filePath}`);
  const body = readFileSync(filePath);
  const init = authedInit({ method: "POST", body });
  const headers = new Headers(init.headers);
  headers.set("content-type", mime);
  headers.set("x-filename", filePath.split("/").pop() ?? "photo");
  const res = await fetch(`${gateway}/v1/session/${sessionId}/attachments`, { ...init, headers });
  if (!res.ok) throw new Error(`上传附件失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as UploadedAttachment;
  if (!json.handle) throw new Error(`上传附件返回无句柄：${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/** 评测里 `attachment` 字段相对 `evals/` 的路径 → 绝对路径。 */
export function resolveEvalAsset(root: string, rel: string): string {
  return `${root}evals/${rel}`;
}
