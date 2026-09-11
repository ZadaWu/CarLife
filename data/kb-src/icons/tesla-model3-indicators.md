# Tesla Model 3 / Model Y 触摸屏指示灯目录

vehicle: Tesla Model 3/Y

> 文本路真相源。名称、类别、级别、锚点、原文说明来自 `data/kb-md/Model3_车主手册.2fcd395b.md` 的「指示灯」（第 462 行起）、
> 「大灯指示灯」（2757 行起）两节。
>
> **2026-09-09 已对图**（此前描述子按 ISO 2575 通用符号起草、图片列全空，因为仓库里没有手册 PDF、特斯拉在线手册对脚本返回 403）：
> 用车主手册 PDF（268 页中文版）第 13–14 页「车辆状态 › 指示灯」按 300 dpi 渲染，逐个裁出 27 枚图标存进 `tesla-model3/`（白底转透明、统一 256 高），
> 「图片」列与「描述子来源」按实测更新。对图查出三处错，都已改：
>
> - `fog_lamp_front`（前雾灯已开）**在 Model 3 手册里根本不存在**，是起草时凭空补的 → `descriptorSource: deprecated`，保留占位但不进索引、不参与匹配；
> - `regen_limited`（能量回收制动受限，绿色圆弧 + 闪电）漏了 → 已补；
> - 五条描述子与实际画法不符（后雾灯没有波浪线、充电是插头不是电池、过热是散热器不是温度计、行人警示是车加喇叭打叉、制动两条带 BRAKE 字样）→ 已改。
>
> 同一次对图还发现评测真值有一条错：`evals/vision-observe/cases.jsonl` 里 tesla-01 的第三个绿灯原标 `fog_lamp_front`，实为 `parking_lights`，已更正。

> 级别是**类别 × 颜色**的二维表：fault ∩ 红 = stop；fault ∩ 其它 = check_soon；reminder / status = info。
> 安全带是红的但只是提醒——这张表存在的理由。
>
> 词表与 `@carlife/tools` vision 的 `VISION_VOCAB` 同一套：shape / color / elements / text。

