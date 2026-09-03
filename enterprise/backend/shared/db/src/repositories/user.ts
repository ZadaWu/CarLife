/**
 * 账号仓储（施工单 M48-01，FL-07 F-07-13）。
 *
 * # 为什么 id 在这里生成而不是交给 Prisma 的 `@default(cuid())`
 *
 * `users.id` 刻意没有 default：迁移要插入 id 恰好是 `"demo-user"` 的第一行，
 * 让存量数据的裸字符串归属列原地接通。给了 default 之后仍然可以显式传 id，
 * 但"id 由谁生成"就有了两处说法，而两处说法迟早会分叉。
 *
 * # 这里没有口令校验
 *
 * 本仓储只存取 `passwordHash`，**不做 bcrypt 比对**——那是网关鉴权层的事（M48-02）。
 * 把校验放进数据层的代价是：数据层要依赖 bcrypt，而每一个引用 @carlife/db 的包
 * （包括只想读一行车辆档案的 worker）都会跟着装它。
 */

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

/** 账号。`passwordHash` 只在鉴权层被消费，不进任何对外响应。 */
export interface UserAccount {
  id: string;
  username: string;
  passwordHash: string;
  displayName?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 对外可见的账号信息：**不含 hash**。给成员名单、车辆列表这类响应用。 */
export interface PublicUser {
  id: string;
  username: string;
  displayName?: string;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  displayName?: string;
  /** 仅供迁移与测试指定固定 id；正常创建留空由仓储生成。 */
  id?: string;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`用户名已被占用：${username}`);
    this.name = "UsernameTakenError";
  }
}

export interface UserRepository {
  create(input: CreateUserInput): Promise<UserAccount>;
  findById(id: string): Promise<UserAccount | null>;
  /** 登录路径唯一入口。找不到时返回 null——调用方**不得**据此区分错误文案。 */
  findByUsername(username: string): Promise<UserAccount | null>;
  /** 批量取展示信息（成员名单、车辆列表用）。缺失的 id 直接不出现在结果里。 */
  publicByIds(ids: readonly string[]): Promise<Map<string, PublicUser>>;
  setPasswordHash(id: string, passwordHash: string): Promise<void>;
}

type Row = {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDomain(r: Row): UserAccount {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.passwordHash,
    displayName: r.displayName ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function createUserRepository(prisma: PrismaClient): UserRepository {
  return {
    async create(input) {
      const existing = await prisma.user.findUnique({ where: { username: input.username } });
      if (existing) throw new UsernameTakenError(input.username);
      const row = await prisma.user.create({
        data: {
          id: input.id ?? randomUUID(),
          username: input.username,
          passwordHash: input.passwordHash,
          displayName: input.displayName ?? null,
        },
      });
      return toDomain(row as Row);
    },

    async findById(id) {
      const row = await prisma.user.findUnique({ where: { id } });
      return row ? toDomain(row as Row) : null;
    },

    async findByUsername(username) {
      const row = await prisma.user.findUnique({ where: { username } });
      return row ? toDomain(row as Row) : null;
    },

    async publicByIds(ids) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return new Map();
      const rows = await prisma.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, username: true, displayName: true },
      });
      return new Map(
        rows.map((r) => [
          r.id,
          { id: r.id, username: r.username, displayName: r.displayName ?? undefined },
        ]),
      );
    },

    async setPasswordHash(id, passwordHash) {
      await prisma.user.update({ where: { id }, data: { passwordHash } });
    },
  };
}
