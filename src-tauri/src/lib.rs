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

/// Write to a temporary sibling, then rename it over the target, so a crash
/// can never leave a half-written design behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // Replace the file a symlink points at, not the link itself.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a file path"))?;
    let mut tmp_name = OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp = target.with_file_name(tmp_name);

    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
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

/// The design the app was launched with: the operating system passes the path
/// as an argument when a `.bashcad` file is double-clicked.
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .and_then(|path| std::path::absolute(path).ok())
        .and_then(|path| path.into_os_string().into_string().ok())
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
