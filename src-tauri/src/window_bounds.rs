//! The main window's place and size across restarts (VS Code's `window.restoreWindows`): its
//! last normal (not maximized) bounds and whether it was maximized, kept in
//! `<appData>/window.json` — the last window's, and each folder's (D229), so a session's
//! windows reopen each where it was. They are followed while the window moves and resizes,
//! written a moment later and when it closes (a shutdown that closes every window at once keeps
//! them too); the next start opens there, unless the screen it was on is gone. A "New window"
//! and test runs open at the default size; a window the last session's restore starts takes its
//! folder's.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Runtime, WebviewWindow, WebviewWindowBuilder};

/// Logical pixels (the same on every monitor scale).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// A screen's area in logical pixels.
#[derive(Debug, Clone, Copy)]
pub struct Screen {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Smallest size kept (the window's own minimum is 640×400).
const MIN_WIDTH: f64 = 640.0;
const MIN_HEIGHT: f64 = 400.0;
/// How much of the window's top edge must be on a screen to be reachable (to drag it back).
const GRAB_WIDTH: f64 = 120.0;
const GRAB_HEIGHT: f64 = 32.0;

/// Where to open: `saved` when its top edge is on one of `screens` (its size shrunk to fit that
/// screen), else None (the default place). A damaged size is dropped too.
pub fn placement(saved: Bounds, screens: &[Screen]) -> Option<Bounds> {
    let finite = [saved.x, saved.y, saved.width, saved.height]
        .iter()
        .all(|v| v.is_finite());
    if !finite || saved.width < MIN_WIDTH / 2.0 || saved.height < MIN_HEIGHT / 2.0 {
        return None;
    }
    let screen = screens.iter().find(|s| {
        let left = saved.x.max(s.x);
        let right = (saved.x + saved.width).min(s.x + s.width);
        let top_on = saved.y >= s.y && saved.y + GRAB_HEIGHT <= s.y + s.height;
        top_on && right - left >= GRAB_WIDTH.min(saved.width)
    })?;
    Some(Bounds {
        width: saved.width.clamp(MIN_WIDTH.min(screen.width), screen.width),
        height: saved
            .height
            .clamp(MIN_HEIGHT.min(screen.height), screen.height),
        ..saved
    })
}

/// Folders remembered (the most recently closed first).
const MAX_FOLDERS: usize = 50;
/// Moves and resizes are written this long after the last write at most.
const SAVE_EVERY: Duration = Duration::from_secs(2);

/// What `window.json` holds: the last window's bounds and each folder's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    #[serde(default)]
    pub last: Option<Bounds>,
    /// (folder, bounds), most recent first.
    #[serde(default)]
    pub folders: Vec<(String, Bounds)>,
}

impl Saved {
    /// The file as written: this format, or a single window's bounds (before D229).
    pub fn parse(text: &str) -> Saved {
        if let Ok(saved) = serde_json::from_str::<Saved>(text) {
            if saved.last.is_some() || !saved.folders.is_empty() {
                return saved;
            }
        }
        Saved {
            last: serde_json::from_str::<Bounds>(text).ok(),
            folders: Vec::new(),
        }
    }

    /// The folder's bounds when known, else the last window's.
    pub fn for_folder(&self, folder: Option<&str>) -> Option<Bounds> {
        folder
            .and_then(|f| {
                self.folders
                    .iter()
                    .find(|(k, _)| same_folder(k, f))
                    .map(|(_, b)| *b)
            })
            .or(self.last)
    }

    /// Notes `bounds` as the last window's and, with a folder, that folder's.
    pub fn record(&mut self, bounds: Bounds, folder: Option<&str>) {
        self.last = Some(bounds);
        if let Some(f) = folder {
            self.folders.retain(|(k, _)| !same_folder(k, f));
            self.folders.insert(0, (f.to_string(), bounds));
            self.folders.truncate(MAX_FOLDERS);
        }
    }
}

/// Windows paths ignore case and the slash's direction.
fn same_folder(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let t = s.trim_end_matches(['\\', '/']).replace('\\', "/");
        if cfg!(windows) {
            t.to_lowercase()
        } else {
            t
        }
    };
    norm(a) == norm(b)
}

fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("window.json")
}

pub fn load(data_dir: &Path) -> Saved {
    std::fs::read_to_string(file(data_dir))
        .map(|t| Saved::parse(&t))
        .unwrap_or_default()
}

/// The bounds being followed, written when the main window closes.
#[derive(Default)]
pub struct Tracker {
    last: Mutex<Option<Bounds>>,
    dir: Mutex<Option<PathBuf>>,
    /// When the bounds were last written.
    written: Mutex<Option<Instant>>,
}

impl Tracker {
    pub fn set_dir(&self, data_dir: &Path) {
        if let Ok(mut dir) = self.dir.lock() {
            *dir = Some(data_dir.to_path_buf());
        }
    }

