-- 默认车的数据库级唯一约束（F-23-09）
--
-- 为什么不是 partial unique index：真正需要的是 `UNIQUE (owner_id) WHERE is_default`，
-- 但 Prisma 6 的 schema 表达不了它；手写进迁移又会被
-- `migrate diff --from-migrations --to-schema-datamodel` 判成漂移，
-- 在下一次 db:migrate:safe 时生成 DROP INDEX 把它删掉。
--
-- 改用「值为 owner_id 或 NULL」的一列：Postgres 的唯一索引忽略 NULL，
-- 于是"同一车主至多一辆默认车"既是真约束，又能在 schema 里表达、不被判漂移。

ALTER TABLE "vehicles" ADD COLUMN     "default_for_owner" TEXT;

-- 回填。**必须在建索引之前**：若某个 owner 此前存在多辆 is_default = true
-- （实测发生过：demo-seed 写 true 不清旧的，my-car.ts 会清，两个脚本先后跑就并列了），
-- 下面的唯一索引会直接建失败——这正是要的：脏数据在这里被拦住，
-- 而不是留到运行期让 listByOwner 按购入日期悄悄挑一辆。
UPDATE "vehicles" SET "default_for_owner" = "owner_id" WHERE "is_default" = true;

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_default_for_owner_key" ON "vehicles"("default_for_owner");
