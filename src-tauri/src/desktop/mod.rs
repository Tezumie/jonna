//! Desktop control for the agent's `computer` tool (D353): screenshots of the whole desktop or a
//! monitor, the app under a point or in front (process name and window title, for the per-app
//! permission), synthesized mouse and keyboard input, and the always-on-top "Controlling your
//! computer" banner with Stop (Esc anywhere stops too). Windows only for now: GDI capture
//! (StretchBlt with HALFTONE scaling, so the webview gets the image at the model's size), SendInput
//! and a small native window. Other systems report `supported() == false` and every call fails;
//! the TS side then doesn't offer the tool at all.
//!
//! Policy (which apps, tiers, what the user allowed) lives in TypeScript
//! (`src/core/agent/computerUse.ts`); this module only does what it's told, in physical pixels of
//! the virtual desktop.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
mod banner;
#[cfg(windows)]
mod win;

/// A monitor in physical pixels of the virtual desktop.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

/// The top-level window at a point (or in front): which app it belongs to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// The executable's file name ("notepad.exe"); empty when the process can't be opened.
    pub process: String,
    pub title: String,
    pub pid: u32,
    /// One of the IDE's own windows.
    pub is_self: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// One input action, in physical pixels of the virtual desktop. Keys are Windows virtual-key
/// codes (the TS side maps names to them).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
// Desktop control acts on Windows only (D353); elsewhere the actions are read and refused.
#[cfg_attr(not(windows), allow(dead_code))]
pub enum InputOp {
    Move {
        x: i32,
        y: i32,
    },
    Click {
        x: i32,
        y: i32,
        button: Button,
        count: u32,
        /// Keys held during the click (modifiers).
        #[serde(default)]
        hold: Vec<u16>,
    },
    Drag {
        from_x: i32,
        from_y: i32,
        x: i32,
        y: i32,
    },
    Scroll {
        x: i32,
        y: i32,
        /// Wheel ticks: positive is right / down.
        dx: i32,
        dy: i32,
    },
    Type {
        text: String,
    },
    /// A chord: every key pressed in order, released in reverse, `repeat` times.
    Key {
        keys: Vec<u16>,
        repeat: u32,
    },
}

/// Set by Esc (while watching) or the banner's Stop; read and cleared by `take_stop`.
static STOP: AtomicBool = AtomicBool::new(false);
/// While the IDE itself is pressing keys: its own Escape isn't the user's.
static INJECTING: AtomicBool = AtomicBool::new(false);

pub fn supported() -> bool {
    cfg!(windows)
}

/// Whether the user asked to stop since the last call (Esc or the banner's Stop).
pub fn take_stop() -> bool {
    STOP.swap(false, Ordering::SeqCst)
}

#[cfg(windows)]
pub use self::platform::*;

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::error::{Error, Result};

    pub fn monitors() -> Result<Vec<Monitor>> {
        Ok(win::monitors())
    }

    /// The virtual desktop's rectangle (all monitors): x, y, width, height.
    pub fn desktop() -> (i32, i32, i32, i32) {
        win::virtual_screen()
    }

    /// `w`×`h` physical pixels at `x`,`y`, scaled to `out_w`×`out_h`: an 8-byte header (width,
    /// height as little-endian u32) then BGRA rows, top-down.
    pub fn capture(x: i32, y: i32, w: i32, h: i32, out_w: i32, out_h: i32) -> Result<Vec<u8>> {
        if w <= 0 || h <= 0 || out_w <= 0 || out_h <= 0 || out_w > 8192 || out_h > 8192 {
            return Err(Error::Invalid("capture: an empty or too large area".into()));
        }
        win::capture(x, y, w, h, out_w, out_h).map_err(Error::Invalid)
    }

    pub fn window_at(point: Option<(i32, i32)>) -> Result<Option<WindowInfo>> {
        Ok(win::window_at(point))
    }

    pub fn input(op: &InputOp) -> Result<()> {
        let keys = matches!(op, InputOp::Type { .. } | InputOp::Key { .. });
        if keys {
            INJECTING.store(true, Ordering::SeqCst);
        }
        let result = win::input(op).map_err(Error::Invalid);
        if keys {
            // Let the key-state poll see our own Escape go up before it watches again.
            std::thread::sleep(std::time::Duration::from_millis(60));
            INJECTING.store(false, Ordering::SeqCst);
        }
        result
    }

    /// Shows (with `text`) or hides the banner; Esc is watched while it's shown.
    pub fn banner(text: Option<&str>) {
        match text {
            Some(text) => {
                STOP.store(false, Ordering::SeqCst);
                banner::show(text);
            }
            None => banner::hide(),
        }
    }
}

#[cfg(not(windows))]
pub use self::unsupported::*;

#[cfg(not(windows))]
mod unsupported {
    use super::*;
    use crate::error::{Error, Result};

    fn not_here<T>() -> Result<T> {
        Err(Error::Invalid(
            "controlling the desktop is only implemented on Windows".into(),
        ))
    }

    pub fn monitors() -> Result<Vec<Monitor>> {
        not_here()
    }

    pub fn desktop() -> (i32, i32, i32, i32) {
        (0, 0, 0, 0)
    }

    pub fn capture(_x: i32, _y: i32, _w: i32, _h: i32, _ow: i32, _oh: i32) -> Result<Vec<u8>> {
        not_here()
    }

    pub fn window_at(_point: Option<(i32, i32)>) -> Result<Option<WindowInfo>> {
        not_here()
    }

    pub fn input(_op: &InputOp) -> Result<()> {
        not_here()
    }

    pub fn banner(_text: Option<&str>) {
        let _ = (&STOP, &INJECTING);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_ops_parse_from_camel_case() {
        let op: InputOp = serde_json::from_str(
            r#"{"op":"click","x":10,"y":20,"button":"right","count":2,"hold":[17]}"#,
        )
        .unwrap_or(InputOp::Move { x: 0, y: 0 });
        match op {
            InputOp::Click {
                x,
                y,
                button,
                count,
                hold,
            } => {
                assert_eq!((x, y, count), (10, 20, 2));
                assert_eq!(button, Button::Right);
                assert_eq!(hold, vec![17]);
            }
            other => panic!("parsed as {other:?}"),
        }
        let drag: InputOp =
            serde_json::from_str(r#"{"op":"drag","fromX":1,"fromY":2,"x":3,"y":4}"#)
                .unwrap_or(InputOp::Move { x: 0, y: 0 });
        assert!(matches!(
            drag,
            InputOp::Drag {
                from_x: 1,
                from_y: 2,
                x: 3,
                y: 4
            }
        ));
    }

    #[test]
    fn stop_is_taken_once() {
        STOP.store(true, Ordering::SeqCst);
        assert!(take_stop());
        assert!(!take_stop());
    }
}
