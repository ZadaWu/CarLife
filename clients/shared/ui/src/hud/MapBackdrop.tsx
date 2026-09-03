/**
 * 程序化生活地图底图（施工单 M1-02）
 *
 * Brief §5 §7-2：两个主题的地图背景均须可辨识道路 / 水系 / 绿地，不得出现大面积
 * 纯白或纯黑；Brief §6：底图视觉优先级低于生活环、助手、序号与提示卡。
 *
 * 采用程序化 SVG 而非地图瓦片：可主题化、无网络与版权依赖，且不会把定稿里的
 * POI 烘焙进底图。路网用固定种子的伪随机生成（同一构图恒定，不会每次渲染抖动），
 * 密而细以贴近定稿的城市街道纹理——粗网格会喧宾夺主，违反 §6 的优先级要求。
 */
import { useMemo } from "react";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./layout";

/** mulberry32：确定性伪随机，保证同一构图在每次渲染/每个客户端完全一致。 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MapGeometry {
  minorH: string[];
  minorV: string[];
  arterials: string[];
  water: string[];
  greens: Array<[number, number, number]>;
  blocks: Array<[number, number, number, number]>;
}

function buildGeometry(): MapGeometry {
  const rand = mulberry32(20260807);
  const W = DESIGN_WIDTH;
  const H = DESIGN_HEIGHT;

  // 细密街道：间距**不等距**累加生成。等距 + 小抖动仍会读成规整网格，
  // 与定稿的城市肌理不符；用随机步长才能得到自然的街区疏密。
  const minorH: string[] = [];
  for (let y = -30; y < H + 40; ) {
    const a = y + (rand() - 0.5) * 34;
    const b = y + (rand() - 0.5) * 34;
    minorH.push(
      `M -40 ${a.toFixed(1)} C ${(W * 0.28).toFixed(0)} ${b.toFixed(1)}, ${(W * 0.66).toFixed(0)} ${(y + (rand() - 0.5) * 34).toFixed(1)}, ${W + 40} ${(y + (rand() - 0.5) * 26).toFixed(1)}`,
    );
    y += 34 + rand() * 58; // 不等距步长
  }

  const minorV: string[] = [];
  for (let x = -30; x < W + 40; ) {
    const a = x + (rand() - 0.5) * 30;
    minorV.push(
      `M ${a.toFixed(1)} -40 C ${(x + (rand() - 0.5) * 30).toFixed(1)} ${(H * 0.34).toFixed(0)}, ${(x + (rand() - 0.5) * 30).toFixed(1)} ${(H * 0.7).toFixed(0)}, ${(x + (rand() - 0.5) * 22).toFixed(1)} ${H + 40}`,
    );
    x += 38 + rand() * 66;
  }

  // 主干道：少量、略粗，构成城市骨架
  const arterials = [
    `M -40 ${H * 0.24} C ${W * 0.26} ${H * 0.17}, ${W * 0.6} ${H * 0.3}, ${W + 40} ${H * 0.2}`,
    `M -40 ${H * 0.63} C ${W * 0.3} ${H * 0.55}, ${W * 0.66} ${H * 0.7}, ${W + 40} ${H * 0.6}`,
    `M ${W * 0.17} -40 C ${W * 0.2} ${H * 0.35}, ${W * 0.13} ${H * 0.7}, ${W * 0.19} ${H + 40}`,
    `M ${W * 0.63} -40 C ${W * 0.67} ${H * 0.32}, ${W * 0.6} ${H * 0.68}, ${W * 0.66} ${H + 40}`,
  ];

  // 水系：顶部与底部的河道，以及右侧支流
  const water = [
    `M -40 -40 L ${W + 40} -40 L ${W + 40} ${H * 0.045} C ${W * 0.78} ${H * 0.1}, ${W * 0.6} ${H * 0.02}, ${W * 0.4} ${H * 0.085} C ${W * 0.24} ${H * 0.14}, ${W * 0.1} ${H * 0.07}, -40 ${H * 0.12} Z`,
    `M -40 ${H * 0.9} C ${W * 0.16} ${H * 0.85}, ${W * 0.3} ${H * 0.94}, ${W * 0.5} ${H * 0.9} C ${W * 0.72} ${H * 0.855}, ${W * 0.86} ${H * 0.93}, ${W + 40} ${H * 0.88} L ${W + 40} ${H + 40} L -40 ${H + 40} Z`,
    `M ${W * 0.72} ${H * 0.27} C ${W * 0.8} ${H * 0.31}, ${W * 0.88} ${H * 0.25}, ${W + 40} ${H * 0.3} L ${W + 40} ${H * 0.37} C ${W * 0.88} ${H * 0.32}, ${W * 0.8} ${H * 0.38}, ${W * 0.72} ${H * 0.34} Z`,
  ];

  // 绿地：大量小型树丛，而非几块大色斑
  const greens: Array<[number, number, number]> = [];
  for (let i = 0; i < 210; i++) {
    greens.push([rand() * W, rand() * H, 5 + rand() * 13]);
  }

  // 街区：路网之间的浅色地块，避免出现纯色空白
  const blocks: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 34; i++) {
    const w = 60 + rand() * 170;
    const h = 44 + rand() * 110;
    blocks.push([rand() * (W - w), rand() * (H - h), w, h]);
  }

  return { minorH, minorV, arterials, water, greens, blocks };
}

export function MapBackdrop() {
  const geo = useMemo(buildGeometry, []);

  return (
    <svg
      className="hud-map-backdrop"
      viewBox={`0 0 ${DESIGN_WIDTH} ${DESIGN_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="hud-map-sky" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="var(--hud-map-base)" />
          <stop offset="100%" stopColor="var(--hud-map-base-2)" />
        </linearGradient>
      </defs>

      <rect width={DESIGN_WIDTH} height={DESIGN_HEIGHT} fill="url(#hud-map-sky)" />

      {geo.blocks.map(([x, y, w, h], i) => (
        <rect key={`b${i}`} x={x} y={y} width={w} height={h} rx={12} fill="var(--hud-map-block)" opacity={0.7} />
      ))}

      {geo.water.map((d, i) => (
        <path key={`w${i}`} d={d} fill="var(--hud-map-water)" opacity={0.7} />
      ))}

      {geo.greens.map(([cx, cy, r], i) => (
        <ellipse key={`g${i}`} cx={cx} cy={cy} rx={r} ry={r * 0.82} fill="var(--hud-map-green)" opacity={0.62} />
      ))}

      {/* 细密街道：低对比、细笔画 —— Brief §6 要求底图优先级低于生活环与助手，
          线太粗/太亮会把地图读成主体 */}
      <g stroke="var(--hud-map-road-minor)" strokeWidth={2.4} fill="none" strokeLinecap="round" opacity={0.6}>
        {geo.minorH.map((d, i) => <path key={`mh${i}`} d={d} />)}
        {geo.minorV.map((d, i) => <path key={`mv${i}`} d={d} />)}
      </g>

      {/* 主干道 */}
      <g stroke="var(--hud-map-road)" strokeWidth={6} fill="none" strokeLinecap="round" opacity={0.45}>
        {geo.arterials.map((d, i) => <path key={`a${i}`} d={d} />)}
      </g>
    </svg>
  );
}
