// All modelling runs in the webview; the Rust side only provides the native
// window, the file dialogs, the projects folder and reading and writing files.
//
// Files go through the commands below rather than the fs plugin's own, whose
// scope would refuse a design passed on the command line: the app is a
// document editor, and may open whatever the user points it at. The fs plugin
// is still used from here to open what the Android pickers hand back, which
// are content URIs rather than paths.
use std::borrow::Cow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use tauri_plugin_opener::OpenerExt;

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
    // The folder is made on the way if need be (an export that goes into a folder of its own).
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
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

/// A path or, from the Android pickers, a `content://` URI.
fn file_path(path: &str) -> FilePath {
    let Ok(parsed) = FilePath::from_str(path);
    parsed
}

#[tauri::command]
async fn read_file(app: AppHandle, path: String) -> Result<Response, String> {
    let read = app.fs().read(file_path(&path));
    #[cfg(target_os = "android")]
    let read = read.or_else(|err| {
        // A file of the app's own in the shared storage that the path would not open is reached through the media store.
        match if path.contains("://") { None } else { tauri_plugin_device::find_document(&app, &path) } {
            Some(uri) => app.fs().read(file_path(&uri)),
            None => Err(err),
        }
    });
    read.map(Response::new).map_err(|err| format!("Could not read {path}: {err}"))
}

/// Where a file really is: a path names itself; the `content://` URIs the
/// Android pickers hand out do not (a download is `msf:123`), but the
/// descriptor the provider opens usually points at the real file. Null where
/// it cannot be told.
#[tauri::command]
fn real_path(app: AppHandle, path: String) -> Option<String> {
    let parsed = file_path(&path);
    if let Ok(path) = parsed.clone().into_path() {
        return Some(path.to_string_lossy().into_owned());
    }
    #[cfg(target_os = "android")]
    {
        use std::os::fd::AsRawFd;
        let mut options = OpenOptions::new();
        options.read(true);
        let file = app.fs().open(parsed, options).ok()?;
        let target = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()?;
        let target = target.to_string_lossy().into_owned();
        // The descriptor points into the system's own mount of the shared storage (`/mnt/user/0/emulated/0/…`),
        // which apps may not open; the same file is at `/storage/emulated/0/…`.
        return Some(match target.find("/emulated/") {
            Some(at) if !target.starts_with("/storage/") => format!("/storage{}", &target[at..]),
            _ => target,
        });
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        None
    }
}

/// The name of a file, extension included, or null if it has none.
#[tauri::command]
fn file_name(app: AppHandle, path: String) -> Option<String> {
    let real = real_path(app, path)?;
    Path::new(&real).file_name().map(|name| name.to_string_lossy().into_owned()).filter(|name| name.contains('.'))
}

/// A temporary file of the app's own holding `bytes`, for the device plugin to move into place.
#[cfg(target_os = "android")]
fn stage_bytes(app: &AppHandle, bytes: &[u8]) -> io::Result<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(io::Error::other)?;
    fs::create_dir_all(&dir)?;
    let stamp = UNIX_EPOCH.elapsed().map(|d| d.as_nanos()).unwrap_or(0);
    let source = dir.join(format!("document-{stamp}.tmp"));
    fs::write(&source, bytes)?;
    Ok(source)
}

/// Android: writes an export into the app's folder in Downloads. The bytes are
/// the request body; `folder`, `name` and `mime` travel in headers, percent-encoded.
#[tauri::command]
async fn save_export(app: AppHandle, request: Request<'_>) -> Result<tauri_plugin_device::Exported, String> {
    let header = |key: &str| request.headers().get(key).and_then(|value| percent_decode(value.as_bytes()));
    let (folder, name, mime) = (header("folder").unwrap_or_default(), header("name"), header("mime"));
    let (Some(name), Some(mime)) = (name, mime) else {
        return Err("Could not write the export: no name was given".into());
    };
    let bytes = body_bytes(request.body()).ok_or("Could not write the export: the data was not understood")?;
    #[cfg(target_os = "android")]
    {
        let source = stage_bytes(&app, &bytes).map_err(|err| format!("Could not write {name}: {err}"))?;
        return tauri_plugin_device::export_to_downloads(&app, &folder, &name, &mime, &source).map_err(|err| format!("Could not write {name}: {err}"));
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, folder, name, mime, bytes);
        Err("Exports go to Downloads only on Android".into())
    }
}

