//! Detect games that run under Steam Proton (or plain Wine) by scanning `/proc`.
//!
//! A Proton game shows up as a Linux process whose environment carries the
//! Steam app id (`SteamAppId`, `SteamGameId` or `STEAM_COMPAT_APP_ID`) and
//! whose command line names a Windows executable. Steam, Wine and Proton
//! helper processes share the same environment, so they are filtered out by
//! executable name.

pub mod games;

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// One detected game, grouped by Steam app id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DetectedGame {
    pub steam_app_id: Option<u32>,
    pub name: Option<String>,
    pub overwolf_game_id: Option<u32>,
    /// pid of the main game process (the one running the game's .exe).
    pub pid: u32,
    /// Windows executable file name, e.g. `Aniimo.exe`.
    pub exe: String,
    /// Full command line as Wine reports it.
    pub cmdline: Vec<String>,
    pub wine_prefix: Option<String>,
    pub runner: Runner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Runner {
    Proton,
    Wine,
}

/// Windows processes that Wine, Proton or Steam start next to every game.
const HELPER_EXES: &[&str] = &[
    "steam.exe",
    "steamwebhelper.exe",
    "steamerrorreporter.exe",
    "steamerrorreporter64.exe",
    "services.exe",
    "winedevice.exe",
    "plugplay.exe",
    "svchost.exe",
    "rpcss.exe",
    "explorer.exe",
    "tabtip.exe",
    "conhost.exe",
    "start.exe",
    "rundll32.exe",
    "wineboot.exe",
    "winemenubuilder.exe",
    "crashpad_handler.exe",
    "unitycrashhandler64.exe",
    "crashreportclient.exe",
    // Anti-cheat launchers/bootstrappers: report the game, not these.
    "start_protected_game.exe",
    "easyanticheat_eos_setup.exe",
];

/// Scan the given proc root (normally `/proc`) once.
pub fn scan(proc_root: &Path) -> Vec<DetectedGame> {
    let mut by_key: BTreeMap<String, DetectedGame> = BTreeMap::new();
    let Ok(entries) = fs::read_dir(proc_root) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Some(game) = inspect(&entry.path(), pid) else {
            continue;
        };
        // One entry per app id (or per exe for non-Steam Wine games); keep
        // the lowest pid, which is the process that was started first.
        let key = match game.steam_app_id {
            Some(id) => format!("steam:{id}"),
            None => format!("wine:{}", game.exe.to_lowercase()),
        };
        by_key
            .entry(key)
            .and_modify(|g| {
                if pid < g.pid {
                    *g = game.clone();
                }
            })
            .or_insert(game);
    }
    by_key.into_values().collect()
}

fn inspect(dir: &Path, pid: u32) -> Option<DetectedGame> {
    let cmdline = split_nul(&fs::read(dir.join("cmdline")).ok()?);
    let exe_arg = cmdline.first()?;
    let exe = windows_exe_name(exe_arg)?;
    if HELPER_EXES.contains(&exe.to_lowercase().as_str()) {
        return None;
    }

    let env = parse_environ(&fs::read(dir.join("environ")).unwrap_or_default());
    let steam_app_id = ["SteamAppId", "SteamGameId", "STEAM_COMPAT_APP_ID"]
        .iter()
        .filter_map(|k| env.get(*k))
        .find_map(|v| v.parse::<u32>().ok().filter(|id| *id != 0));
    let is_proton = env.contains_key("STEAM_COMPAT_DATA_PATH") || steam_app_id.is_some();
    let is_wine = is_proton || env.contains_key("WINEPREFIX") || runs_wine_binary(dir);
    if !is_wine {
        return None;
    }

    let known = steam_app_id.and_then(games::lookup);
    let wine_prefix = env.get("WINEPREFIX").cloned().or_else(|| {
        env.get("STEAM_COMPAT_DATA_PATH")
            .map(|p| format!("{}/pfx", p.trim_end_matches('/')))
    });
    Some(DetectedGame {
        steam_app_id,
        name: known.map(|g| g.name.to_string()),
        overwolf_game_id: known.and_then(|g| g.overwolf_game_id),
        pid,
        exe,
        cmdline,
        wine_prefix,
        runner: if is_proton { Runner::Proton } else { Runner::Wine },
    })
}