| symbol_id | 名称 | class | severity | shape | color | elements | text | 手册锚点 | 原文说明 | 描述子来源 | 图片 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| brake_system_fault | 制动系统故障 | fault | stop | circle | red | exclamation, parentheses | BRAKE | Model 3 车主手册 › 指示灯 › 制动系统 | 除首次启动短暂显示外，触摸屏在其他时间显示该红色制动指示灯，说明检测到制动系统故障或制动液液位低，请立即联系 Tesla | manual-image | brake_system_fault.png |
| brake_booster_fault | 制动助力器故障 | fault | check_soon | circle | amber | exclamation, parentheses | BRAKE | Model 3 车主手册 › 指示灯 › 制动助力 | 检测到制动助力器故障时触摸屏显示琥珀色指示灯；施加稳定压力并牢牢踩住制动踏板，在安全情况下停车 | manual-image | brake_booster_fault.png |
| abs_fault | ABS 故障 | fault | check_soon | circle | amber | parentheses | ABS | Model 3 车主手册 › 指示灯 › ABS | 首次启动时琥珀色短暂闪烁；其它时候亮起表明 ABS 发生故障且未在工作，联系 Tesla | manual-image | abs_fault.png |
| parking_brake_on | 驻车制动已施加 | status | info | circle | red | parentheses | P, PARK | Model 3 车主手册 › 指示灯 › 驻车制动 | 手动施加驻车制动时，触摸屏上的红色驻车制动指示灯亮起 | manual-image | parking_brake_on.png |
| parking_brake_fault | 驻车制动电气故障 | fault | check_soon | circle | amber | parentheses | P | Model 3 车主手册 › 指示灯 › 驻车制动 | 驻车制动器遇到电气问题时琥珀色驻车制动指示灯亮起，并显示一条故障消息 | manual-image | parking_brake_fault.png |
| tpms_warning | 胎压报警 | fault | check_soon | wheel | amber | exclamation | - | Model 3 车主手册 › 指示灯 › 胎压 | 某个轮胎压力超出范围（琥珀色）；检测到 TPMS 故障时指示灯闪烁，请联系 Tesla | manual-image | tpms_warning.png |
| seatbelt_unfastened | 安全带未系提醒 | reminder | info | person | red | diagonal_band | - | Model 3 车主手册 › 指示灯 › 安全带 | 乘客座椅安全带未系好（指示灯为红色），请参阅座椅安全带 | manual-image | seatbelt_unfastened.png |
| airbag_warning | 气囊安全指示 | fault | stop | person | red | circle_ring | - | Model 3 车主手册 › 指示灯 › 气囊 | 准备行驶时若该指示灯未短暂闪烁或始终点亮，请立即联系 Tesla | manual-image | airbag_warning.png |
| fog_lamp_rear | 后雾灯已开 | status | info | lamp | amber | straight_lines | - | Model 3 车主手册 › 指示灯 › 后雾灯 | 每当后雾灯亮起时触摸屏显示后雾灯指示符（如果配备） | manual-image | fog_lamp_rear.png |
| fog_lamp_front | 前雾灯已开（已废弃） | status | info | lamp | green | wavy_lines, straight_lines | - | Model 3 车主手册 › 指示灯 › 雾灯 | **Model 3 车主手册里没有前雾灯指示灯**（只有后雾灯）：2026-09-09 对着手册第 13–14 页逐个图标核对时发现，本条是按 ISO 通用符号起草时凭空补的，实际不存在。保留占位，不再参与匹配 | deprecated | - |
| parking_lights | 驻车灯已开 | status | info | lamp | green | straight_lines | - | Model 3 车主手册 › 指示灯 › 驻车灯 | 驻车灯亮起（示廓灯、尾灯和牌照灯）（指示灯为绿色），请参阅车灯 | manual-image | parking_lights.png |
| ready | 准备就绪 | status | info | letter_only | green | - | READY | Model 3 车主手册 › 指示灯 › 车辆状态 | Model 3 准备就绪，可以行驶（指示灯为绿色） | manual-image | ready.png |
| low_beam | 近光灯已开 | status | info | lamp | green | straight_lines | - | Model 3 车主手册 › 大灯指示灯 › 近光 | 近光大灯亮起（指示灯为绿色） | manual-image | low_beam.png |
| high_beam | 远光灯已开 | status | info | lamp | blue | straight_lines | - | Model 3 车主手册 › 大灯指示灯 › 远光 | 远光大灯亮起且自适应大灯被禁用或当前不可用（指示灯为蓝色） | manual-image | high_beam.png |
| auto_high_beam_active | 自适应远光已启用且远光开 | status | info | lamp | blue | straight_lines | A | Model 3 车主手册 › 大灯指示灯 › 自适应远光 | 自适应大灯已启用且远光灯打开，探测到光线时随时准备关闭远光（指示灯为蓝色） | manual-image | auto_high_beam_active.png |
| auto_high_beam_standby | 自适应远光待机 | status | info | lamp | gray | straight_lines | A | Model 3 车主手册 › 大灯指示灯 › 自适应远光 | 自适应大灯已启用，但远光灯因探测到前方有光线而未亮起（指示灯为灰色） | manual-image | auto_high_beam_standby.png |
| esc_active | 电子稳定控制介入 | status | info | car_outline | amber | wavy_lines | - | Model 3 车主手册 › 指示灯 › 牵引力控制 | 电子稳定控制系统主动把车轮空转降至最低时该指示灯闪烁 | manual-image | esc_active.png |
| esc_off | 电子稳定控制已关 | status | info | car_outline | amber | wavy_lines | OFF | Model 3 车主手册 › 指示灯 › 牵引力控制 | 电子稳定性控制系统不再最大程度减少车轮空转（琥珀色）；后驱牵引力控制已关闭，全驱脱困起步已启用 | manual-image | esc_off.png |
| vehicle_hold | 车辆保持已激活 | status | info | circle | gray | - | H | Model 3 车主手册 › 指示灯 › 车辆保持 | 车辆保持功能主动进行制动（指示灯为灰色） | manual-image | vehicle_hold.png |
| door_open | 车门或行李箱打开 | reminder | info | car_outline | red | - | - | Model 3 车主手册 › 指示灯 › 车门 | 某个车门或行李箱打开（指示灯为红色），请参阅车门、后备箱或前备箱 | manual-image | door_open.png |
| pedestrian_warning_paused | 行人警示系统暂停 | status | info | car_outline | gray | cross | - | Model 3 车主手册 › 指示灯 › 行人警示 | 行人警示系统已暂停（指示灯为灰色） | manual-image | pedestrian_warning_paused.png |
| battery_low | 电量不足 | status | info | battery | amber | - | - | Model 3 车主手册 › 指示灯 › 电池 | 充电量不足（剩余电量 <20%）时，绿色电池指示灯变为琥珀色 | manual-image | battery_low.png |
| battery_cold | 电池低温储备受限 | status | info | other | blue | - | - | Model 3 车主手册 › 指示灯 › 电池 | 蓝色雪花表示寒冷天气导致电池中储备的部分电能无法使用，充电速率也可能受限 | manual-image | battery_cold.png |
| power_limited | 车辆功率受限 | status | info | other | amber | - | - | Model 3 车主手册 › 指示灯 › 功率 | 车辆功率目前受限：剩余电量较低、系统正在加热或制冷、或电机逆变器检测到错误（琥珀色） | manual-image | power_limited.png |
| charging_plugged | 正在充电 | reminder | info | other | red | none | - | Model 3 车主手册 › 指示灯 › 充电 | 电池正在充电（指示灯为红色）。行驶前应先拔下插头 | manual-image | charging_plugged.png |
| regen_limited | 能量回收制动受限 | status | info | circle | green | arrow_both | - | Model 3 车主手册 › 指示灯 › 能量回收制动 | 能量回收制动受限时显示（指示灯为绿色，圆弧 + 闪电） | manual-image | regen_limited.png |
| system_overheat | 车辆系统过热 | fault | stop | other | red | wavy_lines | - | Model 3 车主手册 › 指示灯 › 过热 | 车辆系统过热（红色）。立即靠边停车并让系统冷却 | manual-image | system_overheat.png |
| system_fault | 系统故障 | fault | stop | triangle | red | exclamation | - | Model 3 车主手册 › 指示灯 › 系统故障 | 系统故障（红色）。遵照所显示的相关信息中的提示，联系 Tesla | manual-image | system_fault.png |
