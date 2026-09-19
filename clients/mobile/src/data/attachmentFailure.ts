/**
 * 附件失败的说人话版本（2026-09-18 真机走查：拍照页上把网关的 JSON 原样怼在车主脸上）。
 *
 * 屏幕上原来是 `rejected: status=400 body={"error":"attachment_not_owned","handle":"U1gN…"}`——
 * 里面没有一个字告诉车主该怎么办。这里只做一件事：把认得出的错误码换成一句人话 + 下一步动作；
 * **认不出的原样留着**，排查时还得靠它（宁可丑，不可把真实错因吞掉）。
 */
const KNOWN: ReadonlyArray<{ code: string; text: string }> = [
  // 句柄属于另一段对话：通常是上传与发送之间换了会话。重拍一张即可，别让车主以为是网络坏了。
  { code: "attachment_not_owned", text: "这张照片和当前对话对不上了，重拍一张就好" },
  { code: "attachment_already_bound", text: "这张照片已经发过了，重拍一张" },
  { code: "attachment_not_found", text: "照片在服务端找不到了，重拍一张" },
  { code: "attachment_unavailable", text: "照片暂时读不出来，稍后重试" },
  { code: "attachment_too_many_images", text: "这一轮的照片已经够多了，先发出去再拍" },
  { code: "attachment_kind_unsupported", text: "这种文件发不了，换一张照片" },
  { code: "attachment_invalid", text: "照片没能通过校验，重拍一张" },
];

export function explainAttachmentFailure(reason: string): string {
  const hit = KNOWN.find((k) => reason.includes(k.code));
  return hit ? hit.text : reason;
}
