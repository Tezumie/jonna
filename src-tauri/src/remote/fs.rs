//! The file commands' remote side (docs/remote.md "Files"): the same results as the local
//! `crate::fs` functions, from the server. Paths are the remote's POSIX paths; the server checks
//! the workspace scope again.

use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::fs::{DirEntry, FolderStatus, Stat};

/// Reads and writes of big files over a slow link take longer than other requests.
fn transfer_timeout(bytes: usize) -> Duration {
    // 60 s, plus a second per 256 KB.
    Duration::from_secs(60 + (bytes / (256 * 1024)) as u64)
}

fn path_of(v: Value) -> Result<String> {
    v.as_str()
        .map(str::to_string)
        .ok_or_else(|| Error::Exec("the remote answered without a path".into()))
}

pub async fn open(path: &str) -> Result<String> {
    path_of(super::call("ws.open", json!({ "path": path })).await?)
}

pub async fn set_folders(paths: &[String]) -> Result<Vec<FolderStatus>> {
    let v = super::call("ws.setFolders", json!({ "paths": paths })).await?;
    Ok(serde_json::from_value(v)?)
}

pub async fn close() -> Result<()> {
    super::call("ws.close", json!({})).await.map(|_| ())
}

pub async fn list_dir(path: &str) -> Result<Vec<DirEntry>> {
    let v = super::call("fs.listDir", json!({ "path": path })).await?;
    Ok(serde_json::from_value(v)?)
}

pub async fn stat(path: &str) -> Result<Stat> {
    let v = super::call("fs.stat", json!({ "path": path })).await?;
    Ok(serde_json::from_value(v)?)
}

pub async fn read(path: &str) -> Result<Vec<u8>> {
    let v = super::conn()?
        .call_with(
            "fs.read",
            json!({ "path": path }),
            transfer_timeout(48 << 20),
        )
        .await?;
    let data = v.get("data").and_then(Value::as_str).unwrap_or("");
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| Error::Exec(format!("the remote sent a bad file: {e}")))
}

pub async fn write(path: &str, bytes: &[u8]) -> Result<()> {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    super::conn()?
        .call_with(
            "fs.write",
            json!({ "path": path, "data": data }),
            transfer_timeout(bytes.len()),
        )
        .await
        .map(|_| ())
}

pub async fn create_file(parent: &str, name: &str) -> Result<String> {
    path_of(super::call("fs.createFile", json!({ "parent": parent, "name": name })).await?)
}

pub async fn create_dir(parent: &str, name: &str) -> Result<String> {
    path_of(super::call("fs.createDir", json!({ "parent": parent, "name": name })).await?)
}

pub async fn rename(path: &str, new_name: &str) -> Result<String> {
    path_of(super::call("fs.rename", json!({ "path": path, "newName": new_name })).await?)
}

pub async fn move_into(path: &str, dest: &str) -> Result<String> {
    path_of(super::call("fs.move", json!({ "path": path, "dest": dest })).await?)
}

pub async fn copy_into(path: &str, dest: &str) -> Result<String> {
    path_of(super::call("fs.copy", json!({ "path": path, "dest": dest })).await?)
}

pub async fn delete(path: &str) -> Result<()> {
    super::call("fs.delete", json!({ "path": path }))
        .await
        .map(|_| ())
}

/// A folder anywhere on the remote (the folder picker): `~` is the home folder.
pub async fn browse(path: &str) -> Result<Vec<DirEntry>> {
    let v = super::call("browse.listDir", json!({ "path": path })).await?;
    Ok(serde_json::from_value(v)?)
}

/// Sets the folders the server's watcher set `watcher` watches (none: stops it).
pub async fn watch(watcher: &str, dirs: &[String], recursive: bool) -> Result<()> {
    super::call(
        "watch.setDirs",
        json!({ "watcher": watcher, "dirs": dirs, "recursive": recursive }),
    )
    .await
    .map(|_| ())
}
