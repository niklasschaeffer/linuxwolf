//! Software-rendered test HUD. In step 2 this is replaced by frames coming
//! from the Overwolf app renderer (CEF offscreen), the copy path stays the same.

use crate::font::{GLYPHS, GLYPH_H, GLYPH_W};

pub const HUD_W: u32 = 320;
pub const HUD_H: u32 = 72;
pub const HUD_X: i32 = 16;
pub const HUD_Y: i32 = 16;

pub const BG: [u8; 3] = [0x12, 0x16, 0x20];
pub const ACCENT: [u8; 3] = [0x4c, 0xc9, 0xf0];
pub const TEXT: [u8; 3] = [0xf2, 0xf4, 0xf8];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PixelOrder {
    Bgra,
    Rgba,
}

pub struct Frame<'a> {
    pub lines: [&'a str; 3],
    /// 0..=1, position of the "alive" marker that moves every frame.
    pub phase: f32,
}

/// Render the HUD into `buf` (HUD_W * HUD_H * 4 bytes, tightly packed).
pub fn render(buf: &mut [u8], order: PixelOrder, frame: &Frame) {
    let w = HUD_W as usize;
    let h = HUD_H as usize;
    let mut put = |x: usize, y: usize, c: [u8; 3]| {
        let i = (y * w + x) * 4;
        let px = match order {
            PixelOrder::Bgra => [c[2], c[1], c[0], 0xff],
            PixelOrder::Rgba => [c[0], c[1], c[2], 0xff],
        };
        buf[i..i + 4].copy_from_slice(&px);
    };
    for y in 0..h {
        for x in 0..w {
            let border = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
            put(x, y, if border { ACCENT } else { BG });
        }
    }
    // Moving marker along the bottom edge proves the overlay updates per frame.
    let mx = 4 + ((w - 24) as f32 * frame.phase.clamp(0.0, 1.0)) as usize;
    for y in h - 8..h - 4 {
        for x in mx..mx + 16 {
            put(x, y, ACCENT);
        }
    }
    for (row, line) in frame.lines.iter().enumerate() {
        let oy = 6 + row * (GLYPH_H + 2);
        for (col, ch) in line.chars().enumerate() {
            let ox = 8 + col * GLYPH_W;
            if ox + GLYPH_W >= w - 2 {
                break;
            }
            let code = ch as usize;
            if !(32..127).contains(&code) {
                continue;
            }
            let glyph = &GLYPHS[code - 32];
            for (gy, bits) in glyph.iter().enumerate() {
                for gx in 0..GLYPH_W {
                    if bits & (0x80 >> gx) != 0 && oy + gy < h - 10 {
                        put(ox + gx, oy + gy, if row == 0 { ACCENT } else { TEXT });
                    }
                }
            }
        }
    }
}
