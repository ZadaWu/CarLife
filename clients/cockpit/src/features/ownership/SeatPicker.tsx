/**
 * 上车点选（施工单 M24-09，F-50-12，车机横版）。
 *
 * 点选完成即触发"按人调好"（Demo 判定 8 的语义）：**声明经既有对话通道发出**
 * （一句标准的乘坐声明），runtime 的座舱路径接住它——端上不存乘坐状态、
 * 不开新端点（M15-01 的零调用点教训反着用：通道已有真跑，就别再造一条）。
 */

import { useEffect, useState } from "react";

import { loadMembers } from "./api";
import type { MemberView } from "./types";

const ZONES: Array<{ key: string; label: string; word: string }> = [
  { key: "passenger", label: "副驾", word: "副驾" },
  { key: "rearLeft", label: "后排左", word: "后排" },
  { key: "rearRight", label: "后排右", word: "后排右边" },
];

export function SeatPicker({ vin, onDeclare }: { vin: string; onDeclare: (sentence: string) => void }) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [seats, setSeats] = useState<Record<string, string | null>>({});
  const [sent, setSent] = useState(false);

  useEffect(() => {
    void loadMembers(vin).then((s) => setMembers(s.kind === "ready" ? s.members : []));
  }, [vin]);

  if (members.length === 0) return null;

  const declare = () => {
    const parts = ZONES.filter((z) => seats[z.key]).map((z) => {
      const m = members.find((x) => x.id === seats[z.key]);
      return `${z.word}是${m?.displayName ?? ""}`;
    });
    if (parts.length === 0) return;
    // 标准乘坐声明：称呼用车主登记的原词（匹配纪律：不做同义词推断）
    onDeclare(`今天${parts.join("，")}`);
    setSent(true);
    setTimeout(() => setSent(false), 3000);
  };

  return (
    <section className="cown-card" aria-label="上车点选">
      <b>今天谁坐哪</b>
      <p className="cown-dim">点选后座舱按每个人的偏好自动调好；说"这次不用"随时可以改。</p>
      {ZONES.map((z) => (
        <div key={z.key} className="cown-seatrow">
          <span className="cown-dim">{z.label}</span>
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`cown-btn cown-btn--chip${seats[z.key] === m.id ? " is-on" : ""}`}
              onClick={() => setSeats({ ...seats, [z.key]: seats[z.key] === m.id ? null : m.id })}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      ))}
      <button
        type="button"
        className="cown-btn cown-btn--primary"
        disabled={sent || ZONES.every((z) => !seats[z.key])}
        onClick={declare}
      >
        {sent ? "已发出，正在调…" : "就这样，按人调好"}
      </button>
    </section>
  );
}
