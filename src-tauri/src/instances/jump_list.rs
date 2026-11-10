//! The taskbar button's jump list on Windows (right-click it, as VS Code's): the recent folders
//! and a "New window" task. Each entry starts the IDE again with the folder or `--new-window`;
//! that launch finds a window that already has the folder (the registry in `mod.rs`) or opens
//! it. Windows keeps the user's pins and removals itself: a removed folder is reported back so
//! it leaves the IDE's recent list too (VS Code does the same).
//!
//! The process's AppUserModelID is set to the bundle identifier first thing: the installer's
//! shortcuts carry it, so a window started from a jump list entry or the command line groups
//! under the pinned taskbar button, and the list belongs to that button. Debug builds use their
//! own id, so a development build never rewrites the installed IDE's list.
// The taskbar jump list is Windows only (D229).
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// What the frontend asks for: entries in order, and the words to show.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpList {
    pub folders: Vec<JumpFolder>,
    /// The custom category's heading ("Recent folders").
    pub category: String,
    /// The task's title ("New window").
    pub new_window: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpFolder {
    pub path: String,
    pub title: String,
}

/// What was done: the folders the user removed from the list (to drop from the recent list),
/// and whether the list was written at all (only Windows has one).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JumpListResult {
    pub removed: Vec<String>,
    pub applied: bool,
}

/// The AppUserModelID of this build: the bundle identifier, with `.dev` for debug builds.
pub fn app_id(identifier: &str) -> String {
    if cfg!(debug_assertions) {
        format!("{identifier}.dev")
    } else {
        identifier.to_string()
    }
}

/// The command line that opens `path`: one quoted argument, as `CommandLineToArgvW` reads it
/// back (backslashes before a quote are doubled, so `C:\` stays `C:\`). Only absolute paths get
/// here, so none starts with `-` and reads as a flag.
pub fn folder_argument(path: &str) -> String {
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in path.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// The folders a launch can open from the list: absolute (a drive or a UNC path, WSL included),
/// no duplicates (Windows paths ignore case), at most `max`.
pub fn usable_folders(folders: &[JumpFolder], max: usize) -> Vec<JumpFolder> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for folder in folders {
        let p = folder.path.trim();
        let bytes = p.as_bytes();
        let drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
        if !(drive || p.starts_with("\\\\")) {
            continue;
        }
        let key = p.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(JumpFolder {
            path: p.to_string(),
            title: folder.title.clone(),
        });
        if out.len() >= max {
            break;
        }
    }
    out
}

/// The folders macOS's Dock menu can open: absolute Unix paths, no duplicates, at most `max`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn usable_unix_folders(folders: &[JumpFolder], max: usize) -> Vec<JumpFolder> {
    let mut out: Vec<JumpFolder> = Vec::new();
    for folder in folders {
        let p = folder.path.trim();
        if !p.starts_with('/') || out.iter().any(|f| f.path == p) {
            continue;
        }
        out.push(JumpFolder {
            path: p.to_string(),
            title: folder.title.clone(),
        });
        if out.len() >= max {
            break;
        }
    }
    out
}

/// Sets this process's AppUserModelID (before any window is created).
#[cfg(windows)]
pub fn set_process_app_id(id: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    // SAFETY: a plain call with a valid, NUL-terminated string that outlives it.
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(id)) };
}

#[cfg(not(windows))]
pub fn set_process_app_id(_id: &str) {}

/// Replaces the jump list (Windows); elsewhere nothing happens (`applied: false`).
#[cfg(not(windows))]
pub fn apply(_app_id: &str, _list: &JumpList) -> Result<JumpListResult, String> {
    Ok(JumpListResult::default())
}

#[cfg(windows)]
pub fn apply(app_id: &str, list: &JumpList) -> Result<JumpListResult, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    // The shell's list objects are apartment-threaded: their own thread, initialized here.
    let app_id = app_id.to_string();
    let list = list.clone();
    std::thread::spawn(move || {
        // SAFETY: COM is initialized and uninitialized on this thread only; every object made
        // in `write` is released before CoUninitialize.
        unsafe {
            let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = windows_list::write(&app_id, &list).map_err(|e| e.message());
            if initialized {
                CoUninitialize();
            }
            result
        }
    })
    .join()
    .map_err(|_| "the jump list thread panicked".to_string())?
}

