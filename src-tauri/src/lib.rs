// All modelling runs in the webview; the Rust side only provides the native
// window, the file dialogs, the projects folder and reading and writing files.
//
// Files go through the commands below rather than the fs plugin's own, whose
// scope would refuse a design passed on the command line: the app is a
// document editor, and may open whatever the user points it at. The fs plugin
// is still used from here to open what the Android pickers hand back, which
// are content URIs rather than paths.
//
// What the commands will touch is limited by kind instead of by place: the
// webview can read the kinds of file the app opens, write the kinds it saves,
// and move or delete designs, and nothing else. Should a script ever run in
// the webview that is not the app's own, it cannot read a key or a browser
// profile, nor write a start-up script.
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
#[cfg(desktop)]
use tauri::Emitter;
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

/// The extension of a design file, and the one from before the app was PlastikCAD.
const DESIGN_EXTENSION: &str = "plastikcad";
const OLD_DESIGN_EXTENSION: &str = "bashcad";
/// What the app opens: designs, the models, drawings and pictures it imports, and what those name beside them
/// (a material library, the data of a glTF file), or an archive of them. Kept in step with the app's own lists by `src/nativeKinds.test.ts`.
const READABLE: &[&str] = &[
    DESIGN_EXTENSION, OLD_DESIGN_EXTENSION, "stl", "obj", "mtl", "3mf", "glb", "gltf", "bin", "dae", "ply", "step", "stp", "svg", "dxf", "urdf", "xacro", "png", "jpg", "jpeg", "zip",
];
/// What the app saves: designs and exports.
const WRITABLE: &[&str] = &[DESIGN_EXTENSION, "stl", "3mf", "obj", "mtl", "ply", "glb", "step", "svg", "dxf", "zip"];
const DESIGNS: &[&str] = &[DESIGN_EXTENSION, OLD_DESIGN_EXTENSION];

/// Whether a path names a file of one of `kinds`, by its extension, whatever its case. A hidden file is none of them.
fn is_kind(path: &Path, kinds: &[&str]) -> bool {
    let hidden = path.file_name().is_none_or(|name| name.to_string_lossy().starts_with('.'));
    !hidden && path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| kinds.iter().any(|kind| ext.eq_ignore_ascii_case(kind)))
}

/// Refuses a path that is not a file of one of `kinds`. What an Android picker hands out is a `content://` URI with
/// no name to go by, and is the user's own choice of document, granted by the system: those pass, there. Any other
/// URL is refused, since what it names is not what its last letters say.
///
/// Whether the string is a URL is asked of `file_path`, which is what then opens the file: told apart here by a rule
/// of its own (the letters `://`), a `file:` URL written with one slash passed as a path named after its query
/// (`file:/etc/passwd?x.stl`) and was opened as the file before the question mark.
fn allowed(path: &str, kinds: &[&str], doing: &str) -> Result<(), String> {
    let document = cfg!(target_os = "android") && path.starts_with("content://");
    let plain = match file_path(path) {
        FilePath::Path(plain) => Some(plain),
        FilePath::Url(_) => None,
    };
    if document || plain.is_some_and(|plain| is_kind(&plain, kinds)) {
        return Ok(());
    }
    let name = Path::new(path).file_name().map_or_else(|| path.to_owned(), |name| name.to_string_lossy().into_owned());
    Err(format!("Could not {doing} {name}: PlastikCAD does not {doing} this kind of file"))
}

