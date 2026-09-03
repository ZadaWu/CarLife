// web — 后台 / Demo 入口（施工单 M3-01）
//
// §2.3：Web 端**不使用 HUD**，直接是功能页面——管理后台不需要"车内伙伴"人设。
// 这里不引入 assistant-avatar，也不引入任何语音能力（M3-00 红线）。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
