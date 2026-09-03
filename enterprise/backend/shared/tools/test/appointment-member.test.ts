/**
 * appointment 的档案联系人路（施工单 M44-01，平移自 test_drive_book 的 M19-06 形态）。
 *
 * 三条纪律逐一断言：真号由工具层自取不经模型入参、disclosed 只留字段名不留值、
 * memberId 与 contact 同给时 memberId 优先（与 test_drive_book 同语义）。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { VehicleMember } from "@carlife/memory";

import { createAppointmentTool, type AppointmentBackend, type AppointmentSubmission } from "../src/appointment";
import { setMemberStores } from "../src/vehicle-member";
import { ToolError } from "../src/external";

const CTX = { sessionId: "sess-m44", mode: "real" as const };

function member(over: Partial<VehicleMember>): VehicleMember {
  return {
    id: "mem-1",
    vin: "DEM00SEED0M0DELY1",
    ownerId: "u1",
    displayName: "张先生",
    roles: ["driver"],
    needs: [],
    phone: "13912345613",
    updatedAt: Date.now(),
    ...over,
  };
}

function installStore(rows: VehicleMember[]): void {
  setMemberStores(
    {
      async listByVehicle() {
        return rows;
      },
      async listByOwner() {
        return rows;
      },
      async get(_o, id) {
        return rows.find((r) => r.id === id) ?? null;
      },
      async upsert(m) {
        return m as VehicleMember;
      },
      async remove() {
        return null;
      },
    },
    undefined as never,
  );
}

afterEach(() => setMemberStores(undefined, undefined as never));

function captureBackend(): { backend: AppointmentBackend; last: () => AppointmentSubmission | undefined } {
  let seen: AppointmentSubmission | undefined;
  return {
    backend: {
      async submit(args) {
        seen = args;
        return { orderId: "SV-000001", status: "pending_store" };
      },
    },
    last: () => seen,
  };
}

const BASE = {
  kind: "service" as const,
  storeId: "RS-SH-01",
  storeName: "上海浦东前滩服务中心",
  at: "2026-09-01T09:00:00+08:00",
  subject: "VIN:DEM00SEED0M0DELY1 机油保养",
};

describe("appointment 档案联系人路（M44-01）", () => {
  it("memberId 路：真号由工具层自取交给后端；disclosed 只留字段名", async () => {
    installStore([member({})]);
    const { backend, last } = captureBackend();
    const tool = createAppointmentTool(backend);
    const r = await tool.call({ ...BASE, memberId: "mem-1", userId: "u1" }, CTX);
    assert.equal(last()?.contact.phone, "13912345613", "后端收到真号");
    assert.equal(last()?.contact.name, "张先生");
    assert.deepEqual(r.data.disclosed, ["称呼", "手机号"], "留档只有字段名，没有值");
    assert.ok(!JSON.stringify(r.data).includes("13912345613"), "返回值不含真号");
  });

  it("档案无号：明确报错并引导，不静默退回", async () => {
    installStore([member({ phone: undefined })]);
    const tool = createAppointmentTool(captureBackend().backend);
    await assert.rejects(
      () => tool.call({ ...BASE, memberId: "mem-1", userId: "u1" }, CTX),
      (err: unknown) => err instanceof ToolError && /档案里没有|口述联系方式/.test(err.message),
    );
  });

  it("memberId 与 contact 同给：memberId 优先（与 test_drive_book 同语义）", async () => {
    installStore([member({})]);
    const { backend, last } = captureBackend();
    const tool = createAppointmentTool(backend);
    await tool.call(
      { ...BASE, memberId: "mem-1", userId: "u1", contact: { name: "李女士", phone: "13900000000" } },
      CTX,
    );
    assert.equal(last()?.contact.phone, "13912345613", "档案号压过口述号");
  });

  it("口述 contact 路回归：行为与改造前一致", async () => {
    const { backend, last } = captureBackend();
    const tool = createAppointmentTool(backend);
    const r = await tool.call({ ...BASE, contact: { name: "李女士", phone: "13900000000" } }, CTX);
    assert.equal(last()?.contact.phone, "13900000000");
    assert.deepEqual(r.data.disclosed, ["称呼", "手机号"]);
  });

  it("两路都缺：invalid 报缺称呼", async () => {
    const tool = createAppointmentTool(captureBackend().backend);
    await assert.rejects(
      () => tool.call({ ...BASE }, CTX),
      (err: unknown) => err instanceof ToolError && err.category === "invalid",
    );
  });
});