#[tauri::command]
async fn read_file(app: AppHandle, path: String) -> Result<Response, String> {
    allowed(&path, READABLE, "open")?;
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
async fn real_path(app: AppHandle, path: String) -> Option<String> {
    real_path_of(&app, &path)
}

fn real_path_of(app: &AppHandle, path: &str) -> Option<String> {
    let parsed = file_path(path);
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
async fn file_name(app: AppHandle, path: String) -> Option<String> {
    let real = real_path_of(&app, &path)?;
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
        // A name and nothing else: no folder, and no drive (`C:name` would land beside the working folder on Windows).
        .filter(|name| !name.is_empty() && !name.contains(['/', '\\', ':']) && is_kind(Path::new(name), WRITABLE))
        .ok_or("Could not prepare the file to share: no valid name was given")?;
    let bytes = body_bytes(request.body()).ok_or_else(|| format!("Could not prepare {name}: the data was not bytes"))?;
    let dir = app.path().app_cache_dir().map_err(|err| format!("Could not prepare {name}: {err}"))?.join("share");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|err| format!("Could not prepare {name}: {err}"))?;
    let path = dir.join(&name);
    fs::write(&path, &bytes).map_err(|err| format!("Could not prepare {name}: {err}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Deletes a file the user asked to be rid of (the original of a design brought in as a project).
#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !is_kind(target, DESIGNS) {
        return Err(format!("Could not delete {path}: it is not a design"));
    }
    if !target.is_file() {
        return Err(format!("Could not delete {path}: it is not a file"));
    }
    fs::remove_file(target).map_err(|err| format!("Could not delete {path}: {err}"))
}

/// The first `limit` bytes of a file: enough of a design to read its header
/// without loading the meshes it may carry.
#[tauri::command]
async fn read_head(path: String, limit: u64) -> Result<Response, String> {
    if !is_kind(Path::new(&path), DESIGNS) {
        return Err(format!("Could not read {path}: it is not a design"));
    }
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
    allowed(&path, WRITABLE, "save")?;
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
    if !is_kind(Path::new(&path), DESIGNS) {
        return Err(format!("Could not delete {path}: it is not a design"));
    }
    fs::remove_file(&path).map_err(|err| format!("Could not delete {path}: {err}"))
}

/// Moves a design, within a folder or to another one, never over an existing file.
fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if !is_kind(from, DESIGNS) || !is_kind(to, DESIGNS) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "only designs are moved"));
    }
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "a file of that name already exists"));
    }
    // The folder is made on the way if need be (the trash, the first time something goes into it).
    if let Some(parent) = to.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Another file system: copy, then remove the original once the copy is whole.
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

/// Renames the projects folder of the app's old name to its new one, and the
/// `.bashcad` files in it to `.plastikcad`, when the new folder does not exist
/// yet. Anything that cannot be renamed is left where it is: the old names
/// still open.
#[cfg(not(mobile))]
fn adopt_old_folder(old: &Path, new: &Path) {
    if new.exists() || !old.is_dir() || fs::rename(old, new).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(new) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_old = path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case(OLD_DESIGN_EXTENSION));
        if !is_old || !path.is_file() {
            continue;
        }
        let renamed = path.with_extension(DESIGN_EXTENSION);
        if !renamed.exists() {
            let _ = fs::rename(&path, &renamed);
        }
    }
}

