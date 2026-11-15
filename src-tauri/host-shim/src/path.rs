//! The app's and the user's folders, by the desktop framework's formulas, so the host reads and
//! writes the same settings, keys, sessions and history as the desktop app.
//!
//! The framework takes the OS's base folders from the `dirs` crate and appends the app's
//! identifier; this does the same with the same crate:
//!
//! | folder | Windows | macOS | Linux |
//! |---|---|---|---|
//! | data, config | `%APPDATA%\<id>` | `~/Library/Application Support/<id>` | `$XDG_DATA_HOME/<id>` (`~/.local/share`), `$XDG_CONFIG_HOME/<id>` (`~/.config`) |
//! | local data | `%LOCALAPPDATA%\<id>` | as data | as data |
//! | cache | `%LOCALAPPDATA%\<id>` | `~/Library/Caches/<id>` | `$XDG_CACHE_HOME/<id>` (`~/.cache`) |
//! | logs | `%LOCALAPPDATA%\<id>\logs` | `~/Library/Logs/<id>` | `<local data>/logs` |

use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// The OS's base folders, before the app's identifier is appended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BaseDirs {
    pub home: Option<PathBuf>,
    pub data: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub local_data: Option<PathBuf>,
    pub cache: Option<PathBuf>,
}

impl BaseDirs {
    /// What the OS says for the current user.
    pub fn of_user() -> Self {
        Self {
            home: dirs::home_dir(),
            data: dirs::data_dir(),
            config: dirs::config_dir(),
            local_data: dirs::data_local_dir(),
            cache: dirs::cache_dir(),
        }
    }
}

/// The app's own folders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppFolders {
    pub data: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub local_data: Option<PathBuf>,
    pub cache: Option<PathBuf>,
    pub log: Option<PathBuf>,
}

/// The framework's formulas: each base folder with the identifier appended; logs under the
/// local data folder, except on macOS (`~/Library/Logs/<id>`).
pub fn app_folders(base: &BaseDirs, identifier: &str, macos: bool) -> AppFolders {
    let with_id = |dir: &Option<PathBuf>| dir.as_ref().map(|d| d.join(identifier));
    let log = if macos {
        base.home
            .as_ref()
            .map(|home| home.join("Library/Logs").join(identifier))
    } else {
        with_id(&base.local_data).map(|dir| dir.join("logs"))
    };
    AppFolders {
        data: with_id(&base.data),
        config: with_id(&base.config),
        local_data: with_id(&base.local_data),
        cache: with_id(&base.cache),
        log,
    }
}

/// `app.path()`: the folders, asked one at a time like the framework's resolver.
#[derive(Debug, Clone)]
pub struct PathResolver {
    identifier: String,
    /// The name resources are installed under on Linux (`/usr/lib/<name>`).
    product_name: String,
}

fn known(path: Option<PathBuf>) -> Result<PathBuf> {
    path.ok_or(Error::UnknownPath)
}

impl PathResolver {
    pub(crate) fn new(identifier: &str, product_name: &str) -> Self {
        Self {
            identifier: identifier.to_string(),
            product_name: product_name.to_string(),
        }
    }

    fn app(&self) -> AppFolders {
        app_folders(
            &BaseDirs::of_user(),
            &self.identifier,
            cfg!(target_os = "macos"),
        )
    }

    pub fn app_data_dir(&self) -> Result<PathBuf> {
        known(self.app().data)
    }

    pub fn app_config_dir(&self) -> Result<PathBuf> {
        known(self.app().config)
    }

    pub fn app_local_data_dir(&self) -> Result<PathBuf> {
        known(self.app().local_data)
    }

    pub fn app_cache_dir(&self) -> Result<PathBuf> {
        known(self.app().cache)
    }

    pub fn app_log_dir(&self) -> Result<PathBuf> {
        known(self.app().log)
    }

    pub fn home_dir(&self) -> Result<PathBuf> {
        known(dirs::home_dir())
    }

    pub fn data_dir(&self) -> Result<PathBuf> {
        known(dirs::data_dir())
    }

    pub fn config_dir(&self) -> Result<PathBuf> {
        known(dirs::config_dir())
    }

    pub fn local_data_dir(&self) -> Result<PathBuf> {
        known(dirs::data_local_dir())
    }

    pub fn cache_dir(&self) -> Result<PathBuf> {
        known(dirs::cache_dir())
    }

    pub fn download_dir(&self) -> Result<PathBuf> {
        known(dirs::download_dir())
    }

    pub fn desktop_dir(&self) -> Result<PathBuf> {
        known(dirs::desktop_dir())
    }

    pub fn document_dir(&self) -> Result<PathBuf> {
        known(dirs::document_dir())
    }

    pub fn temp_dir(&self) -> Result<PathBuf> {
        Ok(std::env::temp_dir())
    }

    /// Where the app's bundled resources are, for a host program installed beside the app's own:
    /// the program's folder on Windows and in a build folder, `../Resources` in a macOS bundle,
    /// `../lib/<name>` or `/usr/lib/<name>` on Linux.
    pub fn resource_dir(&self) -> Result<PathBuf> {
        let exe = std::env::current_exe()?;
        let dir = exe.parent().ok_or(Error::UnknownPath)?;
        Ok(resource_dir_from(dir, &self.product_name))
    }
}

#[cfg_attr(windows, allow(unused_variables))]
fn resource_dir_from(exe_dir: &Path, product_name: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Ok(resources) = exe_dir.join("../Resources").canonicalize() {
        return resources;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(bundled) = exe_dir
            .join(format!("../lib/{product_name}"))
            .canonicalize()
        {
            return bundled;
        }
        let installed = PathBuf::from(format!("/usr/lib/{product_name}"));
        if installed.is_dir() {
            return installed;
        }
    }
    exe_dir.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
