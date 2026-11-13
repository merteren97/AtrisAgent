#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![session::load_mobile_token, session::save_mobile_token, session::delete_mobile_token])
        .run(tauri::generate_context!())
        .expect("failed to run AtrisAgent mobile");
}
mod session;
