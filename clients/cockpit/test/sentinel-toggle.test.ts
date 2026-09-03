/**
 * [F-52-01][F-02-08] 哨兵监听（语音唤醒）的设置页开关与「默认关」。
 *
 * M25-01～M33 期间哨兵总开关恒为开（循环里写死 `switch_on = true`），
 * 而它没有任何设置页入口——车主想关只能点 HUD 上那枚麦克风图标，
 * 且关了重启又自己开。本单补上入口、补上持久化，并把默认值翻成关：
 * 常驻麦克风是隐私上最重的一个默认值，不该是开箱状态。
 *
 * 这几条断言守的都是"改回去不会有任何报错"的地方：默认值翻回 true、
 * 开关不落盘、两个入口各走一条路——三者都能编过、能跑，只是功能不对。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const SETTINGS = read("../src/features/settings/SettingsScreen.tsx");
const SENTINEL_RS = read("../src-tauri/src/voice/sentinel.rs");
const PREFS_RS = read("../src-tauri/src/commands/prefs.rs");
const VOICE_RS = read("../src-tauri/src/commands/voice.rs");
const LIB_RS = read("../src-tauri/src/lib.rs");

describe("[F-52-01] 语音唤醒默认关", () => {
  it("静态量初值是 false——进程刚起、前端还没说话时麦克风就不该开", () => {
    assert.match(SENTINEL_RS, /pub static SENTINEL_ENABLED: AtomicBool = AtomicBool::new\(false\)/);
  });

  it("循环的 switch_on 读静态量，不是写死的 true", () => {
    assert.match(SENTINEL_RS, /let mut switch_on = SENTINEL_ENABLED\.load\(Ordering::Relaxed\)/);
    assert.ok(
      !/let mut switch_on = true/.test(SENTINEL_RS),
      "写死 true 的话，启动到前端拨开关之间那几百毫秒是真的在录音",
    );
  });

  it("偏好文件缺省按关处理（不是按开）", () => {
    assert.match(PREFS_RS, /fn load_sentinel_pref[\s\S]*?\.map\(\|c\| c\.trim\(\) == "on"\)\.unwrap_or\(false\)/);
  });

  it("启动时载入偏好，且排在哨兵启动之前", () => {
    assert.match(LIB_RS, /commands::prefs::load_sentinel_pref\(app\.handle\(\)\)/);
  });
});

describe("[F-02-08] 一个开关，两个入口，同一条落点", () => {
  it("设置页与 HUD 麦克风图标都落到 apply_sentinel_enabled", () => {
    assert.match(PREFS_RS, /pub fn apply_sentinel_enabled/);
    assert.match(PREFS_RS, /pub async fn set_sentinel_enabled[\s\S]*?apply_sentinel_enabled\(&app, enabled\)/);
    assert.match(VOICE_RS, /pub async fn sentinel_set_switch[\s\S]*?apply_sentinel_enabled\(&app, on\)/);
  });

  it("落点做齐三件事：置静态量、拨正在跑的哨兵、落盘", () => {
    const body = PREFS_RS.slice(PREFS_RS.indexOf("pub fn apply_sentinel_enabled"));
    assert.match(body, /SENTINEL_ENABLED\s*\n?\s*\.store\(enabled/);
    assert.match(body, /state\.set_switch\(enabled\)/);
    assert.match(body, /sentinel_prefs_path\(app\)/);
  });

  it("两个入口打开时都先要麦克风授权——只挡一处等于没挡", () => {
    assert.match(PREFS_RS, /if enabled && !crate::commands::media::acquire_mic_permission\(\)\.await/);
    assert.match(VOICE_RS, /if on && !crate::commands::media::acquire_mic_permission\(\)\.await/);
  });
});

/*
 * M60-02：iPad 真机走查抓出的两条，都属于"编得过、跑得起来、功能不对"。
 * 断言钉在最容易被改回去的那两行上。
 */
describe("[F-52-01] 真机抓出的两处（M60-02）", () => {
  it("转写客户端每次现构造，不在消费者线程外缓一个", () => {
    // 缓一个的后果：线程启动那一刻 token 还没就位，此后一辈子拿着空 token。
    // 网关日志的形状是同一进程里 media/sink 200、asr/transcribe 401（未鉴权）。
    assert.ok(
      !/let gateway = super::media::gateway_client\(\);/.test(VOICE_RS),
      "客户端不许提到循环外——它会把当时的 token 焊死",
    );
    assert.equal(
      VOICE_RS.split("super::media::gateway_client().transcribe_audio").length - 1,
      2,
      "正常段与恢复探测两处都要现构造；只改一处的话降级永远解不开",
    );
  });

  it("打开开关时清掉降级锁——车主的动作就是「再试一次」", () => {
    const body = PREFS_RS.slice(PREFS_RS.indexOf("pub fn apply_sentinel_enabled"));
    assert.match(body, /if enabled \{[\s\S]*?SENTINEL_DEGRADED\s*\n?\s*\.store\(false/);
  });

  it("关掉开关时把录音档位还给系统，否则系统麦克风指示不灭", () => {
    assert.match(SENTINEL_RS, /carlife_media::release_recording_session\(\)/);
    // PTT 让位（paused）不许归还——它马上就要自己用麦克风
    assert.match(SENTINEL_RS, /if !switch_on \{\s*\n\s*want_release = true;/);
    // 播报中不归还：切类别会把正在播的那句掐断
    assert.match(SENTINEL_RS, /want_release && active\.is_none\(\) && !switch_on && !TTS_PLAYING/);
  });
});

describe("[F-52-01] 设置页入口", () => {
  it("有「语音唤醒」这一组，读写走 get/set_sentinel_enabled", () => {
    assert.match(SETTINGS, /语音唤醒/);
    assert.match(SETTINGS, /invoke<boolean>\("get_sentinel_enabled"\)/);
    assert.match(SETTINGS, /invoke<boolean>\("set_sentinel_enabled", \{ enabled: next \}\)/);
  });

  it("显示状态由 Rust 的指示快照喂进来，不是页面自己订阅出来的第二份真相", () => {
    assert.match(SETTINGS, /sentinelOn\?: boolean/);
    assert.match(SETTINGS, /if \(typeof sentinelOn === "boolean"\) setSentinel\(sentinelOn\)/);
  });

  it("打不开时回滚开关并说清原因——停在「开」而不工作比关着更坏", () => {
    assert.match(SETTINGS, /setSentinel\(!next\)/);
    assert.match(SETTINGS, /permission_denied/);
  });
});
