/**
 * 音景的三个闸与开关持久化（施工单 M64-03，验收 §1 判定 2~8）。
 *
 * 判定 1（`music::set_ducked` 的调用方计数）在这里也守一遍：它是本单的核心红线，
 * 而"多了一个调用方"是一次很自然的重构就能造成的，靠人记不住。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { CueName } from "@carlife/ui";

import {
  MINIMAL_CUES,
  cuesForPolicy,
  decidePolicy,
} from "../src/features/cabin/soundscape-policy";
import {
  SOUNDSCAPE_DEFAULT,
  SOUNDSCAPE_PREF_KEY,
  readSoundscapePref,
  writeSoundscapePref,
} from "../src/features/cabin/soundscape-prefs";

const ALL: CueName[] = ["bedIn", "chime", "arpeggio", "thud", "resolve", "bedOut"];

describe("decidePolicy：三个闸的优先级", () => {
  test("开关关着 ⇒ silent，压过一切", () => {
    assert.equal(decidePolicy({ enabled: false, assistantState: "idle", musicAudible: false }), "silent");
    assert.equal(decidePolicy({ enabled: false, assistantState: "speaking", musicAudible: true }), "silent");
  });

  test("暖暖在说话 ⇒ silent，且**优先于**音乐那一条", () => {
    assert.equal(
      decidePolicy({ enabled: true, assistantState: "speaking", musicAudible: true }),
      "silent",
      "正在播报时不该因为「音乐也在放」就退成两个 earcon——那两个音照样盖在她说的话上",
    );
    assert.equal(decidePolicy({ enabled: true, assistantState: "speaking", musicAudible: false }), "silent");
  });

  test("音乐在放且她没说话 ⇒ minimal", () => {
    assert.equal(decidePolicy({ enabled: true, assistantState: "idle", musicAudible: true }), "minimal");
  });

  test("都不成立 ⇒ full", () => {
    assert.equal(decidePolicy({ enabled: true, assistantState: "idle", musicAudible: false }), "full");
  });

  test("助手状态未知（null / 缺省）按「没在说话」算", () => {
    assert.equal(decidePolicy({ enabled: true, assistantState: null, musicAudible: false }), "full");
    assert.equal(decidePolicy({ enabled: true, musicAudible: false }), "full");
  });

  test("listening / thinking / alert 都不静音——只有 speaking 才占着声道", () => {
    for (const s of ["idle", "listening", "thinking", "alert"] as const) {
      assert.equal(decidePolicy({ enabled: true, assistantState: s, musicAudible: false }), "full", s);
    }
  });

  test("双向跟随：speaking 结束后回到 full", () => {
    const on = decidePolicy({ enabled: true, assistantState: "speaking", musicAudible: false });
    const off = decidePolicy({ enabled: true, assistantState: "idle", musicAudible: false });
    assert.equal(on, "silent");
    assert.equal(off, "full", "说完要能回来，否则一次播报之后整段动画都哑了");
  });
});

describe("cuesForPolicy：过闸不改顺序", () => {
  test("silent ⇒ 空", () => {
    assert.deepEqual(cuesForPolicy("silent", ALL), []);
    assert.deepEqual(cuesForPolicy("silent", ["jingle"]), []);
  });

  test("minimal ⇒ 只剩 jingle 与 resolve", () => {
    assert.deepEqual(cuesForPolicy("minimal", ["jingle", ...ALL]), ["jingle", "resolve"]);
    assert.deepEqual(MINIMAL_CUES, ["jingle", "resolve"]);
  });

  test("minimal 把持续出声的铺底也挡掉——氛围位已经被歌占了", () => {
    const out = cuesForPolicy("minimal", ALL);
    assert.ok(!out.includes("bedIn"), "铺底是唯一持续出声的一路，降级时必须挡掉");
    assert.ok(!out.includes("chime") && !out.includes("arpeggio") && !out.includes("thud"));
  });

  test("full ⇒ 原数组逐项相等且保序", () => {
    assert.deepEqual(cuesForPolicy("full", ALL), ALL);
  });

  test("过闸不改动入参", () => {
    const input = [...ALL];
    cuesForPolicy("minimal", input);
    assert.deepEqual(input, ALL, "返回的是新数组，不能就地改调用方的");
  });
});

describe("开关持久化", () => {
  const original = (globalThis as { window?: unknown }).window;
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      },
    };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  test("没存过 ⇒ 默认开", () => {
    assert.equal(readSoundscapePref(), SOUNDSCAPE_DEFAULT);
    assert.equal(SOUNDSCAPE_DEFAULT, true, "出发动画本来就该有声音，不是要用户主动发现的增强");
  });

  test("写了能读回来", () => {
    writeSoundscapePref(false);
    assert.equal(store[SOUNDSCAPE_PREF_KEY], "off");
    assert.equal(readSoundscapePref(), false);
    writeSoundscapePref(true);
    assert.equal(readSoundscapePref(), true);
  });

  test("值不认识 ⇒ 回默认，不当成关", () => {
    store[SOUNDSCAPE_PREF_KEY] = "yes";
    assert.equal(readSoundscapePref(), SOUNDSCAPE_DEFAULT);
  });

  test("读抛错（隐私模式）⇒ 回默认且不抛", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {},
      },
    };
    assert.doesNotThrow(() => readSoundscapePref());
    assert.equal(readSoundscapePref(), SOUNDSCAPE_DEFAULT);
  });

  test("写抛错 ⇒ 不抛出去；当次生效由调用方的 state 承担", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    };
    assert.doesNotThrow(() => writeSoundscapePref(false));
  });
});

// ── 红线：让路出口只能有一个 ────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const tauriSrc = path.join(here, "..", "src-tauri", "src");

function rsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rsFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** 剥掉 `#[cfg(test)] mod tests { … }`：用例里当然会调它。 */
function stripTestMod(src: string): string {
  const i = src.indexOf("#[cfg(test)]");
  return i < 0 ? src : src.slice(0, i);
}