/// `Z:\games\Foo\Foo.exe` or `C:/x/Foo.EXE` -> `Foo.exe`.
fn windows_exe_name(arg: &str) -> Option<String> {
    let name = arg.rsplit(['\\', '/']).next()?;
    name.to_lowercase().ends_with(".exe").then(|| name.to_string())
}

fn runs_wine_binary(dir: &Path) -> bool {
    fs::read_link(dir.join("exe"))
        .ok()
        .and_then(|p: PathBuf| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .is_some_and(|n| n.starts_with("wine") && n.contains("preloader"))
}

fn split_nul(raw: &[u8]) -> Vec<String> {
    raw.split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

fn parse_environ(raw: &[u8]) -> BTreeMap<String, String> {
    split_nul(raw)
        .into_iter()
        .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fake_proc(root: &Path, pid: u32, cmdline: &[&str], env: &[(&str, &str)]) {
        let dir = root.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        let join = |parts: Vec<String>| {
            let mut out = Vec::new();
            for p in parts {
                out.extend_from_slice(p.as_bytes());
                out.push(0);
            }
            out
        };
        fs::write(dir.join("cmdline"), join(cmdline.iter().map(|s| s.to_string()).collect())).unwrap();
        fs::write(dir.join("environ"), join(env.iter().map(|(k, v)| format!("{k}={v}")).collect())).unwrap();
    }

    const PROTON_ENV: &[(&str, &str)] = &[
        ("SteamAppId", "4126040"),
        ("STEAM_COMPAT_DATA_PATH", "/home/nick/.steam/steam/steamapps/compatdata/4126040"),
    ];

    #[test]
    fn detects_aniimo_under_proton_and_ignores_helpers() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fake_proc(root, 100, &["C:\\windows\\system32\\steam.exe", "x"], PROTON_ENV);
        fake_proc(root, 101, &["C:\\windows\\system32\\services.exe"], PROTON_ENV);
        fake_proc(root, 105, &["Z:\\games\\Aniimo\\Aniimo.exe", "-dx12"], PROTON_ENV);
        fake_proc(root, 107, &["Z:\\games\\Aniimo\\Aniimo\\Binaries\\Win64\\Aniimo-Win64-Shipping.exe"], PROTON_ENV);
        // A plain Linux process with Steam env must not count.
        fake_proc(root, 200, &["/usr/bin/bash"], PROTON_ENV);
        fs::create_dir_all(root.join("self")).unwrap();

        let games = scan(root);
        assert_eq!(games.len(), 1, "{games:#?}");
        let g = &games[0];
        assert_eq!(g.steam_app_id, Some(4126040));
        assert_eq!(g.name.as_deref(), Some("Aniimo"));
        assert_eq!(g.pid, 105);
        assert_eq!(g.exe, "Aniimo.exe");
        assert_eq!(g.runner, Runner::Proton);
        assert_eq!(
            g.wine_prefix.as_deref(),
            Some("/home/nick/.steam/steam/steamapps/compatdata/4126040/pfx")
        );
    }

    #[test]
    fn detects_unknown_wine_game_without_steam() {
        let tmp = tempfile::tempdir().unwrap();
        fake_proc(tmp.path(), 300, &["C:/Games/Foo/foo.EXE"], &[("WINEPREFIX", "/home/nick/.wine")]);
        let games = scan(tmp.path());
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].steam_app_id, None);
        assert_eq!(games[0].runner, Runner::Wine);
        assert_eq!(games[0].exe, "foo.EXE");
    }

    #[test]
    fn exe_name_parsing() {
        assert_eq!(windows_exe_name("Z:\\a\\B.exe").as_deref(), Some("B.exe"));
        assert_eq!(windows_exe_name("/usr/bin/steam"), None);
    }
}
