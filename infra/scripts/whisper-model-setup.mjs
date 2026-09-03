#!/usr/bin/env node

/**
 * Prepare the external ASR model files used by the local ASR container.
 *
 * ACR-007 起模型是 Qwen3-ASR-0.6B GGUF 的两个文件（主模型 + mmproj 音频编码器），
 * 来源固定到 ggml-org 仓库的一个 commit；校验值取自 Hugging Face LFS 指针的
 * SHA-256 与字节数。部分下载永远不会被提升为最终文件名。
 *
 * 文件名仍叫 whisper-model-setup.mjs：改名会波及 _common.sh / dev-infra.sh /
 * package.json 的调用点，不混进本次变更（ACR-007 变更范围明确排除改名）。
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

// 固定 commit 而不是 main：与 Dockerfile 固定源码 tarball 是同一条纪律。
const MODEL_REPO_BASE =
  "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/" +
  "928ab958557df9aa2ef1c93e0e83c7ad0933fae2/";

export const MODELS = [
  {
    filename: "Qwen3-ASR-0.6B-Q8_0.gguf",
    bytes: 804_749_248,
    sha256: "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
  },
  {
    filename: "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    bytes: 214_392_480,
    sha256: "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
  },
];

const DEFAULT_MODEL_DIR = join(homedir(), ".cache", "whisper-models");

function usage() {
  console.log(`用法：node infra/scripts/whisper-model-setup.mjs [选项]

选项：
  --model-dir <path>  模型目录（默认：${DEFAULT_MODEL_DIR}）
  --check             只校验已有模型，不下载
  --force             已有模型校验失败时重新下载
  --help              显示帮助

模型（共 ${MODELS.length} 个文件）：
${MODELS.map((m) => `  ${m.filename}（${(m.bytes / 1e6).toFixed(0)}MB）`).join("\n")}
来源：${MODEL_REPO_BASE}
`);
}

function parseArgs(argv) {
  const options = { modelDir: process.env.WHISPER_MODEL_DIR || DEFAULT_MODEL_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--model-dir") {
      options.modelDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--model-dir=")) {
      options.modelDir = argument.slice("--model-dir=".length);
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  if (!options.modelDir) throw new Error("--model-dir 不能为空");
  return options;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function digestFile(filePath) {
  const sha256 = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    sha256.update(chunk);
  }
  return { bytes, sha256: sha256.digest("hex") };
}

async function verifyModel(model, filePath) {
  if (!(await exists(filePath))) {
    return { ok: false, reason: "文件不存在" };
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) return { ok: false, reason: "路径不是普通文件" };

  const digest = await digestFile(filePath);
  if (digest.bytes !== model.bytes) {
    return { ok: false, reason: `大小 ${digest.bytes}，期望 ${model.bytes}` };
  }
  if (digest.sha256 !== model.sha256) {
    return { ok: false, reason: `SHA-256 ${digest.sha256}，期望 ${model.sha256}` };
  }
  return { ok: true, digest };
}

async function downloadModel(model, destination) {
  console.log(`下载 ${model.filename}（约 ${(model.bytes / 1e6).toFixed(0)}MB）…`);
  const response = await fetch(MODEL_REPO_BASE + model.filename, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`模型下载失败：HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("模型下载失败：响应没有 body");

  const sha256 = createHash("sha256");
  let bytes = 0;
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      sha256.update(chunk);
      callback(null, chunk);
    },
  });

  const temporary = `${destination}.part-${process.pid}-${randomUUID()}`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      hashing,
      createWriteStream(temporary, { flags: "wx", mode: 0o644 }),
    );
    const digest = { bytes, sha256: sha256.digest("hex") };
    if (digest.bytes !== model.bytes) {
      throw new Error(`下载大小 ${digest.bytes}，期望 ${model.bytes}`);
    }
    if (digest.sha256 !== model.sha256) {
      throw new Error(`下载 SHA-256 ${digest.sha256}，期望 ${model.sha256}`);
    }
    await rename(temporary, destination);
    return digest;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const modelDir = resolve(options.modelDir);
  for (const model of MODELS) {
    const destination = join(modelDir, model.filename);
    const current = await verifyModel(model, destination);
    if (current.ok) {
      console.log(`✓ 模型已存在且校验通过：${destination}`);
      console.log(`  bytes=${current.digest.bytes} sha256=${current.digest.sha256}`);
      continue;
    }

    if (options.check) {
      throw new Error(`模型校验失败：${destination}（${current.reason}）`);
    }
    if ((await exists(destination)) && !options.force) {
      throw new Error(
        `模型已存在但校验失败：${current.reason}；如确认重新下载请加 --force`,
      );
    }

    await mkdir(modelDir, { recursive: true });
    const digest = await downloadModel(model, destination);
    console.log(`✓ 模型已保存并校验通过：${destination}`);
    console.log(`  bytes=${digest.bytes} sha256=${digest.sha256}`);
  }
}

// 仅直接执行时跑 main：whisper-model-volume.mjs 会 import 上面的 MODELS 清单
// （单一真相源），import 不能触发校验或下载。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
