/**
 * 进程入口。与 `index.ts` 分开的理由同 mock-dealer 的 main.ts：
 * 测试要能 `import { createCabinServer }` 而**不触发监听**。
 */
import { createCabinServer } from "./index";
import { SEED_MODELS } from "./capabilities";
import { backendCaps } from "./media/backend";
import { scanLibrary } from "./media/library";
import { __resetPlayers } from "./media/player";

const PORT = Number(process.env.MOCK_CABIN_PORT ?? 8793);

const lib = await scanLibrary();
const audio = backendCaps();

createCabinServer().listen(PORT, () => {
  // **数字要打出来**：种子没加载成功时，"起来了"和"起来了但是空的"看起来一样。
  console.log(`[mock-cabin] listening on :${PORT} (seedModels=${SEED_MODELS.length}, synthesizesAnyModel=true)`);
  // 音频这一行同理，而且更隐蔽：后端探测失败或曲库为空时，服务照样健康、
  // 点歌照样返回 200，只是**一声不出**——那要到演示现场才会发现。
  console.log(`[mock-cabin] audio backend=${audio.name} tracks=${lib.tracks.length} dir=${lib.dir}`);
  if (audio.name === "none") console.warn(`[mock-cabin] ⚠️ 主机不会出声：${audio.note}`);
  if (lib.tracks.length === 0) console.warn(`[mock-cabin] ⚠️ 曲库是空的，往 ${lib.dir} 里放 mp3`);
});

// 退出时收掉播放子进程。不收的话 mpg123 会被 launchd 收养继续放歌，
// 而服务已经没了——跟 dev.sh 里那些"监护层已死"的孤儿是同一类麻烦。
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    __resetPlayers();
    process.exit(0);
  });
}
process.on("exit", () => __resetPlayers());
