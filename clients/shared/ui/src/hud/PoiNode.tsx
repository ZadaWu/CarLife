/**
 * 生活环节点（施工单 M1-02）
 *
 * Brief §3.1：
 *  - 出发锚点必须是带屋顶/门窗/暖光的 3D 小屋，定位 pin 仅为辅助标记，不能替代家图标；
 *  - 每一站以**大号序号徽章优先于地点名**呈现，节点随真实计划变化并重新编号。
 */
import type { CSSProperties } from "react";
import { LABEL_OFFSET_Y, NODE_ANCHORS } from "./layout";

export interface PoiNodeProps {
  /** 锚点 key，决定落位；同时用于取标签偏移。 */
  anchor: keyof typeof NODE_ANCHORS | string;
  /** 精灵图 URL（由车机端按主题传入）。 */
  sprite: string;
  /** 语义化地点名，例如「亲子乐园」。不展示精确住址。 */
  name: string;
  /** 行程序号；出发锚点传 undefined，改用「出发」徽标。 */
  index?: number;
  /** 是否为出发锚点（家）。 */
  origin?: boolean;
  /**
   * 出发锚点上显示的文字，缺省「出发」。
   *
   * 没有行程时这里放**车主常住地**（M13-10）：那一屏没有"出发"这回事，
   * 它回答的是"车现在在哪"。有行程时仍是「出发」——那时它确实是起点。
   */
  originLabel?: string;
  /** 是否为终点（末站，配合 LifeRing 的收束光晕）。 */
  terminal?: boolean;
}

export function PoiNode({ anchor, sprite, name, index, origin, originLabel, terminal }: PoiNodeProps) {
  const place = NODE_ANCHORS[anchor] ?? NODE_ANCHORS.home;
  const labelY = LABEL_OFFSET_Y[anchor] ?? 116;

  const style: CSSProperties = {
    left: `${(place.cx / 1672) * 100}%`,
    top: `${(place.cy / 941) * 100}%`,
    width: `${(place.width / 1672) * 100}%`,
  };

  return (
    <div
      className={`hud-poi${terminal ? " hud-poi--terminal" : ""}`}
      style={style}
      data-anchor={anchor}
    >
      <img className="hud-poi__sprite" src={sprite} alt="" aria-hidden="true" />

      {/* 标签中心 = 节点中心 + labelY 个设计基准像素（top:50% 即节点中心） */}
      <div
        className="hud-poi__label"
        style={{
          top: "50%",
          transform: `translate(-50%, calc(-50% + ${labelY} * var(--hud-unit)))`,
        }}
      >
        {origin ? (
          <span className="hud-poi__origin">{originLabel ?? "出发"}</span>
        ) : (
          <span className="hud-poi__pill">
            <span className="hud-poi__index">{index}</span>
            <span className="hud-poi__name">{name}</span>
          </span>
        )}
      </div>

      {/* 屏幕阅读器读到的是完整语义，视觉上仍是序号优先 */}
      <span className="hud-sr-only">
        {origin ? `${originLabel ?? "出发地"} ${name}` : `第 ${index} 站 ${name}${terminal ? "（终点）" : ""}`}
      </span>
    </div>
  );
}
