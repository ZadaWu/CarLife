# 按图片内容哈希索引的 fixture

`@carlife/tools` 的 fake 视觉 provider（`CARLIFE_VISION=fake`）按图片字节的 sha256 前 8 位取 `<sha8>.json`，
内容与上一级目录的整图观察 fixture 同形（frame + items 含描述子与 bbox）。
新增照片时：`node -e` 算 sha8，把对应模型的 fixture 复制过来。tesla-01 的是 qwen3-vl-plus 2026-09-08 的输出。