/// Writes the request body into `share/<name>` under the app's cache folder,
/// for the device plugin to hand to other apps, and returns its path. The
/// name travels in a header, percent-encoded. Earlier staged files go.
#[tauri::command]
async fn stage_share(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let name = request
        .headers()
        .get("name")
        .and_then(|value| percent_decode(value.as_bytes()))
        .filter(|name| !name.is_empty() && !name.contains(['/', '\\']))
        .ok_or("Could not prepare the file to share: no valid name was given")?;
    let bytes = body_bytes(request.body()).ok_or_else(|| format!("Could not prepare {name}: the data was not bytes"))?;
    let dir = app.path().app_cache_dir().map_err(|err| format!("Could not prepare {name}: {err}"))?.join("share");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|err| format!("Could not prepare {name}: {err}"))?;
    let path = dir.join(&name);
    fs::write(&path, &bytes).map_err(|err| format!("Could not prepare {name}: {err}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The first `limit` bytes of a file: enough of a design to read its header
/// without loading the meshes it may carry.
#[tauri::command]
async fn read_head(path: String, limit: u64) -> Result<Response, String> {
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|file| file.take(limit).read_to_end(&mut bytes))
        .map(|_| Response::new(bytes))
        .map_err(|err| format!("Could not read {path}: {err}"))
}

fn write_bytes(app: &AppHandle, path: &str, bytes: &[u8]) -> io::Result<()> {
    let parsed = file_path(path);
    match parsed.clone().into_path() {
        Ok(path) => write_atomic(&path, bytes),
        Err(_) => write_document(app, path, bytes),
    }
}

/// A document picked on Android: the bytes go to a file of the app's own
/// first, and the plugin copies them in through the document's provider, so
/// the provider learns the new size (through a raw descriptor it would not,
/// and the Files app would show the export as 0 B).
#[cfg(target_os = "android")]
fn write_document(app: &AppHandle, uri: &str, bytes: &[u8]) -> io::Result<()> {
    let source = stage_bytes(app, bytes)?;
    tauri_plugin_device::write_document(app, uri, &source).map_err(io::Error::other)
}

#[cfg(not(target_os = "android"))]
fn write_document(app: &AppHandle, uri: &str, bytes: &[u8]) -> io::Result<()> {
    // Elsewhere a URL names a file; written through the descriptor the fs plugin opens.
    let mut options = OpenOptions::new();
    options.read(false).write(true).truncate(true).create(true);
    let mut file = app.fs().open(file_path(uri), options)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// The bytes of a request body: raw, or, where the webview cannot post a
/// binary body and Tauri falls back to a JSON array of numbers, those.
fn body_bytes(body: &InvokeBody) -> Option<Cow<'_, [u8]>> {
    match body {
        InvokeBody::Raw(bytes) => Some(Cow::Borrowed(bytes)),
        InvokeBody::Json(value) => value
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok()))
                    .collect::<Option<Vec<u8>>>()
            })
            .map(Cow::Owned),
    }
}

/// The file's bytes are the request body and its path is in the `path` header,
/// which spares a multi-megabyte design a round trip through JSON.
#[tauri::command]
async fn write_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|value| percent_decode(value.as_bytes()))
        .ok_or("Could not write the file: no valid path was given")?;
    let bytes = body_bytes(request.body()).ok_or_else(|| format!("Could not write {path}: the data was not bytes"))?;
    write_bytes(&app, &path, &bytes).map_err(|err| format!("Could not write {path}: {err}"))
}

/// A design in the projects folder, as the projects browser lists it.
#[derive(Serialize, Debug, PartialEq)]
struct DesignEntry {
    name: String,
    path: String,
    size: u64,
    /// Milliseconds since the epoch; 0 where the file system keeps no time.
    modified: f64,
}

/// The designs directly inside `dir`, which is created if it does not exist.
/// Hidden files (the temporaries of writes under way among them) are left out.
fn designs_in(dir: &Path) -> io::Result<Vec<DesignEntry>> {
    fs::create_dir_all(dir)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !is_design_path(&path) {
            continue;
        }
        // Follows symlinks, so a linked design counts and a linked folder does not.
        let Ok(meta) = fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |since| since.as_millis() as f64);
        out.push(DesignEntry { name, path: path.to_string_lossy().into_owned(), size: meta.len(), modified });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
