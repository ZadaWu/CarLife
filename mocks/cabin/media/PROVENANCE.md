# 演示曲库里那些**真实录音**的来源

由 `corepack pnpm demo:music` 生成，**不要手改**——改了下一次下载就会把它覆盖掉。
音频本身不入 git（`.gitignore` 挡着），这份凭据入。

| 曲名 | 归入的艺人 | archive.org item | 许可证 | 原文件名 |
|---|---|---|---|---|
| 夜曲 Op.9 No.2 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Nocturne in E flat major, Op. 9 no. 2.mp3` |
| 升c小调夜曲（遗作） | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Nocturne in C sharp minor 'Lento con gran espressione', B. 49 (Op. posth.).mp3` |
| 小狗圆舞曲 Op.64 No.1 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Waltz in D flat major 'Minute', Op. 64 no. 1.mp3` |
| 升c小调圆舞曲 Op.64 No.2 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Waltz in C sharp minor, Op. 64 no. 2.mp3` |
| 雨滴前奏曲 Op.28 No.15 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Preludes, Op. 28 - No. 15 'Raindrop'.mp3` |
| e小调前奏曲 Op.28 No.4 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Preludes, Op. 28 - No. 4 'Suffocation'.mp3` |
| 离别练习曲 Op.10 No.3 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Etude Op. 10, no. 3 in E major - 'Tristesse'.mp3` |
| 幻想即兴曲 Op.66 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Fantaisie - Impromptu, Op. 66.mp3` |
| a小调玛祖卡 Op.67 No.4 | 肖邦（Musopen CC0） | `musopen-chopin-complete-works-flac` | https://creativecommons.org/publicdomain/zero/1.0/ | `Mazurka Op. 67 no. 4 in A minor.mp3` |

脚本每次下载前会重新拉一次 item 的 `licenseurl` 与允许清单比对，对不上整体中止——
写死在清单里的许可证会过期，而那种过期不会有任何征兆。

更新于 2026-09-02
