//! Table of games Linuxwolf knows by name.
//!
//! Unknown Proton games are still detected, they just have no friendly name
//! and no Overwolf game id yet.

pub struct KnownGame {
    pub steam_app_id: u32,
    pub name: &'static str,
    /// Overwolf's numeric game id (the `GameInfo.id / 10` value Overwolf apps
    /// see). `None` until confirmed from a real app manifest.
    pub overwolf_game_id: Option<u32>,
}

/// Steam app ids are taken from the Steam store URLs.
pub static KNOWN_GAMES: &[KnownGame] = &[KnownGame {
    // https://store.steampowered.com/app/4126040
    steam_app_id: 4126040,
    name: "Aniimo",
    overwolf_game_id: None,
}];

pub fn lookup(steam_app_id: u32) -> Option<&'static KnownGame> {
    KNOWN_GAMES.iter().find(|g| g.steam_app_id == steam_app_id)
}
