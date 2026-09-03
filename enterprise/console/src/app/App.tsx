/**
 * 后台应用外壳（施工单 M3-01）。
 *
 * 路由 + 身份上下文 + 布局。菜单按角色裁剪，但**权限判定在服务端**——
 * 隐藏菜单只是体验，直接敲 URL 一样会被接口 403 挡住（M3-01 约束 3）。
 */

import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { api, clearToken, getToken, onUnauthorized, type ConsoleIdentity } from "../api";
import { IdentityContext } from "./identity";
import { Layout } from "./Layout";
import { LoginPage } from "../pages/login";
import { ConfigPage } from "../pages/config";
import { SystemPage } from "../pages/system";
import { GuardPage } from "../pages/guard";
import { SessionsPage } from "../pages/sessions";
import { MemoryPage } from "../pages/memory";
import { CabinViewPage } from "../pages/cabin";
import { AuditPage } from "../pages/audit";
import { UsagePage } from "../pages/usage";
import { FinancePage } from "../pages/finance";
import { TracePage } from "../pages/trace";
import { WorkflowPage } from "../pages/workflow";
import { KnowledgePage } from "../pages/knowledge";
import { DemoPage } from "../pages/demo";
import { EvalsPage } from "../pages/evals";
import { EvalJobPage } from "../pages/evals/JobPage";
import { IdentityUsersPage } from "../pages/identity/users";
import { IdentityUserDetailPage } from "../pages/identity/user-detail";
import { IdentityVehiclesPage } from "../pages/identity/vehicles";
import { IdentityVehicleDetailPage } from "../pages/identity/vehicle-detail";
import { IdentityDevicesPage } from "../pages/identity/devices";
import { Forbidden } from "./Forbidden";

type BootState = "loading" | "anonymous" | "ready";

export function App(): JSX.Element {
  const [state, setState] = useState<BootState>("loading");
  const [identity, setIdentity] = useState<ConsoleIdentity | null>(null);

  const signOut = useCallback(() => {
    clearToken();
    setIdentity(null);
    setState("anonymous");
  }, []);

  // 启动恢复：localStorage 里有 token 就换一次身份，失败即回登录。
  useEffect(() => {
    if (!getToken()) {
      setState("anonymous");
      return;
    }
    api
      .whoami()
      .then((who) => {
        setIdentity(who);
        setState("ready");
      })
      .catch(() => {
        clearToken();
        setState("anonymous");
      });
  }, []);

  useEffect(() => onUnauthorized(signOut), [signOut]);

  if (state === "loading") return <div className="boot">载入中…</div>;

  if (state === "anonymous" || !identity) {
    return (
      <LoginPage
        onSignedIn={(who) => {
          setIdentity(who);
          setState("ready");
        }}
      />
    );
  }

  const isAdmin = identity.role === "admin";

  return (
    <IdentityContext.Provider value={identity}>
      <BrowserRouter>
        <Layout identity={identity} onSignOut={signOut}>
          <Routes>
            <Route path="/" element={<Navigate to={isAdmin ? "/config" : "/sessions"} replace />} />
            {/* 配置面是 admin 独有：ops 走到这里显示 403 页，而不是空白 */}
            <Route path="/config" element={isAdmin ? <ConfigPage /> : <Forbidden need="admin" />} />
            {/* 运维大屏：运营与管理员都可看（出事时"找不到管理员"比越权更现实） */}
            <Route path="/system" element={<SystemPage />} />
            {/* 运营与管理员都可进：页内的红线区块自己按角色裁剪（服务端另有 403） */}
            <Route path="/guard" element={<GuardPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:sessionId" element={<SessionsPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/cabin" element={<CabinViewPage />} />
            <Route path="/memory/:sessionId" element={<MemoryPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/usage" element={<UsagePage />} />
            {/* 财务是账户金额，与配置面同级敏感：ops 走到这里显示 403，服务端另有 requireRole */}
            <Route path="/finance" element={isAdmin ? <FinancePage /> : <Forbidden need="admin" />} />
            <Route path="/trace" element={<TracePage />} />
            <Route path="/workflow" element={<WorkflowPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/demo" element={<DemoPage />} />
            {/* 评测台（M67）：运营可看；起跑与取消由服务端按 admin 判 */}
            <Route path="/evals" element={<EvalsPage />} />
            <Route path="/evals/:jobId" element={<EvalJobPage />} />
            {/* 用户体系（M68）：ops 可看列表与详情；建号 / 重置口令 / 撤销由服务端按 admin 判，页面只按角色隐藏入口 */}
            <Route path="/identity" element={<Navigate to="/identity/users" replace />} />
            <Route path="/identity/users" element={<IdentityUsersPage />} />
            <Route path="/identity/users/:id" element={<IdentityUserDetailPage />} />
            <Route path="/identity/vehicles" element={<IdentityVehiclesPage />} />
            <Route path="/identity/vehicles/:vin" element={<IdentityVehicleDetailPage />} />
            <Route path="/identity/devices" element={<IdentityDevicesPage />} />
            <Route path="/evals/:jobId/:tier" element={<EvalJobPage />} />
            <Route path="*" element={<div className="page"><h1>页面不存在</h1></div>} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </IdentityContext.Provider>
  );
}
