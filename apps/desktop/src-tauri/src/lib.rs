use keyring::Entry;
use serde::Serialize;
use std::{fs, path::Path, process::Command};
use tauri::{AppHandle, Manager, State};

use app_lifecycle::{set_close_behavior, CloseBehaviorState};
use app_updater::{check_for_updates, get_update_runtime_info, install_update};

const KEYRING_SERVICE: &str = "com.atris.agent";
const SESSION_TOKEN_KEY: &str = "session:atris-token";

mod app_lifecycle;
mod app_updater;
mod runtime;
#[cfg(windows)]
mod session_store;

fn validate_secret_ref(secret_ref: &str) -> Result<(), String> {
    if secret_ref == SESSION_TOKEN_KEY {
        Ok(())
    } else {
        Err("Unsupported secret reference.".to_string())
    }
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, SESSION_TOKEN_KEY).map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInspection {
    path: String,
    name: String,
    is_git: bool,
    git_root: Option<String>,
    branch: Option<String>,
    dirty: bool,
    project_types: Vec<String>,
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window was not found".to_string())
}

fn git_output(workspace_path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn user_facing_path(workspace_path: &Path) -> String {
    let value = workspace_path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value
}

fn detect_project_types(workspace_path: &Path) -> Vec<String> {
    let mut types = Vec::new();
    let push_unique = |values: &mut Vec<String>, value: &str| {
        if !values.iter().any(|item| item == value) {
            values.push(value.to_string());
        }
    };

    if workspace_path.join("package.json").exists() {
        push_unique(&mut types, "Node.js");
    }
    if workspace_path.join("Cargo.toml").exists() {
        push_unique(&mut types, "Rust");
    }
    if workspace_path.join("pyproject.toml").exists()
        || workspace_path.join("requirements.txt").exists()
    {
        push_unique(&mut types, "Python");
    }
    if workspace_path.join("go.mod").exists() {
        push_unique(&mut types, "Go");
    }

    if let Ok(entries) = fs::read_dir(workspace_path) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().to_lowercase();
            if name.ends_with(".sln") || name.ends_with(".csproj") {
                push_unique(&mut types, ".NET");
            }
            if name == "tauri.conf.json" || name == "tauri.conf.json5" {
                push_unique(&mut types, "Tauri");
            }
        }
    }

    if workspace_path.join("src-tauri").exists() {
        push_unique(&mut types, "Tauri");
    }

    types
}

#[tauri::command]
fn inspect_workspace_path(path: String) -> Result<WorkspaceInspection, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Choose a project folder first.".to_string());
    }

    let workspace_path = fs::canonicalize(trimmed).map_err(|_| {
        "The selected workspace folder does not exist or cannot be accessed.".to_string()
    })?;
    if !workspace_path.is_dir() {
        return Err("The selected workspace path is not a directory.".to_string());
    }

    let name = workspace_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Workspace".to_string());

    let git_root = git_output(&workspace_path, &["rev-parse", "--show-toplevel"])
        .filter(|value| !value.is_empty());
    let is_git = git_root.is_some();
    let branch = if is_git {
        git_output(&workspace_path, &["branch", "--show-current"])
            .filter(|value| !value.is_empty())
            .or_else(|| git_output(&workspace_path, &["rev-parse", "--short", "HEAD"]))
    } else {
        None
    };
    let dirty = is_git
        && git_output(&workspace_path, &["status", "--porcelain"])
            .map(|value| !value.is_empty())
            .unwrap_or(false);

    Ok(WorkspaceInspection {
        path: user_facing_path(&workspace_path),
        name,
        is_git,
        git_root,
        branch,
        dirty,
        project_types: detect_project_types(&workspace_path),
    })
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to AtrisAgent.", name)
}

