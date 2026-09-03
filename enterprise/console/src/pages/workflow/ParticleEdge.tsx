/**
 * 带流动光点的边：smoothstep 的画法一个不改，只多一颗沿路径循环的光点。
 *
 * # 为什么是 SMIL（`<animateMotion>`）而不是动画库
 *
 * 光点要沿着 reactflow 算出来的正交折线跑，SMIL 直接吃 path 字符串，
 * 浏览器合成器自己驱动，零依赖零重渲染——这正是 ACR-001/002 之外
 * 「链路动效零依赖可达」的那一半。动效参数的真相源在 ../demo/design-spec.md。
 *
 * # 光点颜色跟边色走
 *
 * 边被投影层染成什么色（走完绿 / 失败红），光点就是什么色——
 * 它不是独立的装饰，是"这条边正在被走"的同一个事实的另一种画法。
 */

import type { ReactNode } from "react";
import { BaseEdge, getSmoothStepPath, type EdgeProps } from "reactflow";

import type { FlowEdgeData } from "./layout";

function renderLabel(label: ReactNode, lines: readonly string[] | undefined): ReactNode {
  if (!lines || lines.length <= 1) return label;
  return lines.map((line, index) => (
    <tspan key={`${line}-${index}`} x={0} dy={index === 0 ? "0" : "1.15em"}>
      {line}
    </tspan>
  ));
}

function edgePath(props: EdgeProps<FlowEdgeData>): [string, number, number] {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: props.pathOptions?.borderRadius,
    offset: props.pathOptions?.offset,
  });
  return [path, labelX, labelY];
}

function FlowEdgeBase({
  props,
  path,
  labelX,
  labelY,
  children,
}: {
  props: EdgeProps<FlowEdgeData>;
  path: string;
  labelX: number;
  labelY: number;
  children?: ReactNode;
}): JSX.Element {
  const layout = props.data?.labelLayout;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        labelX={labelX + (layout?.offsetX ?? 0)}
        labelY={labelY + (layout?.offsetY ?? 0)}
        label={renderLabel(props.label, layout?.lines)}
        labelStyle={props.labelStyle}
        labelShowBg={props.labelShowBg}
        labelBgStyle={props.labelBgStyle}
        labelBgPadding={props.labelBgPadding}
        labelBgBorderRadius={props.labelBgBorderRadius}
        style={props.style}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
        interactionWidth={props.interactionWidth}
      />
      {children}
    </>
  );
}

/** 默认 smoothstep 边的可读标签版本：只挪标签，不改变边的路径语义。 */
export function ReadableSmoothStepEdge(props: EdgeProps<FlowEdgeData>): JSX.Element {
  const [path, labelX, labelY] = edgePath(props);
  return <FlowEdgeBase props={props} path={path} labelX={labelX} labelY={labelY} />;
}

export function ParticleEdge(props: EdgeProps<FlowEdgeData>): JSX.Element {
  const [path, labelX, labelY] = edgePath(props);
  const color = (props.style?.stroke as string | undefined) ?? "#3fb950";
  return (
    <FlowEdgeBase props={props} path={path} labelX={labelX} labelY={labelY}>
      {/* CSS 侧的 .flow-particle 在 prefers-reduced-motion 下整个隐藏 */}
      <circle r={4} fill={color} style={{ color }} className="flow-particle">
        <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
      </circle>
    </FlowEdgeBase>
  );
}
