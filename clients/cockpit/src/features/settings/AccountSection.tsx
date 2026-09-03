/**
 * 设置页的「账号」区（施工单 M54-06，缺口 G2/G3）。
 *
 * 走查原话是"用户没办法在屏幕上看到自己的登录状态/身份"。两种身份两种答案：
 *
 *  - **私人终端**：显示登录的账号名 + 退出登录（对齐手机端设置页的账号组）。
 *  - **车机**：显示本次上车声明的「谁在用车」——它比账号更贴近"现在的身份"，
 *    车机本来就不代表任何人（R4），账号栏在车机模式下没有意义。
 *
 * 声明的是 userId，名字经成员名单映射；映射不到（网络断）就如实显示 id 前 8 位，
 * 不编名字。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { AUTO_DECLARE_OWNER } from "../auth/boardingPolicy";

interface AuthStatus {
  authenticated: boolean;
  userId: string | null;
  displayName: string | null;
}

interface Boarding {
  declared: boolean;
  activeUserId?: string | null;
}

export function AccountSection() {
  const [role, setRole] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [who, setWho] = useState<string | null>(null); // 车机模式：当前使用人的显示文案

  useEffect(() => {
    void (async () => {
      try {
        const r = await invoke<string>("device_role");
        setRole(r);
        if (r !== "cockpit") {
          setAuth(await invoke<AuthStatus>("auth_status"));
          return;
        }
        const b = JSON.parse(await invoke<string>("boarding_declared")) as Boarding;
        if (!b.declared) {
          setWho("尚未声明（回到上车界面选择）");
          return;
        }
        if (b.activeUserId === null) {
          setWho("访客模式");
          return;
        }
        const uid = b.activeUserId!;
        // 名字映射尽力而为：映射不到就显示 id 片段，不编。
        try {
          const vin = await invoke<string>("bound_vin");
          const raw = await invoke<string>("vehicle_members", { vin });
          const members = (JSON.parse(raw) as { members?: { userId: string; displayName?: string }[] }).members ?? [];
          const hit = members.find((m) => m.userId === uid);
          setWho(hit?.displayName ?? uid.slice(0, 8));
        } catch {
          setWho(uid.slice(0, 8));
        }
      } catch {
        // 浏览器走查：整区不渲染，不显示一个恒为空的账号组。
        setRole(null);
      }
    })();
  }, []);

  const logout = useCallback(() => {
    // 退出后整页重载：登录门在 main.tsx 最外层，局部改状态到不了它。
    void invoke("auth_logout")
      .catch(() => undefined)
      .finally(() => window.location.reload());
  }, []);

  if (role === null) return null;

  if (role === "cockpit") {
    return (
      <section className="cset-group">
        <h2>当前使用人</h2>
        <p className="cset-identity">{who ?? "…"}</p>
        <p className="cset-note">
          {AUTO_DECLARE_OWNER
            ? "车机不登录账号；当前版本默认由车主使用（临时策略，见 boardingPolicy.ts）。"
            : "车机不登录账号；这里的使用人决定会话记在谁名下，重启后保持（M54-10）。"}
        </p>
        {/* 自动以车主进入时没有"换人"这回事：清了声明也只会再自动选回车主，按钮只会让人困惑 */}
        {AUTO_DECLARE_OWNER ? null : (
          <button
            type="button"
            className="cset-identity-switch"
            onClick={() => {
              // 清声明 → 重载 → BoardingGate 回到选择屏。换人是显式动作，
              // 不靠重启擦除（重启恰恰不再擦除了）。
              void invoke("boarding_reset")
                .catch(() => undefined)
                .finally(() => window.location.reload());
            }}
          >
            更换使用人
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="cset-group">
      <h2>账号</h2>
      {auth?.authenticated ? (
        <>
          <p className="cset-identity">{auth.displayName ?? auth.userId}</p>
          <button type="button" className="cset-identity-switch" onClick={logout}>
            退出登录
          </button>
        </>
      ) : (
        <>
          <p className="cset-identity">未登录</p>
          {/* 登录门在最外层，重载就会被它接住——这里不重写一份登录表单。 */}
          <button
            type="button"
            className="cset-identity-switch"
            onClick={() => window.location.reload()}
          >
            去登录
          </button>
        </>
      )}
    </section>
  );
}
