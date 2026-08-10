use std::{sync::Mutex, time::Duration};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_ENDPOINT: &str =
    "https://github.com/merteren97/AtrisAgent/releases/latest/download/latest.json";
const UPDATE_TIMEOUT_SECONDS: u64 = 20;

pub struct PendingUpdate(Mutex<Option<Update>>);

impl Default for PendingUpdate {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuntimeInfo {
    configured: bool,
    current_version: String,
    endpoint: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    notes: Option<String>,
    pub_date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEvent {
    event: &'static str,
    content_length: Option<u64>,
    chunk_length: usize,
}

fn updater_public_key() -> Option<&'static str> {
    option_env!("TAURI_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let public_key = updater_public_key().ok_or_else(|| {
        "The updater is not configured in this build. Install a signed AtrisAgent release to enable updates."
            .to_string()
    })?;
    let shutdown_app = app.clone();

    app.updater_builder()
        .pubkey(public_key)
        .endpoints(vec![UPDATE_ENDPOINT
            .parse()
            .map_err(|error| format!("Invalid updater endpoint: {error}"))?])
        .map_err(|error| format!("Could not configure updater endpoint: {error}"))?
        .timeout(Duration::from_secs(UPDATE_TIMEOUT_SECONDS))
        .on_before_exit(move || {
            // Windows installers terminate the application as part of the update
            // flow. Shut the managed sidecar down before that hard process exit.
            shutdown_app.state::<crate::runtime::RuntimeState>().shutdown();
        })
        .build()
        .map_err(|error| format!("Could not initialize the updater: {error}"))
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().build())?;
    app.manage(PendingUpdate::default());
    Ok(())
}

#[tauri::command]
pub fn get_update_runtime_info() -> UpdateRuntimeInfo {
    UpdateRuntimeInfo {
        configured: updater_public_key().is_some(),
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        endpoint: UPDATE_ENDPOINT,
    }
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMetadata>, String> {
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("Could not check GitHub Releases for updates: {error}"))?;

    let metadata = update.as_ref().map(|update| UpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        pub_date: update.date.map(|date| date.to_string()),
    });

    let mut slot = pending_update
        .0
        .lock()
        .map_err(|_| "The pending update state is unavailable.".to_string())?;
    *slot = update;

    Ok(metadata)
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let update = pending_update
        .0
        .lock()
        .map_err(|_| "The pending update state is unavailable.".to_string())?
        .take()
        .ok_or_else(|| "There is no checked update ready to install. Check for updates again.".to_string())?;

    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent {
                        event: "started",
                        content_length,
                        chunk_length: 0,
                    });
                }
                let _ = on_event.send(DownloadEvent {
                    event: "progress",
                    content_length: None,
                    chunk_length,
                });
            },
            || {
                let _ = on_event.send(DownloadEvent {
                    event: "finished",
                    content_length: None,
                    chunk_length: 0,
                });
            },
        )
        .await
        .map_err(|error| format!("Could not download or install the AtrisAgent update: {error}"))?;

    // Windows exits automatically during installation. Linux reaches this line
    // after a successful install and should reopen the updated application.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::{updater_public_key, UPDATE_ENDPOINT};

    #[test]
    fn updater_endpoint_is_a_public_https_github_release_manifest() {
        assert!(UPDATE_ENDPOINT.starts_with("https://github.com/merteren97/AtrisAgent/releases/"));
        assert!(UPDATE_ENDPOINT.ends_with("/latest/download/latest.json"));
    }

    #[test]
    fn unsigned_development_builds_fail_closed() {
        if option_env!("TAURI_UPDATER_PUBLIC_KEY").is_none() {
            assert!(updater_public_key().is_none());
        }
    }
}
