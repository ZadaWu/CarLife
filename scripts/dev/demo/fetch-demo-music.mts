/**
 * 演示曲库的**真实录音**（`corepack pnpm demo:music`）。
 *
 * # 与 `gen-demo-media.mts` 的分工
 *
 * 那个是合成——正弦波叠泛音，听着像音乐盒（客气的说法）或者像机器人（准确的说法）。
 * 这个是**下真人演奏的录音**：Musopen 的肖邦全集，钢琴家实录，CC0。
 *
 * # 为什么只有 CC0 / 公有领域，以及为什么每次都重新查一遍
 *
 * `mocks/cabin/media/.gitignore` 那条纪律仍然成立：商业发行的音乐不进这个仓库。
 * 但"不下商业音乐"不等于"只能自己合成"——**CC0 的真实录音是可以用的**，
 * 第一版漏掉的正是这一整类选项。
 *
 * archive.org 的 `licenseurl` 是**上传者自己填的**，不是平台核过的。
 * 所以这里的判据分两层：
 *
 *  1. 只取 Musopen 这一个来源——它是个以"把古典乐录音放进公有领域"为宗旨的组织，
 *     CC0 声明是它自己作的，不是某个上传者随手勾的；
 *  2. **每次下载前重新拉一次 item 的 `licenseurl` 比对**，对不上就整体中止。
 *     写死在清单里的许可证会过期（条目被替换、被重新授权），而那种过期
 *     不会有任何征兆——直到有人拿它去做商业演示。
 *
 * 逐条的来源与许可证同时写进 `media/PROVENANCE.md`，那份是给人看的凭据。
 *
 * # 为什么不要 ffmpeg
 *
 * Musopen 那个 item 里 FLAC 和 MP3 都有，直接取 MP3——省一次转码，
 * 也绕开本机 `ffmpeg-full` 缺 libvpx 跑不起来这件事（`Cellar/ffmpeg/9.x` 是好的，
 * 但让脚本去猜哪个 ffmpeg 能用不是个好主意）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 只认这两种许可证。别的一律不下——包括各种 CC-BY，它们要署名，演示里给不出。 */
const ACCEPTED_LICENSES = [
  "https://creativecommons.org/publicdomain/zero/1.0/",
  "http://creativecommons.org/publicdomain/zero/1.0/",
  "https://creativecommons.org/publicdomain/mark/1.0/",
  "http://creativecommons.org/publicdomain/mark/1.0/",
];

interface Source {
  /** archive.org 的 item 标识。 */
  item: string;
  /** 这个 item 是什么、为什么可信。 */
  note: string;
  /** item 里的文件名 → 落到曲库里的「艺人 - 曲名」。 */
  picks: Array<{ file: string; artist: string; title: string }>;
}

const CHOPIN = "肖邦（Musopen CC0）";

const SOURCES: Source[] = [
  {
    item: "musopen-chopin-complete-works-flac",
    note: "Musopen《肖邦全集》。Musopen 是专做「把古典乐录音放进公有领域」的非营利组织，CC0 由它自己声明。真人钢琴演奏，非合成。",
    picks: [
      { file: "Nocturne in E flat major, Op. 9 no. 2.mp3", artist: CHOPIN, title: "夜曲 Op.9 No.2" },
      { file: "Nocturne in C sharp minor 'Lento con gran espressione', B. 49 (Op. posth.).mp3", artist: CHOPIN, title: "升c小调夜曲（遗作）" },
      { file: "Waltz in D flat major 'Minute', Op. 64 no. 1.mp3", artist: CHOPIN, title: "小狗圆舞曲 Op.64 No.1" },
      { file: "Waltz in C sharp minor, Op. 64 no. 2.mp3", artist: CHOPIN, title: "升c小调圆舞曲 Op.64 No.2" },
      { file: "Preludes, Op. 28 - No. 15 'Raindrop'.mp3", artist: CHOPIN, title: "雨滴前奏曲 Op.28 No.15" },
      { file: "Preludes, Op. 28 - No. 4 'Suffocation'.mp3", artist: CHOPIN, title: "e小调前奏曲 Op.28 No.4" },
      { file: "Etude Op. 10, no. 3 in E major - 'Tristesse'.mp3", artist: CHOPIN, title: "离别练习曲 Op.10 No.3" },
      { file: "Fantaisie - Impromptu, Op. 66.mp3", artist: CHOPIN, title: "幻想即兴曲 Op.66" },
      { file: "Mazurka Op. 67 no. 4 in A minor.mp3", artist: CHOPIN, title: "a小调玛祖卡 Op.67 No.4" },
    ],
  },
];

