#!/usr/bin/env node

/**
 * Synchronize the validated host model files into a Docker named volume.
 *
 * Docker Desktop may reject a bind mount even when the models are under the
 * repository. Streaming through the Docker CLI keeps the host cache outside
 * the container mount boundary while retaining an immutable, read-only mount
 * for llama-server.
 *
 * ACR-007 起清单是 Qwen3-ASR-0.6B GGUF 的两个文件（主模型 + mmproj），
 * 权威清单在 whisper-model-setup.mjs 的 MODELS 导出——不在这里另抄一份。
 * 卷名仍是 carlife-whisper-models：改名会换卷（Compose 卷名带数据），不混进本次变更。
 */

import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { MODELS } from "./whisper-model-setup.mjs";

const DEFAULT_MODEL_DIR = join(homedir(), ".cache", "whisper-models");
const DEFAULT_VOLUME = "carlife-whisper-models";
const DEFAULT_IMAGE = "carlife-local-asr:llama-v0.3.0";

function usage() {
  console.log(`用法：node infra/scripts/whisper-model-volume.mjs [选项]

选项：
  --model-dir <path>  已校验模型所在目录（默认：${DEFAULT_MODEL_DIR}）
  --volume <name>     Docker 具名卷（默认：${DEFAULT_VOLUME}）
  --image <name>      ASR runtime image（默认：${DEFAULT_IMAGE}）
  --check             只检查具名卷中的模型
  --help              显示帮助
`);
}

function parseArgs(argv) {
  const options = {
    modelDir: process.env.WHISPER_MODEL_DIR || DEFAULT_MODEL_DIR,
    volume: process.env.CARLIFE_ASR_MODEL_VOLUME || DEFAULT_VOLUME,
    image: process.env.CARLIFE_LOCAL_ASR_IMAGE || DEFAULT_IMAGE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--model-dir" || argument === "--volume" || argument === "--image") {
      const key = argument.slice(2).replaceAll("-", "");
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} 不能为空`);
      if (key === "modeldir") options.modelDir = value;
      if (key === "volume") options.volume = value;
      if (key === "image") options.image = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--model-dir=")) {
      options.modelDir = argument.slice("--model-dir=".length);
      continue;
    }
    if (argument.startsWith("--volume=")) {
      options.volume = argument.slice("--volume=".length);
      continue;
    }
    if (argument.startsWith("--image=")) {
      options.image = argument.slice("--image=".length);
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  if (!options.modelDir || !options.volume || !options.image) {
    throw new Error("model-dir、volume 和 image 均不能为空");
  }
  return options;
}

function run(command, args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(error);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectOnce);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolveResult({ code, signal, stdout, stderr });
    });

    if (input) {
      input.on("error", rejectOnce);
      input.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertHostModel(model, modelPath) {
  if (!(await fileExists(modelPath))) {
    throw new Error(`宿主模型不存在：${modelPath}`);
  }
  const fileStat = await stat(modelPath);
  if (!fileStat.isFile()) throw new Error(`宿主模型不是普通文件：${modelPath}`);
  if (fileStat.size !== model.bytes) {
    throw new Error(`宿主模型大小 ${fileStat.size}，期望 ${model.bytes}`);
  }
}

async function ensureVolume(volume) {
  const inspected = await run("docker", ["volume", "inspect", volume]);
  if (inspected.code === 0) return;
  const created = await run("docker", ["volume", "create", "--name", volume]);
  if (created.code !== 0) {
    throw new Error(`创建 Docker 具名卷失败：${created.stderr.trim()}`);
  }
}

async function volumeDigest(model, volume, image) {
  // ADR-004：容器内 sh 变量不用 zsh 特殊名（model/path/status），用领域前缀。
  const command = [
    "set -eu",
    `asr_model_file=/models/${model.filename}`,
    'test -f "$asr_model_file"',
    'stat -c "%s" "$asr_model_file"',
    'sha256sum "$asr_model_file" | awk \'{print $1}\'',
  ].join("; ");
  const result = await run("docker", [
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "/bin/sh",
    "--mount",
    `type=volume,source=${volume},target=/models,readonly`,
    image,
    "-c",
    command,
  ]);
  if (result.code !== 0) return null;
  const values = result.stdout.trim().split(/\s+/);
  if (values.length < 2) return null;
  return { bytes: Number(values[0]), sha256: values[1] };
}

async function copyIntoVolume(model, modelPath, volume, image) {
  const command = [
    "set -eu",
    `asr_model_tmp=/models/${model.filename}.part`,
    `asr_model_file=/models/${model.filename}`,
    'cat > "$asr_model_tmp"',
    'chmod 0444 "$asr_model_tmp"',
    'mv -f "$asr_model_tmp" "$asr_model_file"',
  ].join("; ");
  const result = await run(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "0",
      "--interactive",
      "--entrypoint",
      "/bin/sh",
      "--mount",
      `type=volume,source=${volume},target=/models`,
      image,
      "-c",
      command,
    ],
    createReadStream(modelPath),
  );
  if (result.code !== 0) {
    throw new Error(`写入 Docker 具名卷失败：${result.stderr.trim()}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  await ensureVolume(options.volume);
  for (const model of MODELS) {
    const modelPath = join(resolve(options.modelDir), model.filename);
    const existing = await volumeDigest(model, options.volume, options.image);
    if (
      existing &&
      existing.bytes === model.bytes &&
      existing.sha256 === model.sha256
    ) {
      console.log(`✓ Docker 具名卷模型已校验：${options.volume}/${model.filename}`);
      continue;
    }
    if (options.check) {
      throw new Error(
        `Docker 具名卷模型未通过校验：${options.volume}/${model.filename}`,
      );
    }

    await assertHostModel(model, modelPath);
    console.log(`同步模型到 Docker 具名卷：${options.volume}/${model.filename}…`);
    await copyIntoVolume(model, modelPath, options.volume, options.image);
    const copied = await volumeDigest(model, options.volume, options.image);
    if (
      !copied ||
      copied.bytes !== model.bytes ||
      copied.sha256 !== model.sha256
    ) {
      throw new Error(
        `Docker 具名卷模型校验失败：${options.volume}/${model.filename}`,
      );
    }
    console.log(`✓ Docker 具名卷模型同步并校验通过：${options.volume}/${model.filename}`);
  }
}

main().catch((error) => {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
