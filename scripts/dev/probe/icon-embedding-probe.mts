// ACR-025 第 1 步探针：DashScope 多模态向量接口的路径、维度、图文同空间相似度。
// 用法：corepack pnpm probe:icon-embedding <图A.png> <图B.png> "<文A>" "<文B>" [model...]
// 结果读法与 2026-09-08 的数字见 enterprise/backend/shared/rag/README.md。
import { readFileSync } from "node:fs";

const [imgA, imgB, textA, textB, ...models] = process.argv.slice(2);
if (!imgA || !imgB || !textA || !textB) {
  console.error('用法：icon-embedding-probe.mts <图A> <图B> "<文A>" "<文B>" [model...]');
  process.exit(2);
}
const key = process.env.DASHSCOPE_API_KEY;
if (!key) {
  console.error("DASHSCOPE_API_KEY 为空——.env 里的变量要 set -a 导出");
  process.exit(2);
}
const URL_ = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
const mime = (f) => (f.endsWith(".png") ? "image/png" : "image/jpeg");
const img = (f) => `data:${mime(f)};base64,${readFileSync(f).toString("base64")}`;

async function embed(model, contents) {
  const t0 = Date.now();
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: { contents }, parameters: {} }),
  });
  const j = await res.json();
  if (!res.ok) {
    console.error(model, res.status, JSON.stringify(j).slice(0, 300));
    return null;
  }
  const embs = j.output?.embeddings ?? [];
  console.error(`${model}  ${Date.now() - t0} ms  n=${embs.length}  dim=${embs[0]?.embedding?.length}  usage=${JSON.stringify(j.usage)}`);
  return embs.map((e) => e.embedding);
}
const cos = (a, b) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb);
};

for (const model of models.length ? models : ["qwen3-vl-embedding", "tongyi-embedding-vision-flash-2026-03-06"]) {
  const a = await embed(model, [{ image: img(imgA) }]);
  const b = await embed(model, [{ image: img(imgB) }]);
  const ta = await embed(model, [{ text: textA }]);
  const tb = await embed(model, [{ text: textB }]);
  if (a && b && ta && tb) {
    console.log(
      `${model}: cos(A_img,A_txt)=${cos(a[0], ta[0]).toFixed(3)}  cos(A_img,B_txt)=${cos(a[0], tb[0]).toFixed(3)}  ` +
        `cos(B_img,B_txt)=${cos(b[0], tb[0]).toFixed(3)}  cos(B_img,A_txt)=${cos(b[0], ta[0]).toFixed(3)}  cos(A_img,B_img)=${cos(a[0], b[0]).toFixed(3)}`,
    );
  }
}
