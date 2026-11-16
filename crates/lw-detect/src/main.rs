//! `lw-detect`: print the games currently running under Proton/Wine.
//!
//! ```text
//! lw-detect            # one scan, human readable
//! lw-detect --json     # one scan, JSON array
//! lw-detect --watch    # print started/stopped events as JSON lines
//! ```

use lw_detect::{scan, DetectedGame};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let proc_root = Path::new("/proc");
    if args.iter().any(|a| a == "--watch") {
        watch(proc_root);
    } else if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string_pretty(&scan(proc_root)).unwrap());
    } else {
        let games = scan(proc_root);
        if games.is_empty() {
            println!("No Proton/Wine game running.");
        }
        for g in games {
            println!(
                "{:<20} pid {:<7} app {:<9} {:?}  {}",
                g.name.clone().unwrap_or_else(|| "(unknown)".into()),
                g.pid,
                g.steam_app_id.map(|i| i.to_string()).unwrap_or_else(|| "-".into()),
                g.runner,
                g.exe
            );
        }
    }
}

fn watch(proc_root: &Path) {
    let key = |g: &DetectedGame| (g.steam_app_id, g.pid);
    let mut running: BTreeMap<(Option<u32>, u32), DetectedGame> = BTreeMap::new();
    loop {
        let now: BTreeMap<_, _> = scan(proc_root).into_iter().map(|g| (key(&g), g)).collect();
        for (k, g) in &now {
            if !running.contains_key(k) {
                println!("{}", serde_json::json!({"event": "game_started", "game": g}));
            }
        }
        for (k, g) in &running {
            if !now.contains_key(k) {
                println!("{}", serde_json::json!({"event": "game_stopped", "game": g}));
            }
        }
        running = now;
        std::thread::sleep(Duration::from_secs(2));
    }
}
