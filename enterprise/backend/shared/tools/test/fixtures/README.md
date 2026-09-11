# tools 测试用样本

| 文件 | 怎么来的 | 为什么要它 |
|---|---|---|
| `solid-800x600.heic` | macOS `sips -s format heic` 把一张 800×600 纯色 PNG 转出来（865 B，无实拍内容、无 EXIF 位置） | **HEIC 是 iPhone 的默认格式**，而本机 sharp / libvips 解不了它（缺 HEVC 解码插件）。这条链只能靠 ffmpeg 兜底，而"兜底真的兜住了"必须用一张真 HEIC 证明——ffmpeg 造不出 HEIF 容器（只能造 AVIF），所以样本进仓库 |

其余格式（TIFF / GIF / AVIF / 超大 PNG / 带 EXIF 旋转的 JPEG / BMP）都在测试里现场生成，不入库。