#[tauri::command]
async fn default_projects_dir(app: AppHandle) -> Result<ProjectsHome, String> {
    let paths = app.path();
    #[cfg(mobile)]
    let (dir, fixed) = (paths.app_data_dir().map(|dir| dir.join("projects")), true);
    #[cfg(not(mobile))]
    let (dir, fixed) = (
        paths
            .document_dir()
            .map(|dir| {
                // Projects kept by the app under its old name move over, once.
                adopt_old_folder(&dir.join("BashCAD"), &dir.join("PlastikCAD"));
                dir.join("PlastikCAD")
            })
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
/// Where every sign-in starts.
const SIGN_IN_PAGE: &str = "https://accounts.google.com/";

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
    // The one page this opens is Google's sign-in.
    if !url.starts_with(SIGN_IN_PAGE) {
        return Err("Could not open the sign-in page: it is not Google's".into());
    }
    // Cancel can still reach it while it waits.
    app.state::<SignIns>().0.lock().unwrap().insert(port, (listener.try_clone().map_err(|err| err.to_string())?, cancelled.clone()));
    if let Err(err) = app.opener().open_url(&url, None::<&str>) {
        app.state::<SignIns>().0.lock().unwrap().remove(&port);
        return Err(format!("Could not open the browser: {err}"));
    }
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
                // A connection that breaks off, or is not the browser at all, is not the end of the sign-in.
                if let Ok(Some(query)) = answer_browser(stream) {
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
    let has = |key: &str| query.as_deref().is_some_and(|q| q.split('&').any(|p| p.starts_with(key)));
    let ours = has("code=") || has("error=");
    let (status, body) = if has("error=") {
        ("200 OK", "<!doctype html><meta charset=utf-8><title>PlastikCAD</title><body style=\"font-family:sans-serif;padding:2em\"><h2>Not signed in</h2><p>Google did not grant access. You can close this page and try again from PlastikCAD.</p>")
    } else if ours {
        ("200 OK", "<!doctype html><meta charset=utf-8><title>PlastikCAD</title><body style=\"font-family:sans-serif;padding:2em\"><h2>Signed in</h2><p>You can close this page and go back to PlastikCAD.</p>")
    } else {
        ("404 Not Found", "")
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.flush();
    Ok(if ours { query } else { None })
}

/// Only a design may be opened from the command line: a `.plastikcad` (or an
/// old `.bashcad`) file, whatever its case. Anything else on the command line (a flag, a stray
/// document) is ignored.
fn is_design_path(path: &Path) -> bool {
    is_kind(path, DESIGNS)
}

/// The first argument naming an existing design, made absolute.
fn startup_file_from(args: impl Iterator<Item = OsString>) -> Option<String> {
    args.map(PathBuf::from)
        .find(|path| is_design_path(path) && path.is_file())
        .and_then(|path| std::path::absolute(path).ok())
        .and_then(|path| path.into_os_string().into_string().ok())
}

/// The design the app was launched with: the operating system passes the path
/// as an argument when a `.plastikcad` file is double-clicked.
#[tauri::command]
fn startup_file() -> Option<String> {
    startup_file_from(std::env::args_os().skip(1))
}

/// Designs handed to the app once it runs: by a second launch, which hands
/// its arguments over and quits rather than open the same projects folder in
/// a second window, and by macOS, which opens a file by event, not argument.
#[derive(Default)]
struct Opened(Mutex<Vec<String>>);

/// The existing designs among `args`, each made absolute against the folder it was given in.
#[cfg(desktop)]
fn designs_among(args: impl Iterator<Item = OsString>, cwd: &Path) -> Vec<String> {
    args.map(PathBuf::from)
        .map(|path| if path.is_absolute() { path } else { cwd.join(path) })
        .filter(|path| is_design_path(path) && path.is_file())
        .filter_map(|path| path.into_os_string().into_string().ok())
        .collect()
}

/// Queues designs for the webview, tells it some are waiting, and brings the window forward.
#[cfg(desktop)]
fn hand_over(app: &AppHandle, paths: Vec<String>) {
    if !paths.is_empty() {
        app.state::<Opened>().0.lock().unwrap().extend(paths);
        let _ = app.emit("opened", ());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The designs handed over since this was last asked.
#[tauri::command]
fn opened_files(app: AppHandle) -> Vec<String> {
    std::mem::take(&mut *app.state::<Opened>().0.lock().unwrap())
}

/// What the app keeps in the system's keychain goes under its own name there; the one thing it keeps is the Google sign-in.
#[cfg(desktop)]
const KEYCHAIN_SERVICE: &str = "com.sheidesigns.plastikcad";
#[cfg(desktop)]
const SIGN_IN_ENTRY: &str = "google-drive";

/// An entry of the app's in the system's keychain: read (nothing when there is none), written, removed (none there is no error).
#[cfg(desktop)]
mod keychain {
    use super::KEYCHAIN_SERVICE;
    use keyring::{Entry, Error, Result};

    pub fn read(account: &str) -> Result<Option<String>> {
        match Entry::new(KEYCHAIN_SERVICE, account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(err) => Err(err),
        }
    }

    pub fn write(account: &str, secret: &str) -> Result<()> {
        Entry::new(KEYCHAIN_SERVICE, account)?.set_password(secret)
    }

    pub fn remove(account: &str) -> Result<()> {
        match Entry::new(KEYCHAIN_SERVICE, account)?.delete_credential() {
            Err(Error::NoEntry) => Ok(()),
            done => done,
        }
    }
}

/// A call to the keychain, off the thread the window runs on: the system may put a box up (to unlock the keychain) and wait on it.
#[cfg(desktop)]
async fn in_keychain<T: Send + 'static>(call: impl FnOnce() -> keyring::Result<T> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || call().map_err(|err| format!("Could not use the system keychain: {err}")))
        .await
        .map_err(|err| err.to_string())?
}

/// The sign-in kept in the system's keychain, or nothing when none is kept. An error when there is
/// no keychain to ask (a Linux session without one, the Android app): the app then keeps the
/// sign-in in its own storage, as it did before.
#[tauri::command]
async fn secret_read() -> Result<Option<String>, String> {
    #[cfg(desktop)]
    return in_keychain(|| keychain::read(SIGN_IN_ENTRY)).await;
    #[cfg(mobile)]
    Err("There is no system keychain here".into())
}

/// Keeps the sign-in in the system's keychain, in place of any that was there.
#[tauri::command]
async fn secret_write(secret: String) -> Result<(), String> {
    #[cfg(desktop)]
    return in_keychain(move || keychain::write(SIGN_IN_ENTRY, &secret)).await;
    #[cfg(mobile)]
    {
        let _ = secret;
        Err("There is no system keychain here".into())
    }
}

/// Takes the sign-in out of the system's keychain.
#[tauri::command]
async fn secret_remove() -> Result<(), String> {
    #[cfg(desktop)]
    return in_keychain(|| keychain::remove(SIGN_IN_ENTRY)).await;
    #[cfg(mobile)]
    Err("There is no system keychain here".into())
}

/// Where the releases are: the one page `open_releases` opens.
const RELEASES_PAGE: &str = "https://github.com/Shei-Designs/PlastikCAD/releases/latest";

/// Whether this copy of the app can put a newer version in its own place. On Windows and macOS it
/// can. On Linux only an AppImage can: one installed as a package (.deb, .rpm) is the system's to
/// update, and the app points to the releases page instead. Never on Android, where the store does it.
#[tauri::command]
fn can_self_update() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        cfg!(desktop)
    }
}

/// Starts the app again, once an update is in place.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

/// Opens the releases page in the browser, for a copy of the app that cannot update itself.
#[tauri::command]
fn open_releases(app: AppHandle) -> Result<(), String> {
    app.opener().open_url(RELEASES_PAGE, None::<&str>).map_err(|err| format!("Could not open the browser: {err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_webkit_workarounds();

    let builder = tauri::Builder::default();
    // First among the plugins, so that a second launch is turned away before anything else starts up.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        hand_over(app, designs_among(args.into_iter().skip(1).map(OsString::from), Path::new(&cwd)));
    }));
    // Looks for a newer version among the releases and installs it (see src/update.ts); the key it checks one against is in tauri.conf.json.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_device::init())
        .manage(SignIns::default())
        .manage(Opened::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            file_name,
            real_path,
            save_export,
            stage_share,
            delete_file,
            read_head,
            write_file,
            list_designs,
            remove_file,
            move_file,
            default_projects_dir,
            oauth_start,
            oauth_wait,
            oauth_cancel,
            startup_file,
            opened_files,
            can_self_update,
            relaunch,
            open_releases,
            secret_read,
            secret_write,
            secret_remove
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // macOS opens a double-clicked design by event, at launch and afterwards alike.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| is_design_path(path))
                    .filter_map(|path| path.into_os_string().into_string().ok())
                    .collect();
                hand_over(_app, paths);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the real keychain of the session, so only where there is one: `cargo test -- --ignored keychain`.
    /// It uses an entry of its own, never the sign-in's.
    #[test]
    #[ignore = "needs a system keychain (a desktop session); CI has none"]
    #[cfg(desktop)]
    fn keychain_keeps_reads_replaces_and_removes_an_entry() {
        let entry = "test-round-trip";
        keychain::remove(entry).unwrap();
        assert_eq!(keychain::read(entry).unwrap(), None);
        keychain::write(entry, "first, with \u{e9} and \"quotes\"").unwrap();
        assert_eq!(keychain::read(entry).unwrap().as_deref(), Some("first, with \u{e9} and \"quotes\""));
        // As long as a sign-in is: a refresh token, an access token and the rest, as JSON.
        let long = "x".repeat(4000);
        keychain::write(entry, &long).unwrap();
        assert_eq!(keychain::read(entry).unwrap(), Some(long));
        keychain::remove(entry).unwrap();
        assert_eq!(keychain::read(entry).unwrap(), None);
        // Removing what is not there is no error.
        keychain::remove(entry).unwrap();
    }
    use std::sync::atomic::AtomicUsize;

    static DIRS: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory per test, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = DIRS.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("plastikcad-test-{}-{n}", std::process::id()));
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
        let file = dir.path("design.plastikcad");
        write_atomic(&file, b"first").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"first");
        write_atomic(&file, b"second, longer").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"second, longer");
        assert_eq!(dir.names(), vec!["design.plastikcad"]);
    }

    #[test]
    fn write_atomic_leaves_no_temporary_files() {
        let dir = TempDir::new();
        let file = dir.path("design.plastikcad");
        for i in 0..5u8 {
            write_atomic(&file, &[i; 16]).unwrap();
        }
        assert_eq!(fs::read(&file).unwrap(), [4u8; 16]);
        assert_eq!(dir.names(), vec!["design.plastikcad"]);
    }

    #[test]
    fn temp_siblings_never_collide() {
        // Two writes in flight at once (a version save and a Ctrl+S) must not
        // share a temporary name, or the second rename fails.
        let target = Path::new("/some/where/design.plastikcad");
        let a = temp_sibling(target).unwrap();
        let b = temp_sibling(target).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.parent(), target.parent());
        let name = a.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(".design.plastikcad.") && name.ends_with(".tmp"), "{name}");
    }

    #[test]
    fn write_atomic_fails_cleanly_when_its_temporary_exists() {
        // A left-over temporary of the same name is left alone and reported,
        // never truncated and never renamed over the design.
        let dir = TempDir::new();
        let file = dir.path("design.plastikcad");
        fs::write(&file, b"kept").unwrap();
        let stale = dir.path(".design.plastikcad.stale.tmp");
        fs::write(&stale, b"half written").unwrap();
        let opened = fs::OpenOptions::new().write(true).create_new(true).open(&stale);
        assert_eq!(opened.err().map(|e| e.kind()), Some(io::ErrorKind::AlreadyExists));
        assert_eq!(fs::read(&stale).unwrap(), b"half written");
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        fs::remove_file(&stale).unwrap();
        assert_eq!(dir.names(), vec!["design.plastikcad"]);
    }

    #[test]
    fn write_atomic_concurrent_writes_to_one_target() {
        let dir = TempDir::new();
        let file = dir.path("design.plastikcad");
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
        assert_eq!(dir.names(), vec!["design.plastikcad"]);
    }

    #[test]
    fn write_atomic_follows_symlinks() {
        let dir = TempDir::new();
        let real = dir.path("real.plastikcad");
        fs::write(&real, b"old").unwrap();
        let link = dir.path("link.plastikcad");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            write_atomic(&link, b"new").unwrap();
            assert_eq!(fs::read(&real).unwrap(), b"new");
            assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        }
    }

    #[test]
    fn only_the_kinds_of_file_the_app_handles_pass() {
        assert!(allowed("/home/me/Documents/part.STL", READABLE, "open").is_ok());
        assert!(allowed("C:\\Users\\me\\robot.urdf", READABLE, "open").is_ok());
        // What came with the newer importers: a STEP file under either ending, and the data a glTF file names.
        for path in ["/home/me/bracket.step", "/home/me/bracket.STP", "/home/me/scene.bin"] {
            assert!(allowed(path, READABLE, "open").is_ok(), "{path}");
        }
        assert!(allowed("/home/me/bracket.step", WRITABLE, "save").is_ok());
        assert!(allowed("/home/me/Documents/PlastikCAD/Box.plastikcad", WRITABLE, "save").is_ok());
        assert!(allowed("/home/me/export.zip", WRITABLE, "save").is_ok());
        // Keys, profiles and start-up scripts are none of them, whatever they are dressed as.
        for path in ["/home/me/.ssh/id_rsa", "/etc/passwd", "/home/me/.bashrc", "/home/me/notes.txt", "/home/me/.hidden.stl", "/home/me/stl", ""] {
            assert!(allowed(path, READABLE, "open").is_err(), "{path}");
            assert!(allowed(path, WRITABLE, "save").is_err(), "{path}");
        }
        for path in ["/home/me/.config/autostart/run.desktop", "/home/me/run.sh", "/home/me/picture.png", "/home/me/robot.urdf"] {
            assert!(allowed(path, WRITABLE, "save").is_err(), "{path}");
        }
        // A URL names what its path says, not what it ends in; only Android's documents are taken on trust.
        assert!(allowed("file:///etc/passwd?x.stl", READABLE, "open").is_err());
        assert!(allowed("file:///home/me/part.stl", READABLE, "open").is_err());
        // However it is written: with one slash or none, with the kind in a query or after a hash, in any case.
        for path in [
            "file:/etc/passwd?x.stl",
            "file:/home/me/.bashrc?/x.stl",
            "file:/home/me/.ssh/id_ed25519#/a.png",
            "FILE:/etc/passwd?x.stl",
            "file:etc/passwd?x.stl",
            "file://localhost/etc/passwd?x.stl",
            "http://example.com/part.stl",
            "data:text/plain,part.stl",
        ] {
            assert!(allowed(path, READABLE, "open").is_err(), "{path}");
            assert!(allowed(path, WRITABLE, "save").is_err(), "{path}");
        }
        // What is allowed is opened as the very path that was judged.
        for path in ["/home/me/Documents/part.STL", "C:\\Users\\me\\robot.urdf", "relative/part.stl", "/home/me/odd?name.stl"] {
            assert!(allowed(path, READABLE, "open").is_ok(), "{path}");
            assert_eq!(file_path(path).into_path().unwrap(), PathBuf::from(path), "{path}");
        }
        assert_eq!(allowed("content://com.android.providers/document/1", READABLE, "open").is_ok(), cfg!(target_os = "android"));
        assert_eq!(
            allowed("/home/me/notes.txt", READABLE, "open").unwrap_err(),
            "Could not open notes.txt: PlastikCAD does not open this kind of file"
        );
    }

    #[cfg(desktop)]
    #[test]
    fn a_second_launch_hands_over_only_existing_designs_made_absolute() {
        let dir = TempDir::new();
        fs::write(dir.path("Box.plastikcad"), b"{}").unwrap();
        fs::write(dir.path("notes.txt"), b"x").unwrap();
        let args = ["--flag", "Box.plastikcad", "notes.txt", "Gone.plastikcad"].map(OsString::from);
        let found = designs_among(args.into_iter(), &dir.0);
        assert_eq!(found, vec![dir.path("Box.plastikcad").to_string_lossy().into_owned()]);
        let absolute = [dir.path("Box.plastikcad").into_os_string()];
        assert_eq!(designs_among(absolute.into_iter(), Path::new("/elsewhere")), found);
    }

    #[test]
    fn only_designs_are_moved_or_deleted() {
        let dir = TempDir::new();
        let notes = dir.path("notes.txt");
        fs::write(&notes, b"keep").unwrap();
        let design = dir.path("Box.plastikcad");
        fs::write(&design, b"{}").unwrap();
        assert!(move_path(&notes, &dir.path("notes.plastikcad")).is_err());
        assert!(move_path(&design, &dir.path("Box.txt")).is_err());
        assert!(move_path(&design, &dir.path(".Box.plastikcad")).is_err());
        assert_eq!(dir.names(), vec!["Box.plastikcad", "notes.txt"]);
        // Into a folder that is not there yet, as the first design into the trash goes.
        move_path(&design, &dir.path("Trash").join("Box.plastikcad")).unwrap();
        assert_eq!(dir.names(), vec!["Trash", "notes.txt"]);
        assert!(dir.path("Trash").join("Box.plastikcad").is_file());
    }

    #[test]
    fn write_atomic_rejects_a_bare_root() {
        assert!(write_atomic(Path::new("/"), b"x").is_err());
    }

    #[test]
    fn designs_in_lists_designs_only() {
        let dir = TempDir::new();
        fs::write(dir.path("b.plastikcad"), b"{}").unwrap();
        fs::write(dir.path("A.PlastikCAD"), b"{}").unwrap();
        fs::write(dir.path("notes.txt"), b"").unwrap();
        fs::write(dir.path(".a.plastikcad.123.0.tmp"), b"").unwrap();
        fs::create_dir(dir.path("folder.plastikcad")).unwrap();
        let listed = designs_in(&dir.0).unwrap();
        let names: Vec<&str> = listed.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["A.PlastikCAD", "b.plastikcad"]);
        assert_eq!(listed[1].size, 2);
        assert!(listed[1].modified > 0.0);
        assert_eq!(Path::new(&listed[1].path), dir.path("b.plastikcad"));
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
        let from = dir.path("a.plastikcad");
        let to = dir.path("b.plastikcad");
        fs::write(&from, b"a").unwrap();
        move_path(&from, &to).unwrap();
        assert_eq!(dir.names(), vec!["b.plastikcad"]);
        fs::write(&from, b"again").unwrap();
        let err = move_path(&from, &to).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&to).unwrap(), b"a");
        // Into a folder that does not exist yet.
        let deep = dir.path("sub").join("c.plastikcad");
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
        assert!(ours.starts_with("HTTP/1.1 200") && ours.contains("go back to PlastikCAD"));
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
        let design = dir.path("thing.plastikcad");
        let upper = dir.path("THING.PLASTIKCAD");
        let other = dir.path("notes.txt");
        let missing = dir.path("gone.plastikcad");
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
        assert!(!is_design_path(Path::new("design.plastikcad.txt")));
        assert!(is_design_path(Path::new("Design.PlastikCad")));
        assert!(is_design_path(Path::new("Old.BashCAD")));
    }

    #[test]
    fn old_projects_folder_is_adopted_once() {
        let dir = TempDir::new();
        let old = dir.path("BashCAD");
        let new = dir.path("PlastikCAD");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("Box.bashcad"), b"{}").unwrap();
        fs::write(old.join("Lid.plastikcad"), b"{}").unwrap();
        fs::write(old.join("notes.txt"), b"").unwrap();
        fs::create_dir(old.join("sub.bashcad")).unwrap();
        adopt_old_folder(&old, &new);
        assert!(!old.exists());
        let mut names: Vec<String> = fs::read_dir(&new).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["Box.plastikcad", "Lid.plastikcad", "notes.txt", "sub.bashcad"]);

        // With the new folder in place the old one is left alone.
        fs::create_dir(&old).unwrap();
        fs::write(old.join("Later.bashcad"), b"{}").unwrap();
        adopt_old_folder(&old, &new);
        assert!(old.join("Later.bashcad").is_file());
        assert!(!new.join("Later.plastikcad").exists());
    }
}