#[cfg(windows)]
mod windows_list {
    use super::{folder_argument, usable_folders, JumpList, JumpListResult};
    use windows::core::{Interface, Result, HSTRING, PWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemAlloc, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    /// VS Code shows at most this many recent folders, whatever room the taskbar has.
    const MAX_FOLDERS: usize = 10;

    pub unsafe fn write(app_id: &str, list: &JumpList) -> Result<JumpListResult> {
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let windir = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("windir"))
            .unwrap_or_else(|_| "C:\\Windows".into());
        let explorer = format!("{windir}\\explorer.exe");

        let dest: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        dest.SetAppID(&HSTRING::from(app_id))?;
        let mut slots = 0u32;
        let removed_items: IObjectArray = dest.BeginList(&mut slots)?;
        let removed = removed_arguments(&removed_items);

        let mut removed_paths = Vec::new();
        let folders: Vec<_> = usable_folders(&list.folders, MAX_FOLDERS)
            .into_iter()
            .filter(|f| {
                let gone = removed
                    .iter()
                    .any(|r| r.eq_ignore_ascii_case(&folder_argument(&f.path)));
                if gone {
                    removed_paths.push(f.path.clone());
                }
                !gone
            })
            .collect();

        if !folders.is_empty() {
            let items: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for folder in &folders {
                let link = shell_link(
                    &exe,
                    &folder_argument(&folder.path),
                    &folder.title,
                    &folder.path,
                    &explorer,
                )?;
                items.AddObject(&link)?;
            }
            // Refused when the user turned off recent items in jump lists: the tasks still go in.
            let _ = dest.AppendCategory(
                &HSTRING::from(list.category.as_str()),
                &items.cast::<IObjectArray>()?,
            );
        }

        let tasks: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        tasks.AddObject(&shell_link(
            &exe,
            "--new-window",
            &list.new_window,
            &list.new_window,
            &exe,
        )?)?;
        dest.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
        dest.CommitList()?;
        Ok(JumpListResult {
            removed: removed_paths,
            applied: true,
        })
    }

    /// The arguments of the entries the user removed from the list (Windows won't take them
    /// again until the next BeginList).
    unsafe fn removed_arguments(items: &IObjectArray) -> Vec<String> {
        let mut out = Vec::new();
        let count = items.GetCount().unwrap_or(0);
        for i in 0..count {
            let Ok(link) = items.GetAt::<IShellLinkW>(i) else {
                continue;
            };
            let mut buffer = vec![0u16; 2048];
            if link.GetArguments(&mut buffer).is_ok() {
                let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                out.push(String::from_utf16_lossy(&buffer[..end]));
            }
        }
        out
    }

    unsafe fn shell_link(
        exe: &str,
        arguments: &str,
        title: &str,
        tooltip: &str,
        icon: &str,
    ) -> Result<IShellLinkW> {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(exe))?;
        link.SetArguments(&HSTRING::from(arguments))?;
        link.SetDescription(&HSTRING::from(tooltip))?;
        link.SetIconLocation(&HSTRING::from(icon), 0)?;
        set_title(&link, title)?;
        Ok(link)
    }

    /// An entry's title is its PKEY_Title (a VT_LPWSTR the property store copies).
    unsafe fn set_title(link: &IShellLinkW, title: &str) -> Result<()> {
        let store: IPropertyStore = link.cast()?;
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let memory = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
        if memory.is_null() {
            return Err(windows::Win32::Foundation::E_OUTOFMEMORY.into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), memory, wide.len());
        let mut value = PROPVARIANT::default();
        (*value.Anonymous.Anonymous).vt = VT_LPWSTR;
        (*value.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(memory);
        let result = store.SetValue(&PKEY_Title, &value);
        // Frees the string (CoTaskMemFree), whether or not the store took a copy.
        let _ = PropVariantClear(&mut value);
        result?;
        store.Commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(path: &str) -> JumpFolder {
        JumpFolder {
            path: path.into(),
            title: path.rsplit('\\').next().unwrap_or(path).into(),
        }
    }

    #[test]
    fn folder_arguments_read_back_as_one_argument() {
        assert_eq!(folder_argument("C:\\code\\app"), "\"C:\\code\\app\"");
        assert_eq!(folder_argument("C:\\My Projects"), "\"C:\\My Projects\"");
        // A trailing backslash before the closing quote is doubled (else it escapes it).
        assert_eq!(folder_argument("C:\\"), "\"C:\\\\\"");
        assert_eq!(
            folder_argument("\\\\wsl.localhost\\Ubuntu\\home\\me"),
            "\"\\\\wsl.localhost\\Ubuntu\\home\\me\""
        );
    }

    #[test]
    fn only_absolute_distinct_folders_are_listed() {
        let list = [
            folder("C:\\a"),
            folder("c:\\A"),
            folder("relative\\b"),
            folder("/home/me"),
            folder("\\\\server\\share"),
            folder("D:/c"),
        ];
        let paths: Vec<String> = usable_folders(&list, 10)
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(paths, ["C:\\a", "\\\\server\\share", "D:/c"]);
        assert_eq!(usable_folders(&list, 1).len(), 1);
        // The Dock menu (macOS): Unix paths only, each once.
        let unix = [
            folder("/home/me"),
            folder("/home/me"),
            folder("C:\\a"),
            folder("/w"),
        ];
        let paths: Vec<String> = usable_unix_folders(&unix, 10)
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(paths, ["/home/me", "/w"]);
    }

    #[test]
    fn debug_builds_have_their_own_app_id() {
        let id = app_id("dev.example.ide");
        if cfg!(debug_assertions) {
            assert_eq!(id, "dev.example.ide.dev");
        } else {
            assert_eq!(id, "dev.example.ide");
        }
    }
}
