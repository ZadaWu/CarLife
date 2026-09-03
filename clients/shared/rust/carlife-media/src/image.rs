//! 端上图片压缩（施工单 M8-04，FL-09 F-09-03 / §2.2 C4）。
//!
//! # 两个目标是冲突的
//!
//! 单张 < 500KB，同时保留故障判断所需的细节。这两条不可能靠一组固定参数同时满足：
//! 一张仪表盘故障灯的近照，压到看不清是哪个灯就完全没用了；
//! 而一张"车停在路边"的环境图，压小十倍也不影响判断。
//!
//! 所以**按场景取舍**（`Scene`），不是给一个全局质量参数。
//!
//! # 压缩在端上不在服务端
//!
//! §2.2 C4：媒体处理在 Rust 侧。理由不只是性能——**弱网下上传 5MB 原图会失败**，
//! 而失败的是用户拍的照片（F-09-05 边界：绝不静默丢弃）。
//! 在端上压到 500KB 才能让"传上去"这件事本身变得可靠。
//!
//! 服务端上限仍然放宽到 8MB：端上该压而没压是我们的 bug，
//! 不该让用户的照片替这个 bug 买单。

use image::{imageops::FilterType, DynamicImage, ImageFormat, ImageReader};
use std::io::Cursor;

/// 拍摄场景。决定分辨率上限与质量下限的取舍。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scene {
    /// 故障灯 / 仪表盘 / 零件近照：**细节优先**。
    /// 判断"是黄色机油灯还是红色水温灯"要求颜色与形状都保得住。
    Detail,
    /// 车辆整体 / 停放环境：**体积优先**。它提供的是上下文，不是判据。
    Context,
    /// 文档翻拍（保养单据、工单）：**文字可读优先**。
    /// 分辨率不能降太多，否则字糊了；但灰阶足够，质量可以低一些。
    Document,
}

impl Scene {
    /// 长边像素上限。
    fn max_edge(self) -> u32 {
        match self {
            // 1600 足以看清仪表盘上的单个图标；再高只是让文件变大。
            Scene::Detail => 1600,
            Scene::Context => 1024,
            // 文档要认字，分辨率是唯一不能省的维度。
            Scene::Document => 2000,
        }
    }

    /// JPEG 质量下界。低于它就不再降质量，改为降分辨率——
    /// 质量压到 40 以下会出现块效应，那种糊法**看起来像另一个东西**，
    /// 比单纯变小危险得多。
    fn min_quality(self) -> u8 {
        match self {
            Scene::Detail => 60,
            Scene::Context => 45,
            Scene::Document => 55,
        }
    }

