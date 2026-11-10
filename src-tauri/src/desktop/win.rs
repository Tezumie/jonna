//! The Windows side of desktop control: GDI capture, the window under a point, SendInput.
//! Coordinates are physical pixels (the process is per-monitor DPI aware).

use super::{Button, InputOp, Monitor, WindowInfo};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC,
    GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode,
    StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HDC,
    HMONITOR, MONITORINFO, ROP_CODE, SRCCOPY,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    VK_RETURN, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetForegroundWindow, GetSystemMetrics, GetWindowTextW, GetWindowThreadProcessId,
    WindowFromPoint, GA_ROOT, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

const MONITORINFOF_PRIMARY: u32 = 1;
const WHEEL_DELTA: i32 = 120;

pub fn virtual_screen() -> (i32, i32, i32, i32) {
    // SAFETY: plain metric queries.
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

unsafe extern "system" fn monitor_proc(
    monitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    // SAFETY: `data` is the &mut Vec passed by `monitors` for the duration of the enumeration.
    let list = unsafe { &mut *(data.0 as *mut Vec<Monitor>) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a valid MONITORINFO with its size set.
    if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        let r = info.rcMonitor;
        list.push(Monitor {
            index: list.len() as u32,
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
            primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    true.into()
}

pub fn monitors() -> Vec<Monitor> {
    let mut list: Vec<Monitor> = Vec::new();
    // SAFETY: the callback only runs during this call, while `list` is alive.
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_proc),
            LPARAM(&mut list as *mut Vec<Monitor> as isize),
        );
    }
    // The primary monitor first: it's monitor 0 for the agent.
    list.sort_by_key(|m| !m.primary);
    for (i, m) in list.iter_mut().enumerate() {
        m.index = i as u32;
    }
    list
}

pub fn capture(x: i32, y: i32, w: i32, h: i32, out_w: i32, out_h: i32) -> Result<Vec<u8>, String> {
    // SAFETY: GDI objects are created, used and released here; every handle is freed on all
    // paths below before returning.
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("couldn't read the screen".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, out_w, out_h);
        let old = SelectObject(mem, bitmap.into());
        SetStretchBltMode(mem, HALFTONE);
        let _ = SetBrushOrgEx(mem, 0, 0, None);
        let copied = StretchBlt(
            mem,
            0,
            0,
            out_w,
            out_h,
            Some(screen),
            x,
            y,
            w,
            h,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
        )
        .as_bool();
        SelectObject(mem, old);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: out_w,
                // Negative: top-down rows.
                biHeight: -out_h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut out = vec![0u8; 8 + (out_w as usize) * (out_h as usize) * 4];
        out[0..4].copy_from_slice(&(out_w as u32).to_le_bytes());
        out[4..8].copy_from_slice(&(out_h as u32).to_le_bytes());
        let lines = if copied {
            GetDIBits(
                mem,
                bitmap,
                0,
                out_h as u32,
                Some(out[8..].as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if lines == 0 {
            return Err("couldn't capture the screen".into());
        }
        Ok(out)
    }
}

fn process_name(pid: u32) -> String {
    // SAFETY: the handle is closed before returning; the buffer outlives the call.
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/'])
            .next()
            .unwrap_or_default()
            .to_string()
    }
}

fn info_of(hwnd: HWND) -> Option<WindowInfo> {
    if hwnd.is_invalid() {
        return None;
    }
    // SAFETY: window queries on a handle the system gave us; a stale handle just yields 0s.
    unsafe {
        let root = GetAncestor(hwnd, GA_ROOT);
        let root = if root.is_invalid() { hwnd } else { root };
        let mut pid = 0u32;
        GetWindowThreadProcessId(root, Some(&mut pid));
        let mut title = vec![0u16; 512];
        let n = GetWindowTextW(root, &mut title).max(0) as usize;
        Some(WindowInfo {
            process: process_name(pid),
            title: String::from_utf16_lossy(&title[..n]),
            pid,
            is_self: pid == GetCurrentProcessId(),
        })
    }
}

pub fn window_at(point: Option<(i32, i32)>) -> Option<WindowInfo> {
    // SAFETY: plain window queries.
    let hwnd = unsafe {
        match point {
            Some((x, y)) => WindowFromPoint(POINT { x, y }),
            None => GetForegroundWindow(),
        }
    };
    info_of(hwnd)
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Keys that need the extended flag (arrows, the navigation block, right-hand modifiers…).
fn extended(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5
    )
}

fn key_down(vk: u16) -> INPUT {
    let flags = if extended(vk) {
        KEYEVENTF_EXTENDEDKEY
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    key(vk, 0, flags)
}

fn key_up(vk: u16) -> INPUT {
    let flags = if extended(vk) {
        KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP
    } else {
        KEYEVENTF_KEYUP
    };
    key(vk, 0, flags)
}

/// An absolute move to a point of the virtual desktop (SendInput's 0–65535 scale).
fn move_to(x: i32, y: i32) -> INPUT {
    let (vx, vy, vw, vh) = virtual_screen();
    // In i64 before subtracting: a point far off the desktop overflowed i32.
    let nx = ((i64::from(x) - i64::from(vx)) * 65535 / i64::from(vw.max(2) - 1)) as i32;
    let ny = ((i64::from(y) - i64::from(vy)) * 65535 / i64::from(vh.max(2) - 1)) as i32;
    mouse(
        nx,
        ny,
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    )
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    // SAFETY: a slice of fully initialized INPUT structs.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(
            "the system blocked the input (an app running as administrator is in front, or the screen is locked)"
                .into(),
        );
    }
    Ok(())
}

fn pause(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

pub fn input(op: &InputOp) -> Result<(), String> {
    match op {
        InputOp::Move { x, y } => send(&[move_to(*x, *y)]),
        InputOp::Click {
            x,
            y,
            button,
            count,
            hold,
        } => {
            let (down, up) = match button {
                Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            };
            send(&[move_to(*x, *y)])?;
            pause(30);
            let mut inputs: Vec<INPUT> = hold.iter().map(|vk| key_down(*vk)).collect();
            for _ in 0..(*count).clamp(1, 3) {
                inputs.push(mouse(0, 0, 0, down));
                inputs.push(mouse(0, 0, 0, up));
            }
            inputs.extend(hold.iter().rev().map(|vk| key_up(*vk)));
            send(&inputs)
        }
        InputOp::Drag {
            from_x,
            from_y,
            x,
            y,
        } => {
            send(&[move_to(*from_x, *from_y)])?;
            pause(30);
            send(&[mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN)])?;
            // A few steps on the way, so apps see a drag rather than a jump.
            const STEPS: i32 = 12;
            for i in 1..=STEPS {
                // In i64: points far apart overflowed i32 on the way.
                let step = |from: i32, to: i32| {
                    (i64::from(from)
                        + (i64::from(to) - i64::from(from)) * i64::from(i) / i64::from(STEPS))
                        as i32
                };
                send(&[move_to(step(*from_x, *x), step(*from_y, *y))])?;
                pause(15);
            }
            send(&[mouse(0, 0, 0, MOUSEEVENTF_LEFTUP)])
        }
        InputOp::Scroll { x, y, dx, dy } => {
            send(&[move_to(*x, *y)])?;
            pause(30);
            let mut inputs = Vec::new();
            if *dy != 0 {
                // Wheel up is positive in Windows; "down" ticks are positive here.
                // Saturating: the ticks come from the agent (an overflow wrapped the direction).
                inputs.push(mouse(
                    0,
                    0,
                    dy.saturating_mul(WHEEL_DELTA).saturating_neg(),
                    MOUSEEVENTF_WHEEL,
                ));
            }
            if *dx != 0 {
                inputs.push(mouse(
                    0,
                    0,
                    dx.saturating_mul(WHEEL_DELTA),
                    MOUSEEVENTF_HWHEEL,
                ));
            }
            send(&inputs)
        }
        InputOp::Type { text } => {
            for ch in text.chars() {
                let inputs: Vec<INPUT> = match ch {
                    '\n' => vec![key_down(VK_RETURN.0), key_up(VK_RETURN.0)],
                    '\r' => continue,
                    '\t' => vec![key_down(VK_TAB.0), key_up(VK_TAB.0)],
                    _ => {
                        let mut units = [0u16; 2];
                        ch.encode_utf16(&mut units)
                            .iter()
                            .flat_map(|unit| {
                                [
                                    key(0, *unit, KEYEVENTF_UNICODE),
                                    key(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
                                ]
                            })
                            .collect()
                    }
                };
                send(&inputs)?;
                pause(4);
            }
            Ok(())
        }
        InputOp::Key { keys, repeat } => {
            for _ in 0..(*repeat).clamp(1, 100) {
                let mut inputs: Vec<INPUT> = keys.iter().map(|vk| key_down(*vk)).collect();
                inputs.extend(keys.iter().rev().map(|vk| key_up(*vk)));
                send(&inputs)?;
                pause(20);
            }
            Ok(())
        }
    }
}
