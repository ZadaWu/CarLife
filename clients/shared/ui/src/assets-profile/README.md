# 档案卡通形象素材（入包版）

**由脚本生成，禁止手工编辑。** 源图在
`内部文档`
（1024² 透明 PNG，见那边的 `manifest.json` 与 README）。

```bash
node scripts/assets/build-profile-assets.mjs           # 生成
node scripts/assets/build-profile-assets.mjs --check   # 校验是否最新
```

入包版本统一缩到 **512px**——原图 16 张约 15MB，车机端展示尺寸只有约 200pt，
直接打包不可接受。同一条纪律见 [`../assets-hud/README.md`](../assets-hud/README.md)。

## 覆盖范围与它的边界

车型 4 款、人物 5 位，**范围来自知识库真实覆盖与主线家庭原型**，不是完整枚举。
消费方 [`profile-characters.ts`](../vehicle/profile-characters.ts) 因此
**匹配不到就不显示图**：拿别款车、别人的脸顶替，比没有图糟得多——
用户会以为系统认识这辆车 / 这个人。**性别相反的脸更糟**：选形象的规则因此过一道
性别闸（`../vehicle/person-art-match.ts`），判不出性别就不给图。
