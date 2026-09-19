# 照片来源与授权

每张照片一行；`provenance` 的取值见 `../truth.schema.json`。**来源不明的网络图片只作内部评测，不进任何对外材料。**

| 文件 | provenance | 来源 | 车型 | 登记日期 | 备注 |
|---|---|---|---|---|---|
| `tesla-01.png` | internal-eval-only | 用户 2026-09-08 在会话中提供的网络图片，原始出处未知 | Tesla Model 3/Y | 2026-09-08 | 2000×1333；中控屏左侧行车可视化区，右侧与底部被裁 |
| `store-01.jpg` | team-owned | 2026-09-14 团队在特斯拉门店实拍（展车） | Tesla Model 3/Y（焕新版） | 2026-09-14 | 4032×3024（EXIF Orientation=6：存储像素是横躺的，看图软件按 EXIF 转正后才是竖图）；行驶界面（D 挡 / 速度 / 左侧图标竖列），版式与 tesla-01 相同——2026-09-14 曾误记为"横排"，那是没按 EXIF 转正看的 |
| `store-02.jpg` | team-owned | 同上，同一台车换副驾侧斜拍 | Tesla Model 3/Y（焕新版） | 2026-09-14 | 4032×3024（EXIF=6）；行驶界面，版式同 store-01 |
| `store-03.jpg` | team-owned | 同上，车辆页（深色底） | Tesla Model 3/Y（焕新版） | 2026-09-14 | 5712×4284（无 EXIF 旋转）；**停车界面**（P 挡、"灯光设置"弹窗），指示灯在屏幕左上角；驻车制动这一盏要销售刷钥匙卡才拿得到 |
| `storex-01.jpg` | team-owned | 同上，朋友的车 | Tesla Model X 100D（老款） | 2026-09-14 | 4032×3024（EXIF=6）；老款仪表屏底部状态栏。`symbol_id` 全为 null：图标目录只覆盖 Model 3/Y，而 Model X 的图标本身就不同（充电是绿的、近光是白灰的），拿 Model 3 的目录去认它，颜色这一项直接错。只用于跨车型泛化测量 |

> **版式**（2026-09-16 按 EXIF 转正后重看）：Model 3/Y 只有两种界面——**行驶界面**（tesla-01、store-01、store-02：左侧 D / 速度 / 图标竖列，与训练集同一种）和**停车界面**（store-03：图标在屏幕左上角）；storex-01 是老款 Model X 仪表屏，另一代。
> 2026-09-14 记的"四种摆法、store-01/02 横排"是错的：那两张 EXIF Orientation=6，我按存储像素看图才以为横排。
> **量法的坑**：ultralytics 读原始 JPEG 会按 EXIF 转正再出坐标，PIL/sharp 不会；真值按存储像素量、检测按转正后的图量，IoU 全是 0——store-01/02 上 M80-14 的 B 模型曾因此被量成 0/6，实际 6/6。统一口径：先按 EXIF 转正、真值同步转、再送（`evals/runs/vision-observe-detector-store-exif-aligned.json`）。
> 训练集（Roboflow 底图 + 合成）全是行驶界面；停车界面一张都没有。

## 扩充时的判据（Sprint 判定 1 要 ≥30 张）

- **要真实随手拍**：糊的、反光的、倾斜的、只拍到一半的都要有——干净的手册图标不算（它们进 `negatives/`）。
- 同一辆车不同时刻可以多张，但至少覆盖：红色故障类（制动 / 动力电池）、红色提醒类（安全带 / 门未关）、琥珀色（胎压 / ABS）、绿蓝状态类、灰色未点亮。
- 团队自己车拍的写 `team-owned`；公开图片必须有明确许可才写 `public-licensed`，并在备注写许可。
- 登记后在 `../cases.jsonl` 写真值：**bbox 用画回原图的方式逐个核对**（`corepack pnpm eval:vision-observe -- --model fake` 之前先跑真实档拿框，再人工修）。
