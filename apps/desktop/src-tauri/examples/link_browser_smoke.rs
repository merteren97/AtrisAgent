//! Hidden-window smoke test for the native child webview. No model or remote site is used.
//! On Windows, build the example first and embed `link_browser_smoke.manifest`
//! with the Windows SDK `mt.exe` before running the resulting executable.
#[path = "../src/link_browser.rs"]
mod link_browser;

use std::{io::{Read, Write}, net::TcpListener, sync::{Arc, atomic::{AtomicUsize,Ordering}}, time::Duration};
use tauri::Manager;

#[tauri::command]
fn fixture_secret() -> &'static str { "fixture-secret" }

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let port = listener.local_addr().unwrap().port();
    let status = Arc::new(AtomicUsize::new(0));
    let server_status = status.clone();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut input = [0u8; 4096]; let len = stream.read(&mut input).unwrap_or(0);
            let request = String::from_utf8_lossy(&input[..len]);
            if request.starts_with("GET /ipc-denied") { server_status.store(1,Ordering::SeqCst); }
            if request.starts_with("GET /ipc-allowed") { server_status.store(2,Ordering::SeqCst); }
            let body = r#"<!doctype html><title>Browser fixture</title><p>Ready</p><script>(async()=>{let status='ipc-denied';try{if(window.__TAURI_INTERNALS__ && await window.__TAURI_INTERNALS__.invoke('fixture_secret')==='fixture-secret')status='ipc-allowed'}catch(_){}fetch('/'+status)})()</script>"#;
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
        }
    });
    let profile = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("link-browser-smoke-{}",std::process::id()));
    let mut context = tauri::generate_context!();
    for window in &mut context.config_mut().app.windows { window.visible = false; }
    let app = tauri::Builder::default().manage(link_browser::BrowserState::with_data_directory(profile))
        .invoke_handler(|invoke| {
            if !link_browser::is_app_webview(invoke.message.webview_ref().label()) { invoke.resolver.reject("Commands are unavailable in external web content."); return true; }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![fixture_secret];
            handler(invoke)
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let rect = link_browser::BrowserBounds{x:20.0,y:60.0,width:480.0,height:400.0};
                let result = async {
                    link_browser::browser_open(handle.clone(),handle.state(),format!("http://127.0.0.1:{port}/"),rect).await?;
                    if handle.get_webview("link-browser").is_none() { return Err("Browser webview was not created".to_string()); }
                    for _ in 0..100 { if status.load(Ordering::SeqCst) != 0 {break;} tokio::time::sleep(Duration::from_millis(100)).await; }
                    match status.load(Ordering::SeqCst) { 1 => (), 2 => return Err("External page invoked an application command".into()), _ => return Err("External page did not load or report its IPC status".into()) }
                    link_browser::browser_resize(handle.clone(),handle.state(),link_browser::BrowserBounds{x:30.0,y:70.0,width:600.0,height:450.0}).await?;
                    link_browser::browser_visibility(handle.clone(),handle.state(),false).await?;
                    link_browser::browser_visibility(handle.clone(),handle.state(),true).await?;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    link_browser::browser_close(handle.clone(),handle.state()).await?;
                    Ok::<(),String>(())
                }.await;
                match result { Ok(()) => {println!("Native browser page load, IPC isolation, resize, hide, show and close passed");handle.exit(0);}, Err(error) => {eprintln!("Native browser smoke failed: {error}");handle.exit(1);} }
            });
            Ok(())
        }).build(context).expect("build fixture application");
    app.run(|_,_| {});
}
