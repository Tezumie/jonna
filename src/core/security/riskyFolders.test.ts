import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanFolder,
  downloadsFolderOf,
  insideFolder,
  isFileSystemRoot,
  mentionsFolder,
  riskyFolderOf,
  type UserFolders,
} from "./riskyFolders";

const WIN: UserFolders = {
  home: "C:\\Users\\Me",
  downloads: ["C:\\Users\\Me\\Downloads", "D:\\Downloads"],
  desktop: ["C:\\Users\\Me\\Desktop", "C:\\Users\\Me\\OneDrive\\Desktop"],
  temp: ["C:\\Users\\Me\\AppData\\Local\\Temp"],
};
const MAC: UserFolders = {
  home: "/Users/me",
  downloads: ["/Users/me/Downloads"],
  desktop: ["/Users/me/Desktop"],
  temp: ["/private/var/folders/xy/T", "/tmp", "/private/tmp"],
};
const LINUX: UserFolders = {
  home: "/home/me",
  downloads: ["/home/me/Téléchargements", "/home/me/Downloads"],
  desktop: ["/home/me/Desktop"],
  temp: ["/tmp"],
};

test("risky folders: Windows shapes, without case, nested Downloads", () => {
  assert.deepEqual(riskyFolderOf("C:\\Users\\Me\\Downloads", WIN, "windows"), {
    kind: "downloads",
    folder: "C:\\Users\\Me\\Downloads",
  });
  assert.equal(riskyFolderOf("c:\\users\\me\\downloads\\", WIN, "windows")?.kind, "downloads");
  assert.equal(riskyFolderOf("C:/Users/ME/Downloads/repo-main", WIN, "windows")?.kind, "downloads");
  assert.equal(
    riskyFolderOf("\\\\?\\C:\\Users\\Me\\Downloads\\x", WIN, "windows")?.kind,
    "downloads",
  );
  // A Downloads folder moved to another drive (the Known Folder) counts too.
  assert.equal(riskyFolderOf("d:\\downloads\\zip-extract", WIN, "windows")?.kind, "downloads");
  // A sibling with the same prefix doesn't.
  assert.equal(riskyFolderOf("C:\\Users\\Me\\DownloadsOld", WIN, "windows"), null);
  assert.equal(riskyFolderOf("C:\\Users\\Me", WIN, "windows")?.kind, "home");
  assert.equal(riskyFolderOf("C:\\Users\\Me\\OneDrive\\Desktop", WIN, "windows")?.kind, "desktop");
  // The home folder, the Desktop and temp count only as themselves: projects under them are fine.
  assert.equal(riskyFolderOf("C:\\Users\\Me\\src\\app", WIN, "windows"), null);
  assert.equal(riskyFolderOf("C:\\Users\\Me\\Desktop\\project", WIN, "windows"), null);
  assert.equal(riskyFolderOf("C:\\Users\\Me\\AppData\\Local\\Temp", WIN, "windows")?.kind, "temp");
  assert.equal(
    riskyFolderOf("C:\\Users\\Me\\AppData\\Local\\Temp\\ide-ui-test-1", WIN, "windows"),
    null,
  );
  assert.equal(cleanFolder("\\\\?\\UNC\\srv\\share\\dl\\"), "\\\\srv\\share\\dl");
  assert.equal(cleanFolder("C:\\"), "C:\\");
});

