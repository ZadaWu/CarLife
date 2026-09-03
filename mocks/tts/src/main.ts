/**
 * 进程入口。与 `index.ts` 分开的理由同 mock-dealer / mock-cabin 的 main.ts：
 * 测试要能 `import { createTtsServer }` 而**不触发监听**。
 */
import { createTtsServer } from "./index";
import { detectEncoder, installedVoices, resolveVoice } from "./synth";

const PORT = Number(process.env.MOCK_TTS_PORT ?? 8794);

const encoder = await detectEncoder();
const female = await resolveVoice("zh_female_vv_uranus_bigtts");
const male = await resolveVoice("zh_male_xxx_bigtts");
const installedVoicesCount = (await installedVoices()).length;

createTtsServer().listen(PORT, () => {
  console.log(`[mock-tts] listening on :${PORT}  POST /api/v3/tts/unidirectional`);
  // **把「怎么出声」打出来**：mp3 编码器缺席时，服务照样健康、请求照样 200
  // （wav/pcm 分支），只有点 mp3 的那一路会失败——不打这一行，
  // 那就是一个"平时都好，偏偏 cockpit 用不了"的谜题。
  console.log(
    `[mock-tts] 引擎：macOS say（不计费）｜mp3 编码器：${encoder}｜音色 female=${female ?? "系统默认"} male=${male ?? "系统默认"}`,
  );
  if (encoder === "none") {
    console.warn("[mock-tts] ⚠️ 没有 mp3 编码器，请 `brew install lame`；否则只有 wav/pcm 可用");
  }
  if (female === null && male === null) {
    console.warn(
      `[mock-tts] ⚠️ 没找到中文音色（本机装了 ${installedVoicesCount} 个），将用系统默认音色朗读中文`,
    );
  }
});
