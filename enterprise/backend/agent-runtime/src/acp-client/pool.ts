/**
 * 垫片：进程池已搬进 `@carlife/acp`（施工单 M85-09 步 5，变更单 ACR-035）。
 *
 * 留在这里的只有一件事：**把车主面的描述符补上**。
 * 底座那一侧 `app` 是必填的（漏传在 tsc 就红）——默认值只该出现在
 * "确实知道自己是车主面"的这一层。
 *
 * 为什么不改调用点：本单的红线是行为零变化，而"零变化"要能被回归证明，
 * 证明方式就是调用点逐字不动。`new AcpClientPool()` 的写法与从前完全一样。
 */

import { AcpClientPool as AcpClientPoolBase, type AcpClientOptions } from "@carlife/acp";

import { createCockpitApp } from "./cockpit-app";
import type { AgentName } from "./connection";

export class AcpClientPool extends AcpClientPoolBase {
  constructor(opts: Omit<AcpClientOptions, "agent" | "app"> & { app?: AcpClientOptions["app"] } = {}) {
    super({ ...opts, app: opts.app ?? createCockpitApp() });
  }

  /**
   * 把会话反解的结果窄回 `AgentName`。
   *
   * 底座只认 `string`（它不该知道 `hotel` 和 `nav` 是什么），而车主面的
   * `setSessionResolver` 要的是联合类型。窄化放在这一层，**调用点因此一行不用改**。
   *
   * 这里是安全的：池里的 Agent 名全部来自车主面自己传进去的会话名。
   */
  override resolveSession(acpSessionId: string): { carlifeSessionId: string; agent: AgentName } | undefined {
    return super.resolveSession(acpSessionId) as { carlifeSessionId: string; agent: AgentName } | undefined;
  }
}
