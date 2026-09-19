/**
 * [F-02-12] 手机端不出声（2026-09-17 定调，2026-09-18 用户复述「手机端的语音播报直接移除」）。
 *
 * # 这条守的是"回不来"，不是"改掉"
 *
 * 播报本身在 M65-04 接过、38bf469d 整条撤掉了。但它被撤过一次就说明有人会再接一次
 * ——车机那边一直有一份完整的播报链路（`carlife-tts`、音量、垫场话、播报中打断），
 * 而"让手机端像车机一样 X"是个很自然的需求。接回来的表现是：车主在会议室里打字问一句，
 * 手机开始朗读。
 *
 * 所以这里把**四个入口一起钉住**：Rust 侧的共享核依赖、iOS 系统合成、WebView 的
 * Web Speech、以及对话层那枚播报开关。读源码，不渲染。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // `gen/` 是 Tauri 生成的 Xcode 工程与编译产物，不是我们写的代码。
      if (name === "gen" || name === "target" || name === "node_modules" || name === "dist") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|rs)$/.test(name)) out.push(p);
  }
  return out;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const SOURCES = [...walk(join(here, "../src")), ...walk(join(here, "../src-tauri/src"))];
const CARGO = readFileSync(join(here, "../src-tauri/Cargo.toml"), "utf8");
const APP = readFileSync(join(here, "../src/app/index.tsx"), "utf8");

describe("[F-02-12] 手机端没有任何出声的路", () => {
  it("Cargo 里没有 carlife-tts：共享核留着是给车机回接的，不是手机端待接的半成品", () => {
    assert.equal(/carlife-tts/.test(CARGO), false);
  });

  it("端上代码里没有系统语音合成（iOS AVSpeech / Web Speech）", () => {
    const hits: string[] = [];
    for (const f of SOURCES) {
      const src = readFileSync(f, "utf8");
      if (/AVSpeechSynthesizer|speechSynthesis|SpeechSynthesisUtterance/.test(src)) hits.push(f.slice(f.indexOf("clients/")));
    }
    assert.deepEqual(hits, [], `这几个 API 一出现就是「手机会出声」：${hits.join("、")}`);
  });

  /**
   * `DialogScreen` 有一枚播报开关（`broadcast` 属性，车机在用）。手机端**不传它**，
   * 于是那枚喇叭不渲染。传了的话界面上会多一枚点了没用的开关——手机端没有播报可开。
   */
  it("对话页不传 broadcast：那枚喇叭是车机的", () => {
    assert.equal(/broadcast=\{/.test(APP), false);
  });
});