async fn list_designs(dir: String) -> Result<Vec<DesignEntry>, String> {
    designs_in(Path::new(&dir)).map_err(|err| format!("Could not read the projects folder {dir}: {err}"))
}

#[tauri::command]
async fn remove_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|err| format!("Could not delete {path}: {err}"))
}

/// Moves a file, within a folder or to another one, never over an existing file.
fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "a file of that name already exists"));
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Another file system: copy, then remove the original once the copy is whole.
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(from, to)?;
    fs::remove_file(from)
}

#[tauri::command]
async fn move_file(from: String, to: String) -> Result<(), String> {
    move_path(Path::new(&from), Path::new(&to)).map_err(|err| format!("Could not move {from} to {to}: {err}"))
}

/// Where projects live unless the user chose another folder.
#[derive(Serialize)]
struct ProjectsHome {
    path: String,
    /// Whether the folder can be changed: on Android projects stay in the app's own storage.
    fixed: bool,
}

#[tauri::command]
fn default_projects_dir(app: AppHandle) -> Result<ProjectsHome, String> {
    let paths = app.path();
    #[cfg(mobile)]
    let (dir, fixed) = (paths.app_data_dir().map(|dir| dir.join("projects")), true);
    #[cfg(not(mobile))]
    let (dir, fixed) = (
        paths
            .document_dir()
            .map(|dir| dir.join("BashCAD"))
            .or_else(|_| paths.app_data_dir().map(|dir| dir.join("projects"))),
        false,
    );
    dir.map_err(|err| format!("Could not find a place for projects: {err}"))
        .and_then(|dir| dir.into_os_string().into_string().map_err(|_| "The projects folder has an unreadable name".to_owned()))
        .map(|path| ProjectsHome { path, fixed })
}

// --- signing in to a cloud account -------------------------------------------
//
// OAuth for an installed app: the sign-in page opens in the system browser and
// sends the browser back to a loopback address the app listens on for a
// moment. The webview does the rest (token exchange, PKCE) over HTTPS.

/// Sign-ins waiting for the browser to come back, by port.
#[derive(Default)]
struct SignIns(Mutex<HashMap<u16, (TcpListener, Arc<AtomicBool>)>>);

/// How long the browser is given before the sign-in is abandoned.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// Listens on a free loopback port and returns it, for the redirect address.
#[tauri::command]
fn oauth_start(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| format!("Could not listen for the sign-in: {err}"))?;
    listener.set_nonblocking(true).map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    app.state::<SignIns>().0.lock().unwrap().insert(port, (listener, Arc::new(AtomicBool::new(false))));
    Ok(port)
}

/// Opens the sign-in page and waits for the browser to be sent back to the port; returns that request's query string.
#[tauri::command]
async fn oauth_wait(app: AppHandle, port: u16, url: String) -> Result<String, String> {
    let (listener, cancelled) = app
        .state::<SignIns>()
        .0
        .lock()
        .unwrap()
        .remove(&port)
        .ok_or("No sign-in is waiting on that port")?;
    // Cancel can still reach it while it waits.
    app.state::<SignIns>().0.lock().unwrap().insert(port, (listener.try_clone().map_err(|err| err.to_string())?, cancelled.clone()));
    app.opener().open_url(&url, None::<&str>).map_err(|err| format!("Could not open the browser: {err}"))?;
    let result = tauri::async_runtime::spawn_blocking(move || wait_for_redirect(&listener, &cancelled, SIGN_IN_TIMEOUT))
        .await
        .map_err(|err| err.to_string())?;
    app.state::<SignIns>().0.lock().unwrap().remove(&port);
    result.map_err(|err| err.to_string())
}

/// Gives up a sign-in that is waiting.
#[tauri::command]
fn oauth_cancel(app: AppHandle, port: u16) {
    if let Some((_, cancelled)) = app.state::<SignIns>().0.lock().unwrap().get(&port) {
        cancelled.store(true, Ordering::Relaxed);
    }
}

/// Accepts connections until one is the browser coming back with a query (a `code` or an `error`), the cancel flag is set, or the time is up.
fn wait_for_redirect(listener: &TcpListener, cancelled: &AtomicBool, timeout: Duration) -> io::Result<String> {
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(query) = answer_browser(stream)? {
                    return Ok(query);
                }
            }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "The sign-in was cancelled"));
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "The sign-in took too long. Try again."));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(err),
        }
    }
}

