/**
 * PII 存量数据一次性加密迁移（施工单 M42-01）。
 *
 * 用法：
 *   corepack pnpm --filter @carlife/db db:pii:encrypt -- --dry-run   # 只报数
 *   corepack pnpm --filter @carlife/db db:pii:encrypt                # 真迁
 *
 * 幂等判据是 `pii:v1:` 前缀：已加密的行跳过，中断后重跑安全。
 * 跑前请自行 `pg_dump -t vehicle_members`（脚本只提示不代跑——备份是显式动作）。
 * 日志不打印明文（手机号只出尾号）。
 */

import { PrismaClient } from "@prisma/client";

import { encryptPii, isPiiCiphertext, assertPiiMasterKeyUsable } from "../src/pii/crypto";

const DRY = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  assertPiiMasterKeyUsable(); // 缺钥在这里就炸，不要迁一半

  const prisma = new PrismaClient();
  const rows = await prisma.vehicleMember.findMany({
    select: { id: true, displayName: true, relation: true, note: true, phone: true },
  });

  console.log(`共 ${rows.length} 行；建议先备份：pg_dump "$DATABASE_URL" -t vehicle_members > vehicle_members.backup.sql`);

  let migrated = 0;
  let skipped = 0;
  for (const r of rows) {
    const patch: Record<string, string> = {};
    for (const field of ["displayName", "relation", "note", "phone"] as const) {
      const v = r[field];
      if (v && !isPiiCiphertext(v)) patch[field] = encryptPii(v);
    }
    if (Object.keys(patch).length === 0) {
      skipped += 1;
      continue;
    }
    if (!DRY) await prisma.vehicleMember.update({ where: { id: r.id }, data: patch });
    migrated += 1;
  }

  console.log(`${DRY ? "[dry-run] 将" : "已"}迁移 ${migrated} 行 / 跳过 ${skipped} 行（已是密文或字段为空）`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("迁移失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