describe("红线：music::set_ducked 的调用方仍然只有一个", () => {
  test("生产代码里 crate::music::set_ducked 只被 tts/ducking.rs 调用", () => {
    const callers: string[] = [];
    for (const f of rsFiles(tauriSrc)) {
      const body = stripTestMod(readFileSync(f, "utf8"));
      const n = (body.match(/crate::music::set_ducked\(/g) ?? []).length;
      if (n > 0) callers.push(`${path.relative(tauriSrc, f)}×${n}`);
    }
    assert.deepEqual(
      callers,
      ["tts/ducking.rs×1"],
      "端上只能有一个让路出口。两处各写一遍的下场写在 tts/ducking.rs 文件头：" +
        "它们迟早对不齐，而对不齐的表现是**音乐一直压着没恢复**，不报错。" +
        `实际调用方：${callers.join(", ") || "（一个都没有？set_tts_playing 里那一行是不是被删了）"}`,
    );
  });

  test("音景这一侧没有任何压低音乐的出口", () => {
    const cabin = path.join(here, "..", "src", "features", "cabin");
    for (const name of readdirSync(cabin)) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const body = readFileSync(path.join(cabin, name), "utf8");
      assert.ok(
        !/invoke\((["'])(?:set_music_enabled|cabin_media_duck|music_set_ducked)\1/.test(body),
        `${name} 里出现了压低/关停音乐的调用——音景只降低自己`,
      );
    }
  });

  test("只读命令是只读的：不带参数、且已在 lib.rs 注册", () => {
    const modRs = readFileSync(path.join(tauriSrc, "music", "mod.rs"), "utf8");
    assert.ok(
      /pub fn music_is_audible\(\) -> bool \{/.test(modRs),
      "签名必须是无参返回 bool——带上参数就有了改状态的口子",
    );
    const libRs = readFileSync(path.join(tauriSrc, "lib.rs"), "utf8");
    assert.ok(libRs.includes("music::music_is_audible,"), "没注册的话前端 invoke 会 reject，然后静默按 false 走");
  });
});
