/**
 * 网关连接设置**弹层**（ACR-004 第 3 步；M33-05 只留壳，表单搬去 `GatewayForm`）。
 *
 * # 它现在只剩一个用途：iOS 首启引导
 *
 * 日常改地址已经归底部导航的「设置」页（M33-05）。这一层保留是因为
 * **首启是引导语境**：那时候不该先教用户认底部导航，弹层直接把他挡在
 * 那个必须填的字段前面。
 *
 * iPad 版没有环境变量：App 由 Swift 壳拉起，`.env` 不存在，默认的 localhost
 * 指向 iPad 自己——不给用户一个填 Mac Studio 地址的地方，iPad 版永远连不上
 * 网关，且症状只是"所有数据都是空的"。
 */
import { GatewayForm } from "./GatewayForm";

import "./settings.css";

export interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** 首启引导语境（iOS 第一次打开）：文案从"设置"换成"先连上你的服务器"。 */
  firstRun?: boolean;
}

export function SettingsSheet({ open, onClose, firstRun = false }: SettingsSheetProps) {
  if (!open) return null;

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="网关连接设置">
      <div className="settings-sheet">
        <h2>{firstRun ? "先连上你的服务器" : "网关连接"}</h2>
        <GatewayForm firstRun={firstRun} onCancel={onClose} active={open} />
      </div>
    </div>
  );
}
