// All modelling runs in the webview; the Rust side only provides the native
// window, the file dialogs and reading and writing files.
//
// Files go through the commands below rather than the fs plugin, whose scope
// would refuse a recently used design or one passed on the command line: the
// app is a document editor, and may open whatever the user points it at.
use std::borrow::Cow;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::ipc::{InvokeBody, Request, Response};

/// WebKitGTK's DMA-BUF renderer crashes ("Error 71 (Protocol error) dispatching
/// to Wayland display") or shows a blank window with the proprietary NVIDIA
/// driver. Fall back to the compatible renderer there unless the user has
/// made their own choice.
#[cfg(target_os = "linux")]
fn apply_webkit_workarounds() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let nvidia = Path::new("/proc/driver/nvidia/version").exists();
    if nvidia && std::env::var_os(VAR).is_none() {
        // Runs first thing in main, before any other thread exists.
        std::env::set_var(VAR, "1");
    }
}

/// Header values must be ASCII, so the webview percent-encodes the path.
fn percent_decode(input: &[u8]) -> Option<String> {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(input.len());
    let mut rest = input.iter().copied();
    while let Some(byte) = rest.next() {
        if byte == b'%' {
            out.push(hex(rest.next()?)? << 4 | hex(rest.next()?)?);
        } else {
            out.push(byte);
        }
    }
    String::from_utf8(out).ok()
}

/// Tells apart the temporary files of writes running at the same time in this
/// process (a version save and a Ctrl+S, say), which the process id alone
/// cannot.
static WRITE_SERIAL: AtomicU64 = AtomicU64::new(0);

/// A temporary sibling of `target` that no other write, in this process or
/// another, is using.
fn temp_sibling(target: &Path) -> io::Result<PathBuf> {
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a file path"))?;
    let serial = WRITE_SERIAL.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.{}.tmp", std::process::id(), serial));
    Ok(target.with_file_name(tmp_name))
}

/// Write to a temporary sibling, then rename it over the target, so a crash
/// can never leave a half-written design behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // Replace the file a symlink points at, not the link itself.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let tmp = temp_sibling(&target)?;

    // `create_new` refuses to reuse a file another write is still filling.
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let result = (|| {
        file.write_all(bytes)?;
        // The data must be on disk before the rename makes it the only copy.
        file.sync_all()?;
        if let Ok(existing) = fs::metadata(&target) {
            fs::set_permissions(&tmp, existing.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path)
        .map(Response::new)
        .map_err(|err| format!("Could not read {path}: {err}"))
}

/// The file's bytes are the request body and its path is in the `path` header,
/// which spares a multi-megabyte design a round trip through JSON.
#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|value| percent_decode(value.as_bytes()))
        .ok_or("Could not write the file: no valid path was given")?;
    let bytes: Cow<[u8]> = match request.body() {
        InvokeBody::Raw(bytes) => Cow::Borrowed(bytes),
        // Where the webview cannot post a binary body, Tauri falls back to
        // sending the bytes as a JSON array of numbers.
        InvokeBody::Json(value) => value
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok()))
                    .collect::<Option<Vec<u8>>>()
            })
            .map(Cow::Owned)
            .ok_or_else(|| format!("Could not write {path}: the data was not bytes"))?,
    };
    write_atomic(Path::new(&path), &bytes).map_err(|err| format!("Could not write {path}: {err}"))
}

/// Only a design may be opened from the command line: a `.bashcad` file,
/// whatever its case. Anything else on the command line (a flag, a stray
/// document) is ignored.
fn is_design_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("bashcad"))
}

/// The first argument naming an existing design, made absolute.
fn startup_file_from(args: impl Iterator<Item = OsString>) -> Option<String> {
    args.map(PathBuf::from)
        .find(|path| is_design_path(path) && path.is_file())
        .and_then(|path| std::path::absolute(path).ok())
        .and_then(|path| path.into_os_string().into_string().ok())
}