#[tauri::command]
fn store_local_secret(app: AppHandle, secret_ref: String, value: String) -> Result<(), String> {
    validate_secret_ref(&secret_ref)?;
    if secret_ref == SESSION_TOKEN_KEY {
        #[cfg(windows)]
        {
            session_store::save(&app, &value)?;
            // Once DPAPI has been written, remove any pre-DPAPI keyring copy.
            if let Ok(entry) = keyring_entry() {
                let _ = entry.delete_credential();
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            return keyring_entry()?
                .set_password(&value)
                .map_err(|error| error.to_string());
        }
    }
    keyring_entry()?
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_local_secret(app: AppHandle, secret_ref: String) -> Result<Option<String>, String> {
    validate_secret_ref(&secret_ref)?;
    if secret_ref == SESSION_TOKEN_KEY {
        #[cfg(windows)]
        {
            if let Some(token) = session_store::load(&app)? {
                if let Ok(entry) = keyring_entry() {
                    let _ = entry.delete_credential();
                }
                return Ok(Some(token));
            }
            return match keyring_entry()?.get_password() {
                Ok(token) => {
                    // Migrate the legacy keyring token into the DPAPI file once.
                    if session_store::save(&app, &token).is_ok() {
                        if let Ok(entry) = keyring_entry() {
                            let _ = entry.delete_credential();
                        }
                    }
                    Ok(Some(token))
                }
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(error.to_string()),
            };
        }
        #[cfg(not(windows))]
        {
            return match keyring_entry()?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(error.to_string()),
            };
        }
    }
    match keyring_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_local_secret(app: AppHandle, secret_ref: String) -> Result<(), String> {
    validate_secret_ref(&secret_ref)?;
    if secret_ref == SESSION_TOKEN_KEY {
        #[cfg(windows)]
        {
            // Delete the legacy copy first; if this fails, leave DPAPI intact so
            // a retry cannot resurrect a session from an inconsistent state.
            match keyring_entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) => return Err(error.to_string()),
            }
            return session_store::clear(&app);
        }
        #[cfg(not(windows))]
        {
            return match keyring_entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error.to_string()),
            };
        }
    }
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_secret_ref, SESSION_TOKEN_KEY};

    #[test]
    fn secret_ref_allowlist_accepts_only_the_session_token() {
        assert!(validate_secret_ref(SESSION_TOKEN_KEY).is_ok());
        assert!(validate_secret_ref("session:other-token").is_err());
        assert!(validate_secret_ref("../../untrusted").is_err());
        assert!(validate_secret_ref("").is_err());
    }
}

#[tauri::command]
fn window_start_dragging(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?
        .start_dragging()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?
        .minimize()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    let is_maximized = window.is_maximized().map_err(|error| error.to_string())?;

    if is_maximized {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn window_close(
    app: tauri::AppHandle,
    state: State<'_, CloseBehaviorState>,
) -> Result<(), String> {
    app_lifecycle::close_main_window(&app, state.inner())
}

#[tauri::command]
fn get_runtime_config(
    app: AppHandle,
    state: State<'_, runtime::RuntimeState>,
) -> Result<runtime::RuntimeConfig, String> {
    state.ensure_config(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Register single-instance handling before every other plugin. A second
    // launcher attempt should never create another runtime/sidecar; it only
    // restores and focuses the existing main window, including when hidden in tray.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let app = builder
        .manage(runtime::RuntimeState::default())
        .manage(CloseBehaviorState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(app_lifecycle::handle_window_event)
        .setup(|app| {
            app_lifecycle::setup(app)?;
            app_updater::setup(app)?;
            let state = app.state::<runtime::RuntimeState>();
            if let Err(error) = state.start(&app.handle()) {
                state.shutdown();
                state.set_error(error);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            inspect_workspace_path,
            window_start_dragging,
            window_minimize,
            window_toggle_maximize,
            window_close,
            set_close_behavior,
            get_update_runtime_info,
            check_for_updates,
            install_update,
            get_runtime_config,
            store_local_secret,
            read_local_secret,
            delete_local_secret
        ])
        .build(tauri::generate_context!())
        .expect("error while building AtrisAgent");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            app_handle.state::<runtime::RuntimeState>().shutdown();
        }
    });
}
