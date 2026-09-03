/**
 * 仓库根 `.env` 自动加载（开发便利）。
 *
 * 真实密钥只放 `.env`（gitignore 覆盖），样例见 `.env.example`。
 * 已存在的环境变量优先——CI/容器注入不会被文件覆盖。
 * 生产部署由编排层注入环境，不依赖本文件。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // enterprise/backend/<name>/src → 仓库根（ACR-020 批④后深了一层）
  const rootEnv = resolve(here, "../../../../.env");
  if (!existsSync(rootEnv)) return;

  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    return; // 解析失败不阻塞启动
  }
  // loadEnvFile 会覆盖已有变量，这里恢复"已存在者优先"
  for (const key of before) {
    const original = originalValues.get(key);
    if (original !== undefined) process.env[key] = original;
  }
}

// 在模块加载最早时刻快照，供上面的"已存在者优先"还原
const originalValues = new Map<string, string>(
  Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<[string, string]>,
);