/// Reads one request; answers with a page to close when it carries the sign-in's query, 404 otherwise (a favicon request, say).
fn answer_browser(mut stream: TcpStream) -> io::Result<Option<String>> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_nonblocking(false)?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buffer.windows(4).any(|w| w == b"\r\n\r\n") && buffer.len() < 16 * 1024 {
        let n = match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(err) if err.kind() == io::ErrorKind::WouldBlock || err.kind() == io::ErrorKind::TimedOut => break,
            Err(err) => return Err(err),
        };
        buffer.extend_from_slice(&chunk[..n]);
    }
    let request = String::from_utf8_lossy(&buffer);
    let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
    let query = target.split_once('?').map(|(_, q)| q.to_owned());
    let ours = query.as_deref().is_some_and(|q| q.split('&').any(|p| p.starts_with("code=") || p.starts_with("error=")));
    let (status, body) = if ours {
        ("200 OK", "<!doctype html><meta charset=utf-8><title>BashCAD</title><body style=\"font-family:sans-serif;padding:2em\"><h2>Signed in</h2><p>You can close this page and go back to BashCAD.</p>")
    } else {
        ("404 Not Found", "")
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.flush();
    Ok(if ours { query } else { None })
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_device::init())
        .manage(SignIns::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            file_name,
            real_path,
            save_export,
            stage_share,
            read_head,
            write_file,
            list_designs,
            remove_file,
            move_file,
            default_projects_dir,
            oauth_start,
            oauth_wait,
            oauth_cancel,
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
    fn designs_in_lists_designs_only() {
        let dir = TempDir::new();
        fs::write(dir.path("b.bashcad"), b"{}").unwrap();
        fs::write(dir.path("A.BashCAD"), b"{}").unwrap();
        fs::write(dir.path("notes.txt"), b"").unwrap();
        fs::write(dir.path(".a.bashcad.123.0.tmp"), b"").unwrap();
        fs::create_dir(dir.path("folder.bashcad")).unwrap();
        let listed = designs_in(&dir.0).unwrap();
        let names: Vec<&str> = listed.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["A.BashCAD", "b.bashcad"]);
        assert_eq!(listed[1].size, 2);
        assert!(listed[1].modified > 0.0);
        assert_eq!(Path::new(&listed[1].path), dir.path("b.bashcad"));
    }

    #[test]
    fn designs_in_creates_a_missing_folder() {
        let dir = TempDir::new();
        let nested = dir.path("new").join("projects");
        assert_eq!(designs_in(&nested).unwrap(), vec![]);
        assert!(nested.is_dir());
    }

    #[test]
    fn move_path_renames_but_never_overwrites() {
        let dir = TempDir::new();
        let from = dir.path("a.bashcad");
        let to = dir.path("b.bashcad");
        fs::write(&from, b"a").unwrap();
        move_path(&from, &to).unwrap();
        assert_eq!(dir.names(), vec!["b.bashcad"]);
        fs::write(&from, b"again").unwrap();
        let err = move_path(&from, &to).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&to).unwrap(), b"a");
        // Into a folder that does not exist yet.
        let deep = dir.path("sub").join("c.bashcad");
        move_path(&from, &deep).unwrap();
        assert_eq!(fs::read(&deep).unwrap(), b"again");
    }

    #[test]
    fn sign_in_redirect_is_read_and_strays_ignored() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            let send = |request: &str| {
                let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
                s.write_all(request.as_bytes()).unwrap();
                let mut reply = String::new();
                s.read_to_string(&mut reply).unwrap();
                reply
            };
            let stray = send("GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n");
            let ours = send("GET /?state=abc&code=4%2Fxyz HTTP/1.1\r\nHost: x\r\n\r\n");
            (stray, ours)
        });
        let query = wait_for_redirect(&listener, &AtomicBool::new(false), Duration::from_secs(5)).unwrap();
        assert_eq!(query, "state=abc&code=4%2Fxyz");
        let (stray, ours) = browser.join().unwrap();
        assert!(stray.starts_with("HTTP/1.1 404"));
        assert!(ours.starts_with("HTTP/1.1 200") && ours.contains("go back to BashCAD"));
    }

    #[test]
    fn sign_in_wait_can_be_cancelled_and_times_out() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            flag.store(true, Ordering::Relaxed);
        });
        let err = wait_for_redirect(&listener, &cancelled, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);
        let err = wait_for_redirect(&listener, &AtomicBool::new(false), Duration::from_millis(50)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
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
