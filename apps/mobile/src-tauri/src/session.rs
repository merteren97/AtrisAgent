use keyring_core::{Entry, Error};
#[cfg(any(target_os = "android", target_os = "ios"))]
use keyring_core::api::CredentialStoreApi;

fn entry() -> Result<Entry, String> {
    #[cfg(target_os = "android")]
    let store = android_native_keyring_store::Store::new().map_err(|_| "Secure storage unavailable")?;
    #[cfg(target_os = "ios")]
    let store = apple_native_keyring_store::protected::Store::new().map_err(|_| "Secure storage unavailable")?;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return store.build("com.atrishub.agent.mobile", "hub-session-v1", None).map_err(|_| "Secure storage unavailable".into());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Err("Secure sessions are available on iOS and Android".into())
}

#[tauri::command]
pub fn load_mobile_token() -> Result<Option<String>, String> {
    match entry()?.get_secret() {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "Stored session is invalid".into()),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read secure session".into()),
    }
}

#[tauri::command]
pub fn save_mobile_token(token: String) -> Result<(), String> {
    if token.is_empty() || token.len() > 8192 || token.chars().any(|c| c.is_control()) { return Err("Invalid session token".into()); }
    entry()?.set_secret(token.as_bytes()).map_err(|_| "Could not save secure session".into())
}

#[tauri::command]
pub fn delete_mobile_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not delete secure session".into()),
    }
}