const MEDIA_DIR =
  process.env.MOCK_CABIN_MEDIA_DIR ?? new URL("../../../mocks/cabin/media/", import.meta.url).pathname;

async function itemLicense(item: string): Promise<string> {
  const res = await fetch(`https://archive.org/metadata/${item}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`取 item 元数据失败 ${item}: HTTP ${res.status}`);
  const meta = (await res.json()) as { metadata?: { licenseurl?: string } };
  return meta.metadata?.licenseurl ?? "";
}

async function download(item: string, file: string, dest: string): Promise<number> {
  const url = `https://archive.org/download/${item}/${encodeURIComponent(file)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`下载失败 ${file}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 100_000) throw new Error(`${file} 只有 ${bytes.length} 字节，不像一首曲子`);
  writeFileSync(dest, bytes);
  return bytes.length;
}

/** 下完当场解一遍。**"下下来了"和"能放"是两回事**，而后者才是我们要的。 */
function decodes(path: string): boolean {
  try {
    execFileSync("mpg123", ["-t", "-q", path], { stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  const rows: string[] = [];
  let got = 0;

  for (const src of SOURCES) {
    const license = await itemLicense(src.item);
    if (!ACCEPTED_LICENSES.includes(license)) {
      console.error(
        `✗ ${src.item} 的许可证是「${license || "（空）"}」，不在允许清单里——整体中止。\n` +
          "  清单里写死的许可证会过期（条目被替换、被重新授权），而那种过期不会有任何征兆。",
      );
      process.exit(1);
    }
    console.log(`\n${src.item}\n  许可证 ${license} ✓\n  ${src.note}`);

    for (const p of src.picks) {
      const name = `${p.artist} - ${p.title}.mp3`;
      const dest = join(MEDIA_DIR, name);
      const size = await download(src.item, p.file, dest);
      if (!decodes(dest)) {
        console.error(`✗ ${name} 下下来了但解不了——不留半成品`);
        process.exit(1);
      }
      got += 1;
      console.log(`  ✓ ${name}  ${(size / 1e6).toFixed(1)}MB`);
      rows.push(`| ${p.title} | ${p.artist} | \`${src.item}\` | ${license} | \`${p.file}\` |`);
    }
  }

  writeFileSync(
    join(MEDIA_DIR, "PROVENANCE.md"),
    [
      "# 演示曲库里那些**真实录音**的来源",
      "",
      "由 `corepack pnpm demo:music` 生成，**不要手改**——改了下一次下载就会把它覆盖掉。",
      "音频本身不入 git（`.gitignore` 挡着），这份凭据入。",
      "",
      "| 曲名 | 归入的艺人 | archive.org item | 许可证 | 原文件名 |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      "脚本每次下载前会重新拉一次 item 的 `licenseurl` 与允许清单比对，对不上整体中止——",
      "写死在清单里的许可证会过期，而那种过期不会有任何征兆。",
      "",
      `更新于 ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n") + "\n",
  );

  console.log(`\n共 ${got} 首真实录音 → ${MEDIA_DIR}`);
  console.log("凭据写在 media/PROVENANCE.md（入 git），音频不入 git。");
  console.log("下一步：corepack pnpm demo:media 补时长 sidecar，再 curl -sX POST localhost:8793/media/library 重扫");
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
