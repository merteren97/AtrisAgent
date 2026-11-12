use serde::{Deserialize, Serialize};
use tauri::{webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder}, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl};

const LABEL: &str = "link-browser";
pub fn is_app_webview(label: &str) -> bool { label == "main" }

#[derive(Default)]
pub struct BrowserState { lock: tokio::sync::Mutex<()>, data_directory: Option<std::path::PathBuf> }

impl BrowserState {
    #[allow(dead_code)]
    pub fn with_data_directory(data_directory: std::path::PathBuf) -> Self {
        Self { lock: tokio::sync::Mutex::new(()), data_directory: Some(data_directory) }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationEvent { url: String, loading: bool }

fn allowed_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid web address".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Only HTTP and HTTPS addresses without credentials are supported".into());
    }
    Ok(url)
}

fn bounds(value: BrowserBounds) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    if ![value.x,value.y,value.width,value.height].iter().all(|v| v.is_finite()) || value.x < 0.0 || value.y < 0.0 || value.width < 1.0 || value.height < 1.0 || value.width > 16384.0 || value.height > 16384.0 {
        return Err("Invalid browser bounds".into());
    }
    Ok((LogicalPosition::new(value.x,value.y),LogicalSize::new(value.width,value.height)))
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, state: State<'_, BrowserState>, url: String, rect: BrowserBounds) -> Result<(), String> {
    let url = allowed_url(&url)?;
    let (position,size) = bounds(rect)?;
    let _guard = state.lock.lock().await;
    if let Some(webview) = app.get_webview(LABEL) {
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        webview.navigate(url).map_err(|e| e.to_string())?;
        return webview.show().map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    let data_dir = match &state.data_directory { Some(path) => path.clone(), None => app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("link-browser") };
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let app_for_popup = app.clone();
    let app_for_navigation = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .data_directory(data_dir)
        .on_navigation(|url| allowed_url(url.as_str()).is_ok())
        .on_new_window(move |url, _| {
            if allowed_url(url.as_str()).is_ok() { let _ = app_for_popup.emit_to("main", "link-browser-open", url.to_string()); }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_webview, payload| {
            if allowed_url(payload.url().as_str()).is_ok() {
                let _ = app_for_navigation.emit_to("main", "link-browser-navigation", NavigationEvent {
                    url: payload.url().to_string(), loading: matches!(payload.event(),PageLoadEvent::Started),
                });
            }
        });
    window.add_child(builder,position,size).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_resize(app: AppHandle, state: State<'_, BrowserState>, rect: BrowserBounds) -> Result<(), String> {
    let (position,size) = bounds(rect)?;
    let _guard = state.lock.lock().await;
    if let Some(webview) = app.get_webview(LABEL) {
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_action(app: AppHandle, state: State<'_, BrowserState>, action: String) -> Result<(), String> {
    let script = match action.as_str() { "back" => "history.back()", "forward" => "history.forward()", "reload" => "location.reload()", _ => return Err("Unsupported browser action".into()) };
    let _guard = state.lock.lock().await;
    app.get_webview(LABEL).ok_or("Browser is not open")?.eval(script).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_visibility(app: AppHandle, state: State<'_, BrowserState>, visible: bool) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    if let Some(webview) = app.get_webview(LABEL) { if visible { webview.show() } else { webview.hide() }.map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, state: State<'_, BrowserState>) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    if let Some(webview) = app.get_webview(LABEL) { webview.close().map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_web_urls_without_embedded_credentials() {
        assert!(allowed_url("https://example.com/path").is_ok());
        for value in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost", "https://user:pass@example.com"] { assert!(allowed_url(value).is_err()); }
    }
    #[test]
    fn validates_bounds() {
        assert!(bounds(BrowserBounds{x:0.0,y:0.0,width:320.0,height:400.0}).is_ok());
        assert!(bounds(BrowserBounds{x:0.0,y:0.0,width:f64::NAN,height:400.0}).is_err());
    }
    #[test]
    fn browser_webview_cannot_invoke_application_commands() {
        assert!(is_app_webview("main"));
        assert!(!is_app_webview("link-browser"));
    }
}