test("risky folders: macOS compares without case, Linux exactly, XDG names", () => {
  assert.equal(riskyFolderOf("/Users/me/downloads/thing", MAC, "mac")?.kind, "downloads");
  assert.equal(riskyFolderOf("/Users/me", MAC, "mac")?.kind, "home");
  assert.equal(riskyFolderOf("/tmp", MAC, "mac")?.kind, "temp");
  assert.equal(riskyFolderOf("/tmp/project", MAC, "mac"), null);
  assert.equal(riskyFolderOf("/home/me/Téléchargements/a", LINUX, "linux")?.kind, "downloads");
  assert.equal(riskyFolderOf("/home/me/downloads", LINUX, "linux"), null);
  assert.equal(riskyFolderOf("/home/me/Downloads/", LINUX, "linux")?.kind, "downloads");
  // security.riskyFolders adds folders that count like Downloads.
  assert.equal(riskyFolderOf("/srv/inbox/x", LINUX, "linux", ["/srv/inbox"])?.kind, "downloads");
  // Downloads wins: a Downloads folder that's the home folder is still Downloads.
  const odd: UserFolders = { home: "/home/me", downloads: ["/home/me"], desktop: [], temp: [] };
  assert.equal(riskyFolderOf("/home/me", odd, "linux")?.kind, "downloads");
  assert.equal(
    downloadsFolderOf("/home/me/Downloads/x/y.md", LINUX, "linux"),
    "/home/me/Downloads",
  );
  assert.equal(downloadsFolderOf("/home/me", LINUX, "linux"), null);
  assert.equal(insideFolder("/", "/a", "linux"), true);
  assert.equal(insideFolder("", "/a", "linux"), false);
});

test("risky folders: drive and file system roots count only as themselves", () => {
  assert.deepEqual(riskyFolderOf("D:\\", WIN, "windows"), { kind: "root", folder: "D:\\" });
  assert.equal(riskyFolderOf("e:", WIN, "windows")?.kind, "root");
  assert.equal(riskyFolderOf("\\\\?\\C:\\", WIN, "windows")?.kind, "root");
  assert.equal(riskyFolderOf("\\\\nas\\share\\", WIN, "windows")?.kind, "root");
  assert.equal(riskyFolderOf("\\\\nas\\share\\proj", WIN, "windows"), null);
  assert.equal(riskyFolderOf("D:\\work\\app", WIN, "windows"), null);
  assert.equal(riskyFolderOf("/", LINUX, "linux")?.kind, "root");
  assert.equal(riskyFolderOf("/srv", LINUX, "linux"), null);
  assert.equal(isFileSystemRoot("C:/"), true);
  assert.equal(isFileSystemRoot("C:\\x"), false);
  // Downloads on a drive's root (D:\ as the Known Folder) is Downloads.
  const odd: UserFolders = { ...WIN, downloads: ["D:\\"] };
  assert.equal(riskyFolderOf("D:\\", odd, "windows")?.kind, "downloads");
});

test("risky folders: command lines that name Downloads", () => {
  const dl = "/home/me/Downloads";
  assert.equal(mentionsFolder("cat /home/me/Downloads/AGENTS.md", dl, "/home/me", "linux"), true);
  assert.equal(mentionsFolder("ls ~/Downloads", dl, "/home/me", "linux"), true);
  assert.equal(mentionsFolder('cd "$HOME/Downloads" && ls', dl, "/home/me", "linux"), true);
  assert.equal(mentionsFolder("ls ~/DownloadsOld", dl, "/home/me", "linux"), false);
  assert.equal(mentionsFolder("npm run downloads", dl, "/home/me", "linux"), false);
  // Relative only from the home folder.
  assert.equal(mentionsFolder("cat Downloads/x", dl, "/home/me", "linux", "/home/me"), true);
  assert.equal(mentionsFolder("cat Downloads/x", dl, "/home/me", "linux", "/home/me/app"), false);
  const win = "C:\\Users\\Me\\Downloads";
  assert.equal(
    mentionsFolder(
      "Get-Content $env:USERPROFILE\\downloads\\a.md",
      win,
      "C:\\Users\\Me",
      "windows",
    ),
    true,
  );
  assert.equal(
    mentionsFolder("type %USERPROFILE%\\Downloads\\a.md", win, "C:\\Users\\Me", "windows"),
    true,
  );
  assert.equal(mentionsFolder("dir c:/users/me/downloads", win, "C:\\Users\\Me", "windows"), true);
});
