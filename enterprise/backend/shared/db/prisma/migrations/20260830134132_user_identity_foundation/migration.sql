-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "device_id" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "vehicle_member_id" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "vehicle_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_type" VARCHAR(20) NOT NULL,
    "model_name" TEXT NOT NULL,
    "vehicle_vin" TEXT,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- 数据迁移：把 "demo-user" 从硬编码字符串升格成第一个真实账号（施工单 M48-01）。
--
-- 必须在下面 AddForeignKey 之前执行：存量的 sessions/trips/vehicles/owner_profiles/
-- vehicle_members 全部指向 "demo-user"（迁移前 check-orphan-users.ts 已核实无第二个取值），
-- users 表里没有这一行的话，每一条 ADD CONSTRAINT 都会 23503 失败。
-- 保留字面 id 而不是换成 cuid，是为了让五处裸字符串列**原地接通**，不必 UPDATE 存量行。
--
-- password_hash 写 '!'：bcrypt 永远不会与它匹配，所以这是一个**锁定**账号。
-- 不在迁移里写死某个口令的 hash——那等于把一个人人可读的凭证提交进仓库，
-- 且它会出现在每一个部署环境里。口令由 M48-02 的账号创建接口 / dev 播种脚本按环境设置。
INSERT INTO "users" ("id", "username", "password_hash", "display_name", "created_at", "updated_at")
VALUES ('demo-user', 'demo', '!', '演示用户', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- CreateIndex
CREATE INDEX "vehicle_grants_vin_revoked_at_idx" ON "vehicle_grants"("vin", "revoked_at");

-- CreateIndex
CREATE INDEX "vehicle_grants_user_id_idx" ON "vehicle_grants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_grants_user_id_vin_key" ON "vehicle_grants"("user_id", "vin");

-- CreateIndex
CREATE INDEX "devices_user_id_revoked_at_idx" ON "devices"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "devices_vehicle_vin_idx" ON "devices"("vehicle_vin");

-- CreateIndex
CREATE INDEX "sessions_device_id_idx" ON "sessions"("device_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_grants" ADD CONSTRAINT "vehicle_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_grants" ADD CONSTRAINT "vehicle_grants_vin_fkey" FOREIGN KEY ("vin") REFERENCES "vehicles"("vin") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_grants" ADD CONSTRAINT "vehicle_grants_vehicle_member_id_fkey" FOREIGN KEY ("vehicle_member_id") REFERENCES "vehicle_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_vehicle_vin_fkey" FOREIGN KEY ("vehicle_vin") REFERENCES "vehicles"("vin") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_members" ADD CONSTRAINT "vehicle_members_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