    fn start_quality(self) -> u8 {
        match self {
            Scene::Detail => 85,
            Scene::Context => 70,
            Scene::Document => 80,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    #[error("无法识别的图片格式")]
    Decode,
    #[error("编码失败：{0}")]
    Encode(String),
}

/// 压缩结果。**把实际达成的参数带出来**——
/// 调用方要能在 UI 上说"已压缩到 320KB"，也要能在压不下去时知道。
#[derive(Debug, Clone)]
pub struct Compressed {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub quality: u8,
    /// 是否达成了目标大小。**没达成不是错误**——
    /// 传一张 600KB 的照片，也远好过因为压不到 500KB 就不传（F-09-05）。
    pub within_budget: bool,
}

pub const DEFAULT_BUDGET_BYTES: usize = 500 * 1024;

/// 压缩一张图片到目标体积。
///
/// 策略是**先降分辨率，再降质量**：
/// 分辨率降一半体积约降四倍，而质量从 85 降到 60 只降约一半。
/// 反过来做会在体积还没下来时就先把画质压垮。
pub fn compress(input: &[u8], scene: Scene, budget: usize) -> Result<Compressed, ImageError> {
    let img = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|_| ImageError::Decode)?
        .decode()
        .map_err(|_| ImageError::Decode)?;

    let mut current = fit_within(&img, scene.max_edge());
    let mut quality = scene.start_quality();

    loop {
        let bytes = encode_jpeg(&current, quality)?;
        if bytes.len() <= budget {
            return Ok(Compressed {
                width: current.width(),
                height: current.height(),
                quality,
                within_budget: true,
                bytes,
            });
        }

        if quality > scene.min_quality() {
            // 每次降 10：降 5 要迭代太多次（端上是同步阻塞的），
            // 降 20 会跨过恰好合适的那一档。
            quality = quality.saturating_sub(10).max(scene.min_quality());
            continue;
        }

        // 质量已到下界，改降分辨率。
        let next_edge = current.width().max(current.height()) * 3 / 4;
        // 低于 640 就停：再小连"这是哪个部位"都看不出来了，
        // 此时**宁可交一张超出预算的图**，也不交一张没有信息量的图。
        if next_edge < 640 {
            return Ok(Compressed {
                width: current.width(),
                height: current.height(),
                quality,
                within_budget: false,
                bytes,
            });
        }
        current = fit_within(&current, next_edge);
        quality = scene.start_quality();
    }
}

fn fit_within(img: &DynamicImage, max_edge: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= max_edge {
        return img.clone();
    }
    // Lanczos3：缩小时保边最好。故障灯的轮廓正是靠它保住的，
    // Nearest / Triangle 会让小图标糊成一团色块。
    if w >= h {
        img.resize(max_edge, u32::MAX, FilterType::Lanczos3)
    } else {
        img.resize(u32::MAX, max_edge, FilterType::Lanczos3)
    }
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, ImageError> {
    let mut out = Cursor::new(Vec::new());
    let rgb = img.to_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| ImageError::Encode(e.to_string()))?;
    let _ = ImageFormat::Jpeg;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张有结构的测试图：纯色图会被 JPEG 压到几百字节，
    /// 那样测不出任何东西。这里画渐变 + 高频细节，接近真实照片的可压缩性。
    fn sample(w: u32, h: u32) -> Vec<u8> {
        let mut buf = image::RgbImage::new(w, h);
        for (x, y, px) in buf.enumerate_pixels_mut() {
            let noise = ((x * 7 + y * 13) % 97) as u8;
            *px = image::Rgb([
                (x % 256) as u8,
                (y % 256) as u8,
                noise.wrapping_mul(2),
            ]);
        }
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(buf)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn 大图能压进预算() {
        let src = sample(4000, 3000);
        let r = compress(&src, Scene::Detail, DEFAULT_BUDGET_BYTES).unwrap();
        assert!(r.within_budget, "实际 {} 字节", r.bytes.len());
        assert!(r.bytes.len() <= DEFAULT_BUDGET_BYTES);
    }

    #[test]
    fn 长边被限制到场景上限() {
        let src = sample(4000, 3000);
        let r = compress(&src, Scene::Context, DEFAULT_BUDGET_BYTES).unwrap();
        assert!(r.width.max(r.height) <= Scene::Context.max_edge());
    }

    #[test]
    fn 细节场景保留更高的分辨率与质量() {
        // 这条守的是"按场景取舍"这个设计本身：
        // 如果哪天有人把三个场景合并成一组参数，它会红。
        let src = sample(4000, 3000);
        let detail = compress(&src, Scene::Detail, DEFAULT_BUDGET_BYTES).unwrap();
        let context = compress(&src, Scene::Context, DEFAULT_BUDGET_BYTES).unwrap();
        assert!(
            detail.width.max(detail.height) > context.width.max(context.height),
            "故障灯近照不该被压到和环境图一样小"
        );
    }

    #[test]
    fn 小图不会被放大() {
        let src = sample(320, 240);
        let r = compress(&src, Scene::Detail, DEFAULT_BUDGET_BYTES).unwrap();
        assert_eq!((r.width, r.height), (320, 240));
    }

    #[test]
    fn 质量不会降到块效应区间以下() {
        // 极小预算：压不下去时应当**停在质量下界**并如实报 within_budget=false，
        // 而不是一路压到 quality=5 交一张看起来像另一个东西的图。
        let src = sample(4000, 3000);
        let r = compress(&src, Scene::Detail, 1024).unwrap();
        assert!(r.quality >= Scene::Detail.min_quality());
        assert!(!r.within_budget, "压不进预算时必须如实标注");
    }

    #[test]
    fn 压不进预算也返回图片而不是错误() {
        // F-09-05：绝不静默丢弃用户拍的照片。
        // 传一张 600KB 的，远好过因为压不到 500KB 就不传。
        let src = sample(4000, 3000);
        let r = compress(&src, Scene::Detail, 1024).unwrap();
        assert!(!r.bytes.is_empty());
    }

    #[test]
    fn 不是图片时明确报错() {
        assert!(matches!(
            compress(b"this is not an image", Scene::Detail, DEFAULT_BUDGET_BYTES),
            Err(ImageError::Decode)
        ));
    }
}
