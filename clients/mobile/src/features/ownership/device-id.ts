/**
 * 车机 deviceId 的正常化与校验（施工单 M51-01，F-56-03）。
 *
 * # 为什么抽成纯函数
 *
 * 「车机终端」那一屏的其余部分要么是网络要么是相机，都不好测。
 * 而真正会出错的恰恰是这一层：车主对着另一块屏抄 32 位十六进制，
 * 抄错、抄漏、连着空格一起粘、把手机自己的编号填进去——每一种都要给出
 * **能指导修正的**话，而不是一句"格式不对"。
 *
 * # 最危险的那一种错误
 *
 * 把**本机**的 deviceId 当成车机的填进去。服务端会**成功**地把这台手机注册成车机，
 * 界面上看起来"绑定成功了"，直到有人发现车上那块屏还停在等待输入。
 * 所以 `validateDeviceId` 收一个 `selfId` 参数，专门拦它——
 * `clients/mobile/src-tauri/src/commands/profile.rs` 那条命令的注释也点了这件事。
 */

/** 服务端存的是小写 hex；32 位 = 128 bit（`carlife-core::device::new_id`）。 */
export const DEVICE_ID_LENGTH = 32;

/**
 * 去掉一切分隔痕迹并转小写。
 *
 * 允许空格、换行、连字符：车主可能从二维码工具、聊天记录、便签里粘过来，
 * 那些地方会自己插换行。为这个让人手动删一遍不值得。
 */
export function normalizeDeviceId(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toLowerCase();
}

/** 4 位一组，显示用。连成一串的 32 位十六进制，人眼对不齐。 */
export function formatDeviceId(id: string): string {
  const flat = normalizeDeviceId(id);
  return (flat.match(/.{1,4}/g) ?? []).join(" ");
}

export type DeviceIdCheck =
  | { ok: true; id: string }
  | { ok: false; reason: string };

/**
 * 校验一个车主输入/扫来的 deviceId。
 *
 * `selfId` 是**本机**的 deviceId（可不传，比如还没读到）。传了就会拦"填了自己"。
 * 每条 reason 都要说清**该怎么改**——"格式不对"这种话让人只能重抄一遍。
 */
export function validateDeviceId(raw: string, selfId?: string): DeviceIdCheck {
  const id = normalizeDeviceId(raw);

  if (id.length === 0) {
    return { ok: false, reason: "先在车机屏上扫码，或把屏幕上那串编号抄下来。" };
  }

  const bad = id.match(/[^0-9a-f]/);
  if (bad) {
    return {
      ok: false,
      reason: `只能是 0-9 与 a-f，这里出现了「${bad[0]}」——对着车机屏再核一遍。`,
    };
  }

  if (id.length !== DEVICE_ID_LENGTH) {
    return {
      ok: false,
      reason: `编号应该是 ${DEVICE_ID_LENGTH} 位，现在是 ${id.length} 位。`,
    };
  }

  if (selfId && id === normalizeDeviceId(selfId)) {
    return {
      ok: false,
      reason: "这是这台手机自己的编号。要填的是**车机屏上**显示的那一串。",
    };
  }

  return { ok: true, id };
}
