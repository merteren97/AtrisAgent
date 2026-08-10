use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};

const TRAY_ID: &str = "atris-agent-tray";
const TRAY_SHOW_ID: &str = "show";
const TRAY_QUIT_ID: &str = "quit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseBehavior {
    Quit,
    Tray,
}

impl CloseBehavior {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "quit" => Ok(Self::Quit),
            "tray" => Ok(Self::Tray),
            _ => Err("Unsupported close behavior. Expected 'quit' or 'tray'.".to_string()),
        }
    }
}

pub struct CloseBehaviorState {
    behavior: Mutex<CloseBehavior>,
}

impl Default for CloseBehaviorState {
    fn default() -> Self {
        Self {
            behavior: Mutex::new(CloseBehavior::Quit),
        }
    }
}

impl CloseBehaviorState {
    fn get(&self) -> Result<CloseBehavior, String> {
        self.behavior
            .lock()
            .map(|behavior| *behavior)
            .map_err(|_| "Close behavior state is unavailable.".to_string())
    }

    fn set(&self, behavior: CloseBehavior) -> Result<(), String> {
        let mut current = self
            .behavior
            .lock()
            .map_err(|_| "Close behavior state is unavailable.".to_string())?;
        *current = behavior;
        Ok(())
    }
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found".to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn close_main_window(app: &AppHandle, state: &CloseBehaviorState) -> Result<(), String> {
    match state.get()? {
        CloseBehavior::Quit => {
            app.exit(0);
            Ok(())
        }
        CloseBehavior::Tray => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "Main window was not found".to_string())?;
            window.hide().map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
pub fn set_close_behavior(
    app: AppHandle,
    state: State<'_, CloseBehaviorState>,
    behavior: String,
) -> Result<(), String> {
    let behavior = CloseBehavior::parse(&behavior)?;
    state.set(behavior)?;

    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(behavior == CloseBehavior::Tray)
            .map_err(|error| format!("Could not update AtrisAgent tray visibility: {error}"))?;
    }

    #[cfg(not(desktop))]
    let _ = app;

    Ok(())
}

#[cfg(desktop)]
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW_ID, "Show AtrisAgent", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit AtrisAgent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AtrisAgent")
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("[AtrisAgent] Could not restore the main window from the tray: {error}");
                }
            }
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("[AtrisAgent] Could not restore the main window from the tray: {error}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    let tray = tray_builder.build(app)?;
    // Existing users keep the historical quit-on-close behavior. The frontend
    // synchronizes the persisted preference after hydration and shows the tray
    // only when "Minimize to tray" is selected.
    tray.set_visible(false)?;
    Ok(())
}

#[cfg(not(desktop))]
pub fn setup(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    let state = window.app_handle().state::<CloseBehaviorState>();
    if matches!(state.get(), Ok(CloseBehavior::Tray)) {
        api.prevent_close();
        if let Err(error) = window.hide() {
            eprintln!("[AtrisAgent] Could not minimize the main window to the tray: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CloseBehavior, CloseBehaviorState};

    #[test]
    fn close_behavior_parser_accepts_only_supported_values() {
        assert_eq!(CloseBehavior::parse("quit"), Ok(CloseBehavior::Quit));
        assert_eq!(CloseBehavior::parse("tray"), Ok(CloseBehavior::Tray));
        assert_eq!(CloseBehavior::parse(" TRAY "), Ok(CloseBehavior::Tray));
        assert!(CloseBehavior::parse("minimize").is_err());
        assert!(CloseBehavior::parse("").is_err());
    }

    #[test]
    fn close_behavior_defaults_to_quit_and_can_be_updated() {
        let state = CloseBehaviorState::default();
        assert_eq!(state.get(), Ok(CloseBehavior::Quit));
        state.set(CloseBehavior::Tray).expect("set tray behavior");
        assert_eq!(state.get(), Ok(CloseBehavior::Tray));
    }
}
