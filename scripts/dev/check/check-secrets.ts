/**
 * 仓库明文密钥扫描（施工单 M3-06，F-35-13）。
 *
 * 运行：`corepack pnpm check:secrets`
 *
 * 设计取舍：**宁可漏报也不要高误报**。一个天天误报的检查，
 * 第 N 次真报时也会被顺手跳过——那时它等于不存在。
 * 因此只匹配已知 provider 的 key 形态 + 明确的高熵赋值，
 * 并显式放过 `.env.example` 的空值与占位。
 *
 * 覆盖范围：git 跟踪的文件 + 暂存区（不扫 node_modules / dist / target）。
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

interface Rule {
  name: string;
  re: RegExp;
}

const RULES: readonly Rule[] = [
  // 已知 provider 的 key 形态
  { name: "OpenAI/DeepSeek 风格 key", re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  // 2026-09-02：.env.example 的注释里躺过一把真实的 RAM key，此前没有规则能认出它
  { name: "阿里云 AccessKey ID", re: /\bLTAI[0-9A-Za-z]{12,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "私钥 PEM", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // 通用：<敏感名> = <长且高熵的字面量>
  {
    name: "疑似密钥赋值",
    re: /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{20,}["']/i,
  },
];

/** 明确放行：模板占位、示例值、e2e 里的假值 */
const ALLOW = [
  /["']\s*["']/, // 空值
  /(your|example|placeholder|changeme|xxx+|<[^>]+>)/i,
  /\be2e-[a-z-]*key\b/i,
  /dev-local-master-key/i,
];

const SKIP_PATH = /(^|\/)(node_modules|dist|target|\.git|pnpm-lock\.yaml)(\/|$)|\.(png|jpg|jpeg|webp|ico|pdf|docx|woff2?)$/i;

function trackedFiles(): string[] {
  const out = execSync("git ls-files -co --exclude-standard", { encoding: "utf8" });
  return out.split("\n").filter((f) => f.length > 0 && !SKIP_PATH.test(f));
}

interface Hit {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

const hits: Hit[] = [];

for (const file of trackedFiles()) {
  let content: string;
  try {
    if (statSync(file).size > 2_000_000) continue;
    content = readFileSync(file, "utf8");
  } catch {
    continue; // 二进制或无权限
  }

  content.split("\n").forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({
          file,
          line: i + 1,
          rule: rule.name,
          // 只回显前 40 字符并打码尾部，报告本身不能成为泄露渠道
          excerpt: `${line.trim().slice(0, 40)}…`,
        });
        break;
      }
    }
  });
}

if (hits.length > 0) {
  console.error(`✗ 发现 ${hits.length} 处疑似明文密钥：`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.rule}]  ${h.excerpt}`);
  }
  console.error("\n密钥不入代码库（AC-35-2）。请改为环境变量注入或后台配置项。");
  process.exit(1);
}

console.log("✓ 未发现明文密钥");
console.log("提示：可接入 pre-commit（本脚本不自动安装 hook，避免干扰他人本地环境）");
