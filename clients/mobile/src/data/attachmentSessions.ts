/**
 * 句柄 → 上传时的那个会话（2026-09-18 真机 INC：拍照问诊「上传失败 attachment_not_owned」）。
 *
 * # 它治的是什么
 *
 * 附件句柄在服务端**按会话归属**：`POST /messages` 时网关逐个比对 `sessionId` 与 `userId`，
 * 对不上整轮拒绝（`enterprise/backend/gateway/src/http/attachments.ts`）。而端上"上传"与"发消息"
 * 是两次独立地拿会话（`ensureUsableSession`），中间只要换过一次会话，车主刚拍的那张就发不出去。
 *
 * 实测（dev 库，2026-09-18 02:23:36）：句柄 `U1gNHnV3…` 落在 `sess-82141ba8`，18 ms 后端上又建了
 * `sess-a911010f` 并把消息发去那里，于是网关 400 —— 屏幕上是一句带 JSON 的「上传失败」。
 *
 * # 为什么"一组句柄不一致就不 pin"
 *
 * 宁可退回普通判定让网关拒绝（用户还能重拍），也不要 pin 到其中一个会话上：
 * 那会让另一半照片悄悄丢掉，正是附件通路从第一天起就不接受的那种失败。
 */

/** 记多少条。一轮最多 9 张 + 1 段，留几轮的余量即可。 */
const DEFAULT_LIMIT = 32;

export interface AttachmentSessions {
  /** 上传成功时记一笔。 */
  remember(handle: string, sessionId: string): void;
  /** 这一组句柄共同的会话；有一个不认识或彼此不一致就 `undefined`。 */
  sessionFor(handles: readonly string[] | undefined): string | undefined;
}

export function createAttachmentSessions(limit: number = DEFAULT_LIMIT): AttachmentSessions {
  const seen = new Map<string, string>();
  return {
    remember(handle, sessionId) {
      // 重记同一个句柄要挪到队尾：Map 的迭代序就是插入序，不删旧的话它会被当成最老的先淘汰。
      seen.delete(handle);
      seen.set(handle, sessionId);
      while (seen.size > limit) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
    },
    sessionFor(handles) {
      if (!handles || handles.length === 0) return undefined;
      const first = seen.get(handles[0]);
      if (!first) return undefined;
      return handles.every((h) => seen.get(h) === first) ? first : undefined;
    },
  };
}