    /// Notes the window's bounds after a move or resize: the normal bounds while it's neither
    /// maximized nor minimized, only the flag otherwise (so un-maximizing next time restores
    /// the size it had).
    pub fn follow<R: Runtime>(&self, window: &tauri::Window<R>) {
        let maximized = window.is_maximized().unwrap_or(false);
        if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
            return;
        }
        let Ok(mut last) = self.last.lock() else {
            return;
        };
        if maximized {
            if let Some(b) = last.as_mut() {
                b.maximized = true;
            }
            return;
        }
        let (Ok(scale), Ok(pos), Ok(size)) = (
            window.scale_factor(),
            window.outer_position(),
            window.inner_size(),
        ) else {
            return;
        };
        let pos = pos.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        *last = Some(Bounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized: false,
        });
    }

    /// Writes what was followed (the main window is closing), as the last window's and the
    /// folder's. The file is read first: other windows write it too.
    pub fn save(&self, folder: Option<&str>) {
        let last = self.last.lock().ok().and_then(|l| *l);
        let dir = self.dir.lock().ok().and_then(|d| d.clone());
        if let (Some(bounds), Some(dir)) = (last, dir) {
            let mut saved = load(&dir);
            saved.record(bounds, folder);
            if let Ok(json) = serde_json::to_string(&saved) {
                let _ = crate::store::atomic_write(&file(&dir), json.as_bytes());
            }
            if let Ok(mut w) = self.written.lock() {
                *w = Some(Instant::now());
            }
        }
    }

    /// Writes after a move or resize when the last write is a while ago, so a window that's
    /// never closed normally (the OS shutting down) still keeps where it was.
    pub fn save_soon(&self, folder: Option<&str>) {
        let due = self
            .written
            .lock()
            .map(|w| w.is_none_or(|t| t.elapsed() >= SAVE_EVERY))
            .unwrap_or(false);
        if due {
            self.save(folder);
        }
    }

    /// Starts from the saved bounds (so a window closed without moving keeps them).
    fn seed(&self, bounds: Bounds) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(bounds);
        }
    }
}

/// The screens of this machine, in logical pixels.
fn screens<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<Screen> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            Screen {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect()
}

/// Puts the main window where it was (before it's built, so it doesn't jump); returns whether it
/// should be maximized once built.
pub fn restore<'a, R: Runtime, M: tauri::Manager<R>>(
    app: &tauri::AppHandle<R>,
    tracker: &Tracker,
    data_dir: &Path,
    folder: Option<&str>,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> (WebviewWindowBuilder<'a, R, M>, bool) {
    tracker.set_dir(data_dir);
    let Some(saved) = load(data_dir).for_folder(folder) else {
        return (builder, false);
    };
    let Some(place) = placement(saved, &screens(app)) else {
        return (builder, false);
    };
    tracker.seed(place);
    (
        builder
            .position(place.x, place.y)
            .inner_size(place.width, place.height),
        place.maximized,
    )
}

/// Maximizes the window after it's built when it was maximized.
pub fn finish<R: Runtime>(window: &WebviewWindow<R>, maximized: bool) {
    if maximized {
        let _ = window.maximize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Screen = Screen {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    fn at(x: f64, y: f64, width: f64, height: f64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    #[test]
    fn each_folder_keeps_its_own_bounds_and_the_old_file_still_reads() {
        let old = serde_json::to_string(&at(10.0, 20.0, 800.0, 600.0)).unwrap();
        let mut saved = Saved::parse(&old);
        assert_eq!(
            saved.for_folder(Some("C:\\a")),
            Some(at(10.0, 20.0, 800.0, 600.0))
        );
        saved.record(at(1.0, 2.0, 900.0, 700.0), Some("C:\\a"));
        saved.record(at(5.0, 6.0, 1000.0, 800.0), Some("C:\\b"));
        assert_eq!(
            saved.for_folder(Some("C:\\a\\")),
            Some(at(1.0, 2.0, 900.0, 700.0))
        );
        assert_eq!(
            saved.for_folder(Some("C:\\new")),
            Some(at(5.0, 6.0, 1000.0, 800.0))
        );
        assert_eq!(saved.for_folder(None), Some(at(5.0, 6.0, 1000.0, 800.0)));
        let reread = Saved::parse(&serde_json::to_string(&saved).unwrap());
        assert_eq!(reread, saved);
        assert_eq!(Saved::parse("not json"), Saved::default());
    }

    #[test]
    fn a_window_on_a_screen_opens_where_it_was() {
        let b = at(100.0, 80.0, 1200.0, 800.0);
        assert_eq!(placement(b, &[SCREEN]), Some(b));
    }

    #[test]
    fn a_window_whose_screen_is_gone_opens_at_the_default_place() {
        // It was on a second screen to the right, now unplugged.
        assert_eq!(placement(at(2000.0, 100.0, 1200.0, 800.0), &[SCREEN]), None);
        // Its title bar above the top edge: it couldn't be dragged back.
        assert_eq!(placement(at(100.0, -200.0, 1200.0, 800.0), &[SCREEN]), None);
        assert_eq!(placement(at(100.0, 100.0, 1200.0, 800.0), &[]), None);
    }

    #[test]
    fn a_window_larger_than_its_screen_is_shrunk_and_damage_is_dropped() {
        let b = placement(at(0.0, 0.0, 4000.0, 3000.0), &[SCREEN]);
        assert_eq!(b.map(|b| (b.width, b.height)), Some((1920.0, 1080.0)));
        assert_eq!(placement(at(f64::NAN, 0.0, 1200.0, 800.0), &[SCREEN]), None);
        assert_eq!(placement(at(0.0, 0.0, 10.0, 10.0), &[SCREEN]), None);
        // A second screen at a negative offset (left of the main one) counts.
        let left = Screen {
            x: -1280.0,
            y: 0.0,
            width: 1280.0,
            height: 1024.0,
        };
        let b = at(-1200.0, 50.0, 1000.0, 700.0);
        assert_eq!(placement(b, &[SCREEN, left]), Some(b));
    }
}
