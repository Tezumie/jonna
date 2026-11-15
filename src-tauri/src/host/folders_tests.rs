//! The app's folders in the host build are the desktop app's: the stand-in framework's
//! formulas (`host-shim/src/path.rs`), per OS, and the base folders this OS gives.

use std::path::{Path, PathBuf};

use tauri::path::{app_folders, resource_dir_of, BaseDirs};

fn base(home: &str, data: &str, config: &str, local: &str, cache: &str) -> BaseDirs {
    BaseDirs {
        home: Some(PathBuf::from(home)),
        data: Some(PathBuf::from(data)),
        config: Some(PathBuf::from(config)),
        local_data: Some(PathBuf::from(local)),
        cache: Some(PathBuf::from(cache)),
    }
}

#[test]
fn windows_folders() {
    let roaming = r"C:\Users\me\AppData\Roaming";
    let local = r"C:\Users\me\AppData\Local";
    let dirs = app_folders(
        &base(r"C:\Users\me", roaming, roaming, local, local),
        "dev.example.app",
        false,
    );
    assert_eq!(dirs.data, Some(Path::new(roaming).join("dev.example.app")));
    assert_eq!(dirs.config, dirs.data);
    assert_eq!(
        dirs.local_data,
        Some(Path::new(local).join("dev.example.app"))
    );
    assert_eq!(dirs.cache, dirs.local_data);
    assert_eq!(
        dirs.log,
        Some(Path::new(local).join("dev.example.app").join("logs"))
    );
}

#[test]
fn macos_folders() {
    let support = "/Users/me/Library/Application Support";
    let dirs = app_folders(
        &base(
            "/Users/me",
            support,
            support,
            support,
            "/Users/me/Library/Caches",
        ),
        "dev.example.app",
        true,
    );
    assert_eq!(
        dirs.data,
        Some(PathBuf::from(
            "/Users/me/Library/Application Support/dev.example.app"
        ))
    );
    assert_eq!(dirs.config, dirs.data);
    assert_eq!(dirs.local_data, dirs.data);
    assert_eq!(
        dirs.cache,
        Some(PathBuf::from("/Users/me/Library/Caches/dev.example.app"))
    );
    assert_eq!(
        dirs.log,
        Some(
            Path::new("/Users/me")
                .join("Library/Logs")
                .join("dev.example.app")
        )
    );
}

#[test]
fn linux_folders() {
    let dirs = app_folders(
        &base(
            "/home/me",
            "/home/me/.local/share",
            "/home/me/.config",
            "/home/me/.local/share",
            "/home/me/.cache",
        ),
        "dev.example.app",
        false,
    );
    assert_eq!(
        dirs.data,
        Some(PathBuf::from("/home/me/.local/share/dev.example.app"))
    );
    assert_eq!(
        dirs.config,
        Some(PathBuf::from("/home/me/.config/dev.example.app"))
    );
    assert_eq!(dirs.local_data, dirs.data);
    assert_eq!(
        dirs.cache,
        Some(PathBuf::from("/home/me/.cache/dev.example.app"))
    );
    assert_eq!(
        dirs.log,
        Some(PathBuf::from("/home/me/.local/share/dev.example.app/logs"))
    );
}

/// The base folders the OS gives are the ones the table at the top of this file names.
#[test]
fn base_folders_of_this_os() {
    let found = BaseDirs::of_user();
    #[cfg(windows)]
    {
        let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        if roaming.is_some() {
            assert_eq!(found.data, roaming);
            assert_eq!(found.config, roaming);
        }
        if local.is_some() {
            assert_eq!(found.local_data, local);
            assert_eq!(found.cache, local);
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = &found.home {
        let support = home.join("Library/Application Support");
        assert_eq!(found.data.as_deref(), Some(support.as_path()));
        assert_eq!(found.config.as_deref(), Some(support.as_path()));
        assert_eq!(found.local_data.as_deref(), Some(support.as_path()));
        assert_eq!(found.cache, Some(home.join("Library/Caches")));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = &found.home {
        let xdg = |name: &str, fallback: &str| {
            std::env::var_os(name)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(fallback))
        };
        assert_eq!(found.data, Some(xdg("XDG_DATA_HOME", ".local/share")));
        assert_eq!(found.config, Some(xdg("XDG_CONFIG_HOME", ".config")));
        assert_eq!(found.local_data, found.data);
        assert_eq!(found.cache, Some(xdg("XDG_CACHE_HOME", ".cache")));
    }
    let app = app_folders(&found, "dev.example.app", cfg!(target_os = "macos"));
    assert_eq!(
        app.data,
        found.data.as_ref().map(|d| d.join("dev.example.app"))
    );
}

/// The host's data folder is where the desktop app keeps its registry of windows (a formula
/// written independently, for the command line that runs before the framework starts).
#[test]
fn the_data_folder_is_the_desktop_apps() {
    use tauri::Manager;
    let (identifier, name) = super::product();
    let app = tauri::AppHandle::new(&identifier, &name, "0.0.0");
    let Ok(data) = app.path().app_data_dir() else {
        // No home folder here (a bare container): nothing to compare.
        return;
    };
    assert!(data.ends_with(&identifier));
    if let Some(windows) = crate::instances::registry_dir(None) {
        assert_eq!(windows, data.join("windows"));
    }
}

/// A launcher's link to the host program (`/usr/local/bin/…` into the app's bundle): the
/// resources are where the program is.
#[cfg(unix)]
#[test]
fn resources_are_beside_the_program_not_beside_a_link_to_it() {
    let root = std::env::temp_dir().join(format!("host-resources-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let bin = root.join("app").join("bin");
    let resources = if cfg!(target_os = "macos") {
        root.join("app").join("Resources")
    } else {
        root.join("app").join("lib").join("Example")
    };
    let links = root.join("links");
    for dir in [&bin, &resources, &links] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let program = bin.join("host");
    std::fs::write(&program, b"").unwrap();
    let link = links.join("host");
    std::os::unix::fs::symlink(&program, &link).unwrap();
    let expected = resources.canonicalize().unwrap();
    assert_eq!(resource_dir_of(&program, "Example"), Some(expected.clone()));
    assert_eq!(resource_dir_of(&link, "Example"), Some(expected));
    let _ = std::fs::remove_dir_all(&root);
}

/// On Windows the resources are in the program's folder, whatever the path looks like: a
/// share, letters outside ASCII, a `\\?\` path. None of it is rewritten.
#[cfg(windows)]
#[test]
fn windows_resources_are_in_the_programs_folder() {
    for folder in [
        r"C:\Program Files\Example",
        r"C:\Users\Jörg 山田\AppData\Local\Example",
        r"\\server\share\équipe\Example",
        r"\\?\C:\Users\Jörg\Example",
        r"\\?\UNC\server\share\Example",
    ] {
        let exe = Path::new(folder).join("ide-host.exe");
        assert_eq!(
            resource_dir_of(&exe, "Example"),
            Some(PathBuf::from(folder)),
            "{folder}"
        );
    }
    assert_eq!(resource_dir_of(Path::new(r"C:\"), "Example"), None);
}
