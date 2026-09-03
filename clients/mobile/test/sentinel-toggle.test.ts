/**
 * [F-52-01][F-02-08] 手机端的哨兵监听（语音唤醒）。
 *
 * FL-52 原本写着"只做车机端"，于是手机上喊「暖暖你好」永远没反应。
 * 本单把整条链路补到手机端：常驻采集 → VAD 分段 → 转写 → 唤醒词判定，
 * 默认关，开关在设置页。
 *
 * **共用判据这条是重点**：唤醒词表、对话窗口、降级闸都来自
 * `clients/shared/rust/carlife-voice`。复制一份的结局是"同一句话在车上有用、
 * 在手机上没反应"，而这种差异不会有任何报错。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const SETTINGS = read("../src/features/settings/index.tsx");
const APP = read("../src/app/index.tsx");
const SENTINEL_RS = read("../src-tauri/src/voice/sentinel.rs");
const VOICE_MOD_RS = read("../src-tauri/src/voice/mod.rs");
const PROFILE_RS = read("../src-tauri/src/commands/profile.rs");
const VOICE_RS = read("../src-tauri/src/commands/voice.rs");
const MEDIA_RS = read("../src-tauri/src/commands/media.rs");

describe("[F-52-01] 手机端默认关", () => {
  it("静态量初值是 false", () => {
    assert.match(SENTINEL_RS, /pub static SENTINEL_ENABLED: AtomicBool = AtomicBool::new\(false\)/);
  });

  it("循环的 switch_on 读静态量，不是写死的 true", () => {
    assert.match(SENTINEL_RS, /let mut switch_on = SENTINEL_ENABLED\.load\(Ordering::Relaxed\)/);
  });

  it("偏好缺省按关处理", () => {
    assert.match(PROFILE_RS, /read_bool\(app, "sentinelEnabled", false\)/);
  });
});

describe("[F-52-01] 判据与车机端共用，不抄第二份", () => {
  it("唤醒词与对话窗口来自 carlife-voice", () => {
    assert.match(VOICE_MOD_RS, /pub use carlife_voice::\{wake, windows\}/);
    assert.ok(
      !/const DISMISS_PHRASES|fn classify\(/.test(VOICE_MOD_RS),
      "口令表不许在手机端另写一份——两端听得懂的话必须一样",
    );
  });
});

describe("[F-02-08] 开关与互斥", () => {
  it("设置页有「语音唤醒」组，读写走 get/set_sentinel_enabled", () => {
    assert.match(SETTINGS, /语音唤醒/);
    assert.match(SETTINGS, /invoke<boolean>\("get_sentinel_enabled"\)/);
    assert.match(SETTINGS, /invoke<boolean>\("set_sentinel_enabled", \{ enabled: next \}\)/);
  });

  it("打开时先要麦克风授权，要不到就回滚并说清原因", () => {
    assert.match(PROFILE_RS, /if enabled && !crate::commands::media::acquire_mic_permission\(\)\.await/);
    assert.match(SETTINGS, /setSentinel\(!next\)/);
    assert.match(SETTINGS, /permission_denied/);
  });

  it("长按说话与哨兵互斥：按下等它真的放开麦克风，松手恢复", () => {
    assert.match(MEDIA_RS, /sentinel\.pause\(\)/);
    assert.match(MEDIA_RS, /crate::voice::wait_mic_released/);
    assert.equal(
      MEDIA_RS.split("sentinel.resume()").length - 1,
      2,
      "起流失败与松手两条路都要放回哨兵——少一条就是一次 PTT 失败后哨兵永久哑掉",
    );
  });

  it("麦克风指示常驻 HUD，不藏进设置页二级菜单（F-02-08 的原话）", () => {
    assert.match(APP, /invoke\("sentinel_set_switch", \{ on: next \}\)/);
    assert.match(APP, /micEnabled: sentinelInd\.switchOn/);
  });
});

describe("[F-52-01] 真机抓出的两处（M60-02，车机端同形）", () => {
  it("转写客户端每次现构造，不缓在消费者线程外", () => {
    assert.ok(
      !/let gateway = carlife_net::GatewayClient::new/.test(VOICE_RS),
      "缓一个的后果是一辈子拿着线程启动那刻的 token（往往是空的）",
    );
    assert.equal(VOICE_RS.split("asr_client().transcribe_audio").length - 1, 2);
  });

  it("打开开关时清掉降级锁", () => {
    const body = PROFILE_RS.slice(PROFILE_RS.indexOf("pub fn apply_sentinel_enabled"));
    assert.match(body, /if enabled \{[\s\S]*?SENTINEL_DEGRADED\s*\n?\s*\.store\(false/);
  });

  it("关掉开关时归还录音档位", () => {
    assert.match(SENTINEL_RS, /carlife_media::release_recording_session\(\)/);
    assert.match(SENTINEL_RS, /if !switch_on \{\s*\n\s*want_release = true;/);
  });
});

describe("[F-52-01] 会话接线", () => {
  it("引导时启动哨兵，并把当前会话绑给它", () => {
    assert.match(APP, /invoke<boolean>\("sentinel_start"\)/);
    assert.match(APP, /invoke\("sentinel_bind_session", \{ sessionId: sid \}\)/);
  });

  it("Rust 现建会话后前端要收编——不收编就是指令送出去了、回复走另一路流", () => {
    assert.match(APP, /case "session_adopted":/);
    assert.match(APP, /adoptSession\(w\.session_id\)/);
  });
});
