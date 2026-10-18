// `register_listener` and `remove_listener` are what the webview calls to
// subscribe to the plugin's events; on Android they are answered by the
// Kotlin side, and they need permissions like any other command.
const COMMANDS: &[&str] = &["state", "register_listener", "remove_listener", "pick_folder", "create_document", "mime_for"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
