//! What the app is being driven with. On Android the Kotlin side reports
//! whether a hardware keyboard is attached and whether the on-screen keypad
//! is showing (and how tall it is), and sends a `change` event whenever
//! either changes. Everywhere else there is a keyboard and no keypad.
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputState {
    pub hardware_keyboard: bool,
    pub keypad_visible: bool,
    /// Height of the keypad over the page, in CSS pixels.
    pub keypad_height: u32,
}

#[cfg(target_os = "android")]
struct Handle<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[tauri::command]
async fn state<R: Runtime>(app: AppHandle<R>) -> Result<InputState, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.state::<Handle<R>>()
            .0
            .run_mobile_plugin::<InputState>("state", ())
            .map_err(|err| err.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(InputState { hardware_keyboard: true, ..Default::default() })
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("input")
        .invoke_handler(tauri::generate_handler![state])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("com.andrewoshei.bashcad.input", "InputPlugin")?;
                app.manage(Handle(handle));
            }
            let _ = (app, &api);
            Ok(())
        })
        .build()
}