/// The design the app was launched with: the operating system passes the path
/// as an argument when a `.bashcad` file is double-clicked.
#[tauri::command]
fn startup_file() -> Option<String> {
    startup_file_from(std::env::args_os().skip(1))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_webkit_workarounds();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            startup_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static DIRS: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory per test, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = DIRS.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("bashcad-test-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn write_atomic_creates_and_overwrites() {
        let dir = TempDir::new();
        let file = dir.path("design.bashcad");
        write_atomic(&file, b"first").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"first");
        write_atomic(&file, b"second, longer").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"second, longer");
        assert_eq!(dir.names(), vec!["design.bashcad"]);
    }

    #[test]
    fn write_atomic_leaves_no_temporary_files() {
        let dir = TempDir::new();
        let file = dir.path("design.bashcad");
        for i in 0..5u8 {
            write_atomic(&file, &[i; 16]).unwrap();
        }
        assert_eq!(fs::read(&file).unwrap(), [4u8; 16]);
        assert_eq!(dir.names(), vec!["design.bashcad"]);
    }

    #[test]
    fn temp_siblings_never_collide() {
        // Two writes in flight at once (a version save and a Ctrl+S) must not
        // share a temporary name, or the second rename fails.
        let target = Path::new("/some/where/design.bashcad");
        let a = temp_sibling(target).unwrap();
        let b = temp_sibling(target).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.parent(), target.parent());
        let name = a.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(".design.bashcad.") && name.ends_with(".tmp"), "{name}");
    }

    #[test]
    fn write_atomic_fails_cleanly_when_its_temporary_exists() {
        // A left-over temporary of the same name is left alone and reported,
        // never truncated and never renamed over the design.
        let dir = TempDir::new();
        let file = dir.path("design.bashcad");
        fs::write(&file, b"kept").unwrap();
        let stale = dir.path(".design.bashcad.stale.tmp");
        fs::write(&stale, b"half written").unwrap();
        let opened = fs::OpenOptions::new().write(true).create_new(true).open(&stale);
        assert_eq!(opened.err().map(|e| e.kind()), Some(io::ErrorKind::AlreadyExists));
        assert_eq!(fs::read(&stale).unwrap(), b"half written");
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        fs::remove_file(&stale).unwrap();
        assert_eq!(dir.names(), vec!["design.bashcad"]);
    }

    #[test]
    fn write_atomic_concurrent_writes_to_one_target() {
        let dir = TempDir::new();
        let file = dir.path("design.bashcad");
        let handles: Vec<_> = (0..8u8)
            .map(|i| {
                let file = file.clone();
                std::thread::spawn(move || write_atomic(&file, &[i; 4096]))
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        let bytes = fs::read(&file).unwrap();
        assert_eq!(bytes.len(), 4096);
        assert!(bytes.iter().all(|b| *b == bytes[0]));
        assert_eq!(dir.names(), vec!["design.bashcad"]);
    }

    #[test]
    fn write_atomic_follows_symlinks() {
        let dir = TempDir::new();
        let real = dir.path("real.bashcad");
        fs::write(&real, b"old").unwrap();
        let link = dir.path("link.bashcad");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            write_atomic(&link, b"new").unwrap();
            assert_eq!(fs::read(&real).unwrap(), b"new");
            assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        }
    }

    #[test]
    fn write_atomic_rejects_a_bare_root() {
        assert!(write_atomic(Path::new("/"), b"x").is_err());
    }

    #[test]
    fn startup_file_accepts_only_designs() {
        let dir = TempDir::new();
        let design = dir.path("thing.bashcad");
        let upper = dir.path("THING.BASHCAD");
        let other = dir.path("notes.txt");
        let missing = dir.path("gone.bashcad");
        for file in [&design, &upper, &other] {
            fs::write(file, b"").unwrap();
        }
        let args = |items: &[&Path]| items.iter().map(|p| p.as_os_str().to_owned()).collect::<Vec<_>>().into_iter();

        assert_eq!(startup_file_from(args(&[&design])), Some(design.to_str().unwrap().to_owned()));
        assert_eq!(startup_file_from(args(&[&upper])), Some(upper.to_str().unwrap().to_owned()));
        assert_eq!(startup_file_from(args(&[&other])), None);
        assert_eq!(startup_file_from(args(&[&missing])), None);
        assert_eq!(startup_file_from(args(&[Path::new("--flag"), &other, &design])), Some(design.to_str().unwrap().to_owned()));
        assert_eq!(startup_file_from(args(&[Path::new("/etc/passwd")])), None);
        assert_eq!(startup_file_from(std::iter::empty()), None);
        assert!(!is_design_path(Path::new("design.bashcad.txt")));
        assert!(is_design_path(Path::new("Design.BashCad")));
    }
}
