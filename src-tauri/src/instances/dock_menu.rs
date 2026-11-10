//! The Dock icon's menu on macOS (right-click it, as VS Code's): the recent folders and "New
//! window", the jump list's entries (`jump_list.rs`) on macOS. Neither Tauri nor tao has an API
//! for it, so this answers AppKit's `applicationDockMenu:` itself: the method is added at run time
//! to the application delegate's class (tao's), returning a menu built here whose items call back
//! into Rust. Each item starts the IDE again with the folder or `--new-window`, exactly as a jump
//! list entry does, so a folder already open is focused (the window registry, `mod.rs`).
//!
//! Plain Objective-C runtime calls (`libobjc`, `objc_msgSend` cast to each call's signature): no
//! new dependency. Everything runs on the main thread (AppKit's rule): `apply` hands the work to
//! it. Unverified: written on Windows, where this file isn't compiled.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::Mutex;

use super::jump_list::{JumpList, JumpListResult};

type Id = *mut c_void;
type Sel = *mut c_void;
type Class = *mut c_void;

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Class;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_allocateClassPair(superclass: Class, name: *const c_char, extra: usize) -> Class;
    fn objc_registerClassPair(class: Class);
    fn class_addMethod(class: Class, name: Sel, imp: *const c_void, types: *const c_char) -> bool;
    fn object_getClass(object: Id) -> Class;
    fn objc_msgSend();
}

// AppKit is linked already (tao); named here so these symbols resolve whatever the link order.
#[link(name = "AppKit", kind = "framework")]
extern "C" {}

/// What the menu's items open: the folders in order (an item's tag is its index; -1 is New
/// window) and the profile folder the IDE runs with.
struct Launch {
    folders: Vec<String>,
    user_data_dir: Option<PathBuf>,
}

static LAUNCH: Mutex<Option<Launch>> = Mutex::new(None);
/// The menu AppKit gets (retained here; the previous one is released when replaced).
static MENU: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// The items' target (an instance of the class made here, kept for the app's lifetime).
static TARGET: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

fn sel(name: &CStr) -> Sel {
    // SAFETY: a NUL-terminated selector name; the runtime interns it.
    unsafe { sel_registerName(name.as_ptr()) }
}

fn class(name: &CStr) -> Class {
    // SAFETY: a NUL-terminated class name; null when there's no such class.
    unsafe { objc_getClass(name.as_ptr()) }
}

/// `[object selector]` returning an object.
unsafe fn send0(object: Id, selector: &CStr) -> Id {
    let f: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute::<
        unsafe extern "C" fn(),
        unsafe extern "C" fn(Id, Sel) -> Id,
    >(objc_msgSend);
    f(object, sel(selector))
}

/// `[object selector:argument]` with an object argument, returning an object.
unsafe fn send1(object: Id, selector: &CStr, argument: Id) -> Id {
    let f: unsafe extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute::<
        unsafe extern "C" fn(),
        unsafe extern "C" fn(Id, Sel, Id) -> Id,
    >(objc_msgSend);
    f(object, sel(selector), argument)
}

/// `[item setTag:tag]`.
unsafe fn set_tag(item: Id, tag: isize) {
    let f: unsafe extern "C" fn(Id, Sel, isize) = std::mem::transmute::<
        unsafe extern "C" fn(),
        unsafe extern "C" fn(Id, Sel, isize),
    >(objc_msgSend);
    f(item, sel(c"setTag:"), tag)
}

/// `[item tag]`.
unsafe fn tag_of(item: Id) -> isize {
    let f: unsafe extern "C" fn(Id, Sel) -> isize = std::mem::transmute::<
        unsafe extern "C" fn(),
        unsafe extern "C" fn(Id, Sel) -> isize,
    >(objc_msgSend);
    f(item, sel(c"tag"))
}

/// An autoreleased NSString with `text` (null when it holds a NUL).
unsafe fn ns_string(text: &str) -> Id {
    let Ok(c) = CString::new(text) else {
        return std::ptr::null_mut();
    };
    let f: unsafe extern "C" fn(Id, Sel, *const c_char) -> Id = std::mem::transmute::<
        unsafe extern "C" fn(),
        unsafe extern "C" fn(Id, Sel, *const c_char) -> Id,
    >(objc_msgSend);
    f(
        class(c"NSString"),
        sel(c"stringWithUTF8String:"),
        c.as_ptr(),
    )
}

/// `[menu addItemWithTitle:title action:@selector(openEntry:) keyEquivalent:@""]`, its target and
/// tag set.
unsafe fn add_item(menu: Id, title: &str, tag: isize) {
    let title = ns_string(title);
    if title.is_null() {
        return;
    }
    let f: unsafe extern "C" fn(Id, Sel, Id, Sel, Id) -> Id = std::mem::transmute::<
        unsafe extern "C" fn(),
        unsafe extern "C" fn(Id, Sel, Id, Sel, Id) -> Id,
    >(objc_msgSend);
    let item = f(
        menu,
        sel(c"addItemWithTitle:action:keyEquivalent:"),
        title,
        sel(c"openEntry:"),
        ns_string(""),
    );
    if item.is_null() {
        return;
    }
    send1(item, c"setTarget:", TARGET.load(Ordering::Acquire));
    set_tag(item, tag);
}

