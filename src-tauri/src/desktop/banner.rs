//! The "Controlling your computer" banner (D353): a small always-on-top window at the top of the
//! primary monitor with the text and a Stop button, on its own thread with its own message loop.
//! It never takes focus (no-activate tool window) and is left out of screen captures
//! (WDA_EXCLUDEFROMCAPTURE), so the model's screenshots don't show it. While it's up, a second
//! thread watches Escape: a press the IDE didn't inject itself sets the stop flag.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateFontIndirectW, DeleteObject, COLOR_WINDOW, HBRUSH, HFONT, HGDIOBJ,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetSystemMetrics, LoadCursorW,
    PostMessageW, PostQuitMessage, RegisterClassW, SendMessageW, SetWindowDisplayAffinity,
    SystemParametersInfoW, TranslateMessage, BS_PUSHBUTTON, HMENU, IDC_ARROW, MSG,
    NONCLIENTMETRICSW, SM_CXSCREEN, SPI_GETNONCLIENTMETRICS, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    WDA_EXCLUDEFROMCAPTURE, WINDOW_STYLE, WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_SETFONT, WNDCLASSW,
    WS_BORDER, WS_CHILD, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

use super::{INJECTING, STOP};

/// The banner's window (an HWND as an integer: HWND isn't Send), 0 when none.
static WINDOW: AtomicIsize = AtomicIsize::new(0);
static WATCHING: AtomicBool = AtomicBool::new(false);
/// Serializes show / hide.
static LOCK: Mutex<()> = Mutex::new(());
const STOP_ID: usize = 1;
/// A static control's "center vertically" style (SS_CENTERIMAGE).
const SS_CENTERIMAGE: u32 = 0x200;

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_COMMAND if (wparam.0 & 0xffff) == STOP_ID => {
            STOP.store(true, Ordering::SeqCst);
            LRESULT(0)
        }
        WM_DESTROY => {
            // SAFETY: ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // SAFETY: the default handling for everything else.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn show(text: &str) {
    let Ok(_guard) = LOCK.lock() else { return };
    if WINDOW.load(Ordering::SeqCst) != 0 {
        return;
    }
    let text = wide(text);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<isize>();
    std::thread::spawn(move || run(text, ready_tx));
    // Wait until the window exists, so a quick hide finds it.
    if let Ok(hwnd) = ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        WINDOW.store(hwnd, Ordering::SeqCst);
    }
    if !WATCHING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(watch_escape);
    }
}

pub fn hide() {
    let Ok(_guard) = LOCK.lock() else { return };
    WATCHING.store(false, Ordering::SeqCst);
    let hwnd = WINDOW.swap(0, Ordering::SeqCst);
    if hwnd != 0 {
        // SAFETY: posting to a window of ours; a window already gone just fails.
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

fn watch_escape() {
    let mut was_down = false;
    while WATCHING.load(Ordering::SeqCst) {
        // SAFETY: a key-state query.
        let down = unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } as u16 & 0x8000 != 0;
        if down && !was_down && !INJECTING.load(Ordering::SeqCst) {
            STOP.store(true, Ordering::SeqCst);
        }
        was_down = down;
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

fn run(text: Vec<u16>, ready: std::sync::mpsc::Sender<isize>) {
    // SAFETY: Win32 window creation and a message loop, all on this thread; the font is deleted
    // when the loop ends.
    unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None).map(Into::into).unwrap_or_default();
        let class = w!("DesktopControlBanner");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance,
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as usize as *mut _),
            ..Default::default()
        };
        // Fails harmlessly when the class is already registered (a second show).
        RegisterClassW(&wc);

        // The system's message font (already scaled for the display), a little larger.
        let mut metrics = NONCLIENTMETRICSW {
            cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
            ..Default::default()
        };
        let font: HFONT = if SystemParametersInfoW(
            SPI_GETNONCLIENTMETRICS,
            metrics.cbSize,
            Some(&mut metrics as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
        {
            let mut lf = metrics.lfMessageFont;
            lf.lfHeight = lf.lfHeight * 6 / 5;
            CreateFontIndirectW(&lf)
        } else {
            HFONT::default()
        };
        let unit = if metrics.lfMessageFont.lfHeight != 0 {
            metrics.lfMessageFont.lfHeight.abs().max(12)
        } else {
            12
        };
        let (width, height) = (unit * 32, unit * 3);
        let x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
        let y = unit;
        let Ok(hwnd) = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("Controlling your computer"),
            WS_POPUP | WS_VISIBLE | WS_BORDER,
            x,
            y,
            width,
            height,
            None,
            None,
            Some(instance),
            None,
        ) else {
            let _ = ready.send(0);
            return;
        };
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        let pad = unit;
        let button_w = unit * 6;
        let label = CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            PCWSTR(text.as_ptr()),
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE(SS_CENTERIMAGE),
            pad,
            0,
            width - button_w - pad * 3,
            height - 2,
            Some(hwnd),
            None,
            Some(instance),
            None,
        );
        let button = CreateWindowExW(
            Default::default(),
            w!("BUTTON"),
            w!("Stop"),
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32),
            width - button_w - pad,
            unit / 2,
            button_w,
            height - unit - 2,
            Some(hwnd),
            Some(HMENU(STOP_ID as *mut _)),
            Some(instance),
            None,
        );
        if !font.is_invalid() {
            for child in [label, button].into_iter().flatten() {
                SendMessageW(
                    child,
                    WM_SETFONT,
                    Some(WPARAM(font.0 as usize)),
                    Some(LPARAM(1)),
                );
            }
        }
        let _ = ready.send(hwnd.0 as isize);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if !font.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(font.0));
        }
    }
}
