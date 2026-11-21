//! Frame export for Linuxwolf apps: on request, the layer copies one
//! presented frame to `/dev/shm/linuxwolf-capture/<exe>.frame`.
//!
//! Classic Overwolf apps take screenshots of the game (WoW Forever Map reads
//! its addon's on-screen position with OCR). On KDE Wayland a game that runs
//! as a native Wayland window (Proton with its Wayland driver) cannot be
//! captured by X11 tools, and the screencast portal asks the user every
//! time. The layer already sits in the game's present path, so it hands out
//! frames itself.
//!
//! Protocol (files in `/dev/shm/linuxwolf-capture/`, shared with the game's
//! container because `/dev/shm` is):
//! - `<exe>.layer`  written by the layer when a swapchain it can capture is
//!   created: "width height\n". `<exe>` is the lowercase file name of the
//!   game's Windows exe (`wow.exe`), from `/proc/self/cmdline`, so both
//!   sides agree without sharing a pid namespace.
//! - `<exe>.req`    touched by the app to ask for a frame.
//! - `<exe>.frame`  written by the layer (atomically, via rename) on the next
//!   present after a newer request: 24-byte header (`LWFRAME1`, u32 width,
//!   u32 height, u32 pixel order 0 = BGRA / 1 = RGBA, u32 0) + tightly packed
//!   rows.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

const DIR: &str = "/dev/shm/linuxwolf-capture";
const CHECK_EVERY: Duration = Duration::from_millis(100);

pub struct Requests {
    key: Option<String>,
    last_check: Option<Instant>,
    last_served: SystemTime,
}

fn exe_key() -> Option<String> {
    let cmdline = fs::read("/proc/self/cmdline").ok()?;
    let first = cmdline.split(|b| *b == 0).next()?;
    let s = String::from_utf8_lossy(first);
    let name = s.rsplit(['\\', '/']).next()?.trim().to_lowercase();
    if name.is_empty() || name.contains("..") {
        return None;
    }
    Some(name)
}

impl Requests {
    pub fn new() -> Self {
        if std::env::var("LINUXWOLF_CAPTURE").as_deref() == Ok("0") {
            return Requests { key: None, last_check: None, last_served: SystemTime::UNIX_EPOCH };
        }
        Requests { key: exe_key(), last_check: None, last_served: SystemTime::now() }
    }

    fn path(&self, ext: &str) -> Option<PathBuf> {
        self.key.as_ref().map(|k| PathBuf::from(DIR).join(format!("{k}.{ext}")))
    }

    /// Tell apps this game can hand out frames.
    pub fn announce(&self, width: u32, height: u32) {
        let Some(p) = self.path("layer") else { return };
        let _ = fs::create_dir_all(DIR);
        let _ = fs::write(p, format!("{width} {height}\n"));
    }

    /// True when an app asked for a frame since the last one served. Checks
    /// the file system at most every 100 ms.
    pub fn pending(&mut self) -> bool {
        if self.key.is_none() {
            return false;
        }
        let now = Instant::now();
        if self.last_check.is_some_and(|t| now.duration_since(t) < CHECK_EVERY) {
            return false;
        }
        self.last_check = Some(now);
        let Some(req) = self.path("req") else { return false };
        match fs::metadata(req).and_then(|m| m.modified()) {
            Ok(t) => t > self.last_served,
            Err(_) => false,
        }
    }

    /// Write one frame (rows of `width * 4` bytes) and mark the request served.
    pub fn serve(&mut self, width: u32, height: u32, rgba: bool, pixels: &[u8]) {
        self.last_served = SystemTime::now();
        let Some(dst) = self.path("frame") else { return };
        let tmp = dst.with_extension("frame.tmp");
        let res = (|| -> std::io::Result<()> {
            fs::create_dir_all(DIR)?;
            let mut f = fs::File::create(&tmp)?;
            let mut header = Vec::with_capacity(24);
            header.extend_from_slice(b"LWFRAME1");
            for v in [width, height, rgba as u32, 0] {
                header.extend_from_slice(&v.to_le_bytes());
            }
            f.write_all(&header)?;
            f.write_all(pixels)?;
            drop(f);
            fs::rename(&tmp, &dst)
        })();
        if let Err(e) = res {
            crate::log(&format!("capture: writing {} failed: {e}", dst.display()));
        }
    }
}