/// AppKit asks the delegate for the Dock menu each time it's shown.
extern "C" fn dock_menu(_this: Id, _cmd: Sel, _sender: Id) -> Id {
    MENU.load(Ordering::Acquire)
}

/// A menu item was picked: start the IDE with its folder (or a new window).
extern "C" fn open_entry(_this: Id, _cmd: Sel, sender: Id) {
    if sender.is_null() {
        return;
    }
    // SAFETY: `sender` is the NSMenuItem AppKit passes to the action.
    let tag = unsafe { tag_of(sender) };
    let Ok(guard) = LAUNCH.lock() else { return };
    let Some(launch) = guard.as_ref() else { return };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    let folder = usize::try_from(tag)
        .ok()
        .and_then(|i| launch.folders.get(i));
    match folder {
        Some(f) => {
            cmd.arg(f);
        }
        None => {
            cmd.arg("--new-window");
        }
    }
    if let Some(dir) = &launch.user_data_dir {
        cmd.arg("--user-data-dir").arg(dir);
    }
    let spawned = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    // Waited for on a thread of its own, so a window that quits isn't left a zombie (D233 audit).
    if let Ok(mut child) = spawned {
        let _ = std::thread::Builder::new()
            .name("dock-launch".into())
            .spawn(move || {
                let _ = child.wait();
            });
    }
}

/// Makes the items' target class and instance, and teaches the app delegate's class to answer
/// `applicationDockMenu:`, once. False when AppKit isn't ready (no delegate yet).
unsafe fn install() -> bool {
    if !TARGET.load(Ordering::Acquire).is_null() {
        return true;
    }
    let app = send0(class(c"NSApplication"), c"sharedApplication");
    if app.is_null() {
        return false;
    }
    let delegate = send0(app, c"delegate");
    if delegate.is_null() {
        return false;
    }
    // The target: an NSObject subclass with `openEntry:`.
    let name = c"IdeDockMenuTarget";
    let mut target_class = class(name);
    if target_class.is_null() {
        target_class = objc_allocateClassPair(class(c"NSObject"), name.as_ptr(), 0);
        if target_class.is_null() {
            return false;
        }
        class_addMethod(
            target_class,
            sel(c"openEntry:"),
            open_entry as *const c_void,
            c"v@:@".as_ptr(),
        );
        objc_registerClassPair(target_class);
    }
    let target = send0(send0(target_class, c"alloc"), c"init");
    if target.is_null() {
        return false;
    }
    TARGET.store(target, Ordering::Release);
    // The delegate's `applicationDockMenu:` (tao's delegate has none; if it had, its own stays).
    let delegate_class = object_getClass(delegate);
    class_addMethod(
        delegate_class,
        sel(c"applicationDockMenu:"),
        dock_menu as *const c_void,
        c"@@:@".as_ptr(),
    );
    // AppKit may have looked at what the delegate answers when it was set: set it again.
    send1(app, c"setDelegate:", std::ptr::null_mut());
    send1(app, c"setDelegate:", delegate);
    true
}

/// Builds the menu: the folders (titles as given), a separator, the New window item.
unsafe fn build(list: &JumpList, folders: &[String]) -> Id {
    let menu = send0(send0(class(c"NSMenu"), c"alloc"), c"init");
    if menu.is_null() {
        return menu;
    }
    for (i, path) in folders.iter().enumerate() {
        let title = list
            .folders
            .iter()
            .find(|f| f.path.trim() == path)
            .map(|f| f.title.as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or(path.as_str());
        add_item(menu, title, i as isize);
    }
    if !folders.is_empty() {
        let separator = send0(class(c"NSMenuItem"), c"separatorItem");
        if !separator.is_null() {
            send1(menu, c"addItem:", separator);
        }
    }
    add_item(menu, &list.new_window, -1);
    menu
}

/// Replaces the Dock menu (on the main thread). `applied`: it's in place.
pub fn apply(
    app: &tauri::AppHandle,
    list: &JumpList,
    user_data_dir: Option<PathBuf>,
) -> Result<JumpListResult, String> {
    let folders: Vec<String> = super::jump_list::usable_unix_folders(&list.folders, 10)
        .into_iter()
        .map(|f| f.path)
        .collect();
    if let Ok(mut launch) = LAUNCH.lock() {
        *launch = Some(Launch {
            folders: folders.clone(),
            user_data_dir,
        });
    }
    let list = list.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        // SAFETY: AppKit calls on the main thread; every object is checked for null, the menu
        // is retained (alloc/init) until the next one replaces it.
        let applied = unsafe {
            if install() {
                let menu = build(&list, &folders);
                let old = MENU.swap(menu, Ordering::AcqRel);
                if !old.is_null() {
                    send0(old, c"release");
                }
                !menu.is_null()
            } else {
                false
            }
        };
        let _ = tx.send(applied);
    })
    .map_err(|e| e.to_string())?;
    let applied = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap_or(false);
    Ok(JumpListResult {
        removed: Vec::new(),
        applied,
    })
}
