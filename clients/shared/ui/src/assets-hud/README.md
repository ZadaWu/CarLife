# 车机端 HUD 视觉资产

`light/` 与 `dark/` 中的 PNG 由脚本生成，禁止手工编辑。人物与物品精灵由 Image Gen 生成并存放在 `generated/`，脚本会将它们复制到两个主题目录；直接改动主题目录仍会在下次运行脚本时被覆盖。

根目录的 `poi-*.png` 是另一组**品类级透明底 POI 贴纸**：由同一批 Image Gen 任务生成、色键去背，带白色描边，可直接由 light / dark 两主题共用。这些文件是 `hud/sprites.ts` 的当前 POI 来源，不能用主题目录里从定稿图截取的旧 POI 替代。

## 来源

| 主题 | 定稿源图 |
| --- | --- |
| `light/` | `内部文档` |
| `dark/` | `内部文档` |
| `generated/` | Image Gen 生成的完整透明助手、遮阳帽、防晒霜与水瓶源精灵，以及品类 POI 的 1254px 原稿 |
| `poi-*.png` | Image Gen 批量生成、色键去背的透明底品类 POI；两个主题共用。**根目录版本统一缩到 512px**（打包体积），原稿在 `generated/`，重新生成后记得同样 `sips -Z 512` |

两张定稿图均为 1672 × 941 且元素逐像素对齐，因此 POI 和晴热图标共用同一套源坐标。助手与三件行前物品不再从定稿图裁切，以避免边缘裁切；它们由 generated/ 中带 alpha 的完整 Image Gen 源精灵同步到两套主题。

## 重新生成

```bash
python3 scripts/assets/extract-hud-assets.py          # 生成
python3 scripts/assets/extract-hud-assets.py --check  # 校验是否最新（CI 用）
python3 scripts/assets/verify-hud-assets.py           # 校验遮罩/去背是否生效
```

> M20-02 修了一处静默失效：两个脚本的 `OUT_ROOT` 还指着 `clients/cockpit/src/assets/hud`——
> 资产在 A3 就随 `clients/shared/ui` 搬走了，那个目录**早已不存在**，照跑会在错误的地方新建一份
> 且不报错。改指本目录之前逐字节比对过：重跑产物与仓库里已提交的 10 张完全一致。

## 新增行前物品贴纸（M20-02）

```bash
scripts/assets/gen-item-sprites/run.sh umbrella jacket sunglasses thermos mask  # codex image_gen 出图
python3 scripts/assets/gen-item-sprites/sync.py                                  # 裁边 + 512px + 同步两主题
python3 scripts/assets/extract-hud-assets.py                                     # 刷新 contact-sheet
```

天气图标（M20-05）走同一条管线，只是归一到 **128px**（定稿的 `icon-sun` 只有 56px，
它是标题旁边的小图不是贴纸）：

```bash
cd clients/shared/ui/src/assets-hud/generated && codex exec --dangerously-bypass-approvals-and-sandbox - \
  < ../../../../../scripts/assets/gen-item-sprites/prompt-icon-rain.txt
python3 scripts/assets/gen-item-sprites/sync.py icon-rain icon-snow icon-haze icon-cloudy icon-overcast
```

⚠️ 天气图标的提示词与物品**不是同一套**：物品是 3D 质感贴纸，天气图标是扁平小图标。
拿物品那套提示词去出天气图，会得到一朵写实的云放在标题旁边。

出图这一步会安静地失败，实测两种（2026-08-14）：**黑底 + 光晕的写实渲染**，
以及**把"透明"画成灰白棋盘格**——后者肉眼看像透明底，贴到地图上却是一块马赛克方块。
`sync.py` 用四角 alpha 挡这两种，挡不住的靠 `contact-sheet.png` 人眼看。

坐标常量与提取策略都在 [`scripts/assets/extract-hud-assets.py`](../../../../../scripts/extract-hud-assets.py) 顶部。

## 当前品类 POI（两个主题共用）

| 文件 | 品类 |
| --- | --- |
| `poi-temple` | 古迹 / 祠庙 |
| `poi-park` | 公园 |
| `poi-amusement-park` | 游乐园 |
| `poi-museum` | 博物馆 / 展馆 |
| `poi-mountain` | 山岳 |
| `poi-wetland` | 湖泊湿地 |
| `poi-beach` | 海滩 |
| `poi-old-town` | 古镇街区 |
| `poi-food` | 美食 |
| `poi-hotel` | 酒店 |
| `poi-charge` | 充电站 |
| `poi-home` | 家 |
| `poi-spot` | 景点（未知品类的唯一兜底） |

`HudScreen` 仅按 `kind` 映射；未映射的类别始终使用 `poi-spot`，不得根据景点名称猜图。

## 旧定稿提取资产（每个主题 10 项 + 1 张核验图）

| 文件 | 说明 | 提取策略 |
| --- | --- | --- |
| `poi-home` | 家（出发锚点，含辅助定位 pin） | 基座椭圆 ∪ 内容椭圆，羽化 7px |
| `poi-park` | ① 亲子乐园 | 同上 |
| `poi-charge` | ② 充电站 | 同上 |
| `poi-rest` | ③ 休息区 | 同上 |
| `poi-wetland` | ④ 湿地公园（终点） | 同上 |
| `assistant` | 完整卡通助手 | Image Gen 完整精灵 + 色键去背 |
| `item-hat` | 遮阳帽 | Image Gen 完整精灵 + 色键去背 |
| `item-sunscreen` | 防晒霜 | Image Gen 完整精灵 + 色键去背 |
| `item-water` | 水 | Image Gen 完整精灵 + 色键去背 |
| `item-umbrella` | 雨伞（M20-02） | codex `image_gen` 透明精灵，裁边后最长边 512 |
| `item-jacket` | 薄外套（M20-02） | 同上 |
| `item-sunglasses` | 墨镜（M20-02） | 同上 |
| `item-thermos` | 保温杯（M20-02） | 同上 |
| `item-mask` | 口罩（M20-02） | 同上 |
| `icon-sun` | 晴天气图标 | 边框泛洪去背 |
| `icon-cloudy` | 多云（M20-05） | codex `image_gen` 扁平小图标，裁边后最长边 128 |
| `icon-overcast` | 阴（M20-05） | 同上 |
| `icon-rain` | 有雨（M20-05） | 同上 |
| `icon-snow` | 有雪（M20-05） | 同上 |
| `icon-haze` | 雾霾（M20-05） | 同上 |
| `contact-sheet` | 合成到本主题地图底色的人工核验图 | — |

## 使用约束

1. **当前 POI 跨主题共用**：根目录的 `poi-*.png` 有 alpha 与白色描边，可以在两个主题共用。主题目录中的旧 `poi-*` 是保留少量地图底色的历史截取，不能混用，也不能重新接入 `SPRITES`。
2. **琥珀轨迹不在精灵里**：生活环由 `LifeRing` 组件用 SVG 绘制；提取时已刻意避开轨迹与序号标签胶囊，避免烘焙进图片后无法随数据变化。
3. **序号徽章与地点名不在精灵里**：由 `PoiNode` 组件渲染，因为节点会随真实计划重新编号（Brief §3.1）。
4. 主题目录中的旧定稿提取资产仍以定稿图为视觉基准，不得重绘或像素级拉伸；根目录的品类 POI 按本文件记录的同批透明贴纸规范维护。
