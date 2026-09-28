//! Manual terminals belong to the application, never to a mounted view or mission watchdog.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, io::{Read, Write}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, path::{Path, PathBuf}, fs::OpenOptions};
use tauri::State;

const REPLAY_LIMIT: usize = 1024 * 1024;
struct Replay { chunks: VecDeque<(u64, String)>, sequence: u64, bytes: usize, ended: bool }
impl Replay {
    fn push(&mut self, text: String) {
        self.sequence += 1;
        self.bytes += text.len();
        self.chunks.push_back((self.sequence, text));
        while self.bytes > REPLAY_LIMIT && self.chunks.len() > 1 {
            if let Some((_, value)) = self.chunks.pop_front() { self.bytes -= value.len(); }
        }
    }
}
struct Terminal {
    master: Box<dyn MasterPty + Send>, writer: Arc<Mutex<Box<dyn Write + Send>>>, child: Box<dyn Child + Send + Sync>,
    replay: Arc<Mutex<Replay>>, closed: bool,
}
#[derive(Default)]
struct TerminalSlot { terminal: Mutex<Option<Terminal>>, closing: AtomicBool }
#[derive(Default, Clone)]
pub struct ManualTerminals { sessions: Arc<Mutex<HashMap<String, Arc<TerminalSlot>>>>, stopping: Arc<AtomicBool> }
impl ManualTerminals {
    fn slot(&self, id: &str) -> Result<Option<Arc<TerminalSlot>>, String> {
        Ok(self.sessions.lock().map_err(|_| "Terminal state is unavailable")?.get(id).cloned())
    }
    fn remove_slot(&self, id: &str, slot: &Arc<TerminalSlot>) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "Terminal state is unavailable")?;
        if matches!(sessions.get(id), Some(current) if Arc::ptr_eq(current, slot)) { sessions.remove(id); }
        Ok(())
    }
    fn remove_idle_slot(&self, id: &str) -> Result<(), String> {
        let Some(slot) = self.slot(id)? else { return Ok(()); };
        let mut terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
        if slot.closing.load(Ordering::SeqCst)
            || terminal_slot.as_ref().map(|terminal| !terminal.closed).unwrap_or(false) {
            return Ok(());
        }
        slot.closing.store(true, Ordering::SeqCst);
        *terminal_slot = None;
        drop(terminal_slot);
        self.remove_slot(id, &slot)
    }
    pub fn has_live_sessions(&self) -> bool {
        self.sessions.lock().map(|sessions| sessions.values().any(|slot| {
            match slot.terminal.try_lock() {
                Ok(mut slot) => slot.as_mut().map(|t| !t.closed && matches!(t.child.try_wait(), Ok(None))).unwrap_or(false),
                Err(_) => true, // Starting/writing: keep the app alive without blocking the window thread.
            }
        })).unwrap_or(true)
    }
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let slots = self.sessions.lock().map(|mut sessions| sessions.drain().map(|(_, slot)| slot).collect::<Vec<_>>()).unwrap_or_default();
        for slot in slots { if let Ok(mut value) = slot.terminal.lock() { if let Some(terminal) = value.as_mut() { let _ = close(terminal); } } }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch { id: String, executable: String, args: Vec<String>, cwd: String, #[serde(default)] env: HashMap<String, String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { id: String, status: String, sequence: u64, output: String, reset: bool }

fn close(terminal: &mut Terminal) -> Result<(), String> {
    if terminal.closed { return Ok(()); }
    if matches!(terminal.child.try_wait(), Ok(Some(_))) { terminal.closed = true; return Ok(()); }
    #[cfg(windows)]
    if let Some(pid) = terminal.child.process_id() {
        use std::os::windows::process::CommandExt;
        if let Ok(mut killer) = std::process::Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while matches!(killer.try_wait(), Ok(None)) && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(25)); }
            let _ = killer.kill();
        }
    }
    let _ = terminal.child.kill();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match terminal.child.try_wait() {
            Ok(Some(_)) => { terminal.closed = true; return Ok(()); }
            Err(_) => return Err("Could not confirm that the agent closed. Check its Code terminal.".into()),
            _ if std::time::Instant::now() >= deadline => return Err("Agent is still running. Closing was not confirmed; retry from Code.".into()),
            _ => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
}

fn start(manager: ManualTerminals, request: Launch) -> Result<(), String> {
    if manager.stopping.load(Ordering::SeqCst) { return Err("Application is shutting down".into()); }
    if request.id.len() != 36 || !request.id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { return Err("Invalid agent identity".into()); }
    if !Path::new(&request.cwd).is_dir() || !Path::new(&request.executable).is_file() { return Err("The CLI executable or project directory is unavailable".into()); }
    let session = manager.sessions.lock().map_err(|_| "Terminal state is unavailable")?.entry(request.id.clone()).or_insert_with(|| Arc::new(TerminalSlot::default())).clone();
    if session.closing.load(Ordering::SeqCst) { return Err("Agent terminal is closing".into()); }
    let mut terminal_slot = session.terminal.lock().map_err(|_| "Agent state is unavailable")?;
    if session.closing.load(Ordering::SeqCst) { return Err("Agent terminal is closing".into()); }
    if let Some(existing) = terminal_slot.as_mut() {
        if !existing.closed && matches!(existing.child.try_wait(), Ok(None)) { return Ok(()); }
        close(existing)?;
    }
    let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let extension = Path::new(&request.executable).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mut command = if cfg!(windows) && ["cmd", "bat", "ps1"].contains(&extension.as_str()) {
        // Data travels in environment variables, never interpolated into PowerShell source.
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.args(["-NoLogo", "-NoProfile", "-Command", "$ErrorActionPreference='Stop'; $launchArgs=@(ConvertFrom-Json $env:ATRIS_MANUAL_ARGS); & $env:ATRIS_MANUAL_EXECUTABLE @launchArgs; exit $LASTEXITCODE"]);
        cmd.env("ATRIS_MANUAL_EXECUTABLE", &request.executable);
        cmd.env("ATRIS_MANUAL_ARGS", serde_json::to_string(&request.args).map_err(|e| e.to_string())?);
        cmd
    } else {
        let mut cmd = CommandBuilder::new(&request.executable); cmd.args(&request.args); cmd
    };
    command.cwd(&request.cwd);
    command.env("TERM", "xterm-256color");
    for (key, value) in request.env {
        if key == "ATRIS_MANUAL_OPENCODE_PLUGIN" {
            let mut config: serde_json::Value = match std::env::var("OPENCODE_CONFIG_CONTENT") {
                Ok(value) => serde_json::from_str(&value).map_err(|_| "Inherited OpenCode configuration is not valid JSON")?,
                Err(_) => serde_json::json!({}),
            };
            let object = config.as_object_mut().ok_or("Inherited OpenCode configuration must be an object")?;
            let plugins = object.entry("plugin").or_insert_with(|| serde_json::json!([])).as_array_mut().ok_or("OpenCode plugin configuration must be an array")?;
            let plugin = serde_json::Value::String(value);
            if !plugins.contains(&plugin) { plugins.push(plugin); }
            command.env("OPENCODE_CONFIG_CONTENT", serde_json::to_string(&config).map_err(|_| "Could not prepare OpenCode configuration")?);
            continue;
        }
        if !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"].contains(&key.as_str()) { return Err("Unsupported CLI environment override".into()); }
        command.env(key, value);
    }
    // Acquire handles before spawn so a handle error cannot orphan a newly started CLI.
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let replay = Arc::new(Mutex::new(Replay { chunks: VecDeque::new(), sequence: 0, bytes: 0, ended: false }));
    let output = replay.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 { break; }
            pending.extend_from_slice(&buffer[..count]);
            let length = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(error) if error.error_len().is_none() => error.valid_up_to(),
                Err(_) => pending.len(),
            };
            if length > 0 {
                let text = String::from_utf8_lossy(&pending[..length]).to_string();
                pending.drain(..length);
                if let Ok(mut state) = output.lock() { state.push(text); }
            }
        }
        if let Ok(mut state) = output.lock() { state.ended = true; }
    });
    let mut terminal = Terminal { master: pair.master, writer, child, replay, closed: false };
    if manager.stopping.load(Ordering::SeqCst) { let _ = close(&mut terminal); return Err("Application is shutting down".into()); }
    if session.closing.load(Ordering::SeqCst) { let _ = close(&mut terminal); return Err("Agent terminal is closing".into()); }
    *terminal_slot = Some(terminal);
    Ok(())
}

fn start_with_cleanup(manager: ManualTerminals, request: Launch) -> Result<(), String> {
    let id = request.id.clone();
    match start(manager.clone(), request) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = manager.remove_idle_slot(&id);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn manual_terminal_start(state: State<'_, ManualTerminals>, request: Launch) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_with_cleanup(manager, request)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn manual_terminal_snapshot(state: State<'_, ManualTerminals>, id: String, after: u64, status_only: Option<bool>) -> Result<Snapshot, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || snapshot(&manager, id, after, status_only.unwrap_or(false))).await.map_err(|e| e.to_string())?
}
fn snapshot(manager: &ManualTerminals, id: String, after: u64, status_only: bool) -> Result<Snapshot, String> {
    let disconnected = || Snapshot { id: id.clone(), status: "disconnected".into(), sequence: 0, output: String::new(), reset: true };
    let Some(slot) = manager.slot(&id)? else { return Ok(disconnected()); };
    let mut terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
    let Some(terminal) = terminal_slot.as_mut() else { return Ok(disconnected()); };
    let replay = terminal.replay.lock().map_err(|_| "Terminal output is unavailable")?;
    let status = if terminal.closed { "closed" } else {
        match terminal.child.try_wait() { Ok(Some(_)) => "exited", Ok(None) if !replay.ended => "open", _ => "disconnected" }
    };
    let reset = after > replay.sequence || replay.chunks.front().map(|(seq, _)| after.saturating_add(1) < *seq).unwrap_or(false);
    let output = if status_only { String::new() } else { replay.chunks.iter().filter(|(seq, _)| reset || *seq > after).map(|(_, text)| text.as_str()).collect::<String>() };
    let snapshot = Snapshot { id, status: status.into(), sequence: replay.sequence, output, reset };
    drop(replay);
    // Snapshot is observational. Status-only polling can race with the full
    // output poll, so only an explicit close may release the terminal slot.
    Ok(snapshot)
}
#[tauri::command]
pub async fn manual_terminal_write(state: State<'_, ManualTerminals>, id: String, data: String, paste: bool) -> Result<(), String> {
    if data.len() > 65536 { return Err("Terminal input is too large".into()); }
    if paste && data.chars().any(|c| c.is_control() && c != '\n' && c != '\t') { return Err("Message contains unsupported control characters".into()); }
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let slot = manager.slot(&id)?.ok_or("Open the agent first")?;
        if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
        let mut terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
        if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
        let terminal = terminal_slot.as_mut().ok_or("Open the agent first")?;
        if terminal.closed || !matches!(terminal.child.try_wait(), Ok(None)) { return Err("Agent is not connected".into()); }
        let writer = terminal.writer.clone();
        // A full PTY input buffer must not prevent Close from reaching the child.
        drop(terminal_slot);
        let mut writer = writer.lock().map_err(|_| "Terminal input is unavailable")?;
        if paste {
            writer.write_all(format!("\x1b[200~{}\x1b[201~", data).as_bytes()).map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(80));
            writer.write_all(b"\r").map_err(|e| e.to_string())?;
        } else { writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?; }
        writer.flush().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
/// Stage WebView file bytes in an app-owned temporary directory so the CLI can read
/// the actual image/document. The original filename is never used as a path.
fn stage_attachment_file(directory: &Path, name: &str, data: &[u8]) -> Result<PathBuf, String> {
    if data.is_empty() || data.len() > 10 * 1024 * 1024 { return Err("Attachment must be between 1 byte and 10 MB".into()); }
    let extension = Path::new(name).extension().and_then(|value| value.to_str()).unwrap_or("");
    let extension = if extension.len() <= 12 && extension.chars().all(|c| c.is_ascii_alphanumeric()) { extension } else { "" };
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let stem = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let filename = if extension.is_empty() { stem } else { format!("{stem}.{extension}") };
    let path = directory.join(filename);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(data) { let _ = std::fs::remove_file(&path); return Err(error.to_string()); }
    Ok(path)
}

#[tauri::command]
pub async fn manual_stage_attachment(state: State<'_, ManualTerminals>, id: String, name: String, data: Vec<u8>) -> Result<String, String> {
    if data.is_empty() || data.len() > 10 * 1024 * 1024 { return Err("Attachment must be between 1 byte and 10 MB".into()); }
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let slot = manager.slot(&id)?.ok_or("Open the agent first")?;
        if slot.closing.load(Ordering::SeqCst) || !slot.terminal.lock().map_err(|_| "Agent state is unavailable")?.as_mut()
            .map(|terminal| !terminal.closed && matches!(terminal.child.try_wait(), Ok(None))).unwrap_or(false) {
            return Err("Agent is not connected".into());
        }
        let directory = std::env::temp_dir().join("atris-agent-attachments").join(&id);
        let path = stage_attachment_file(&directory, &name, &data)?;
        Ok(path.to_string_lossy().into_owned())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn manual_attachment_preview(id: String, path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || read_staged_image(&std::env::temp_dir(), &id, &path)).await.map_err(|e| e.to_string())?
}
fn read_staged_image(root: &Path, id: &str, path: &str) -> Result<Vec<u8>, String> {
    if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { return Err("Invalid agent identity".into()); }
    let candidate = PathBuf::from(path);
    let filename = candidate.file_name().and_then(|value| value.to_str()).ok_or("Invalid attachment")?;
    let (stem, extension) = filename.rsplit_once('.').ok_or("Not an image")?;
    if stem.len() != 32 || !stem.chars().all(|c| c.is_ascii_hexdigit()) || !["png", "jpg", "jpeg", "webp", "gif"].contains(&extension.to_ascii_lowercase().as_str()) { return Err("Not a staged image".into()); }
    let directory = root.join("atris-agent-attachments").join(id);
    if candidate.parent() != Some(directory.as_path()) || std::fs::symlink_metadata(&candidate).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("Attachment is unavailable".into()); }
    let metadata = std::fs::metadata(&candidate).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 10 * 1024 * 1024 { return Err("Attachment is unavailable".into()); }
    std::fs::read(candidate).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn manual_terminal_resize(state: State<'_, ManualTerminals>, id: String, columns: u16, rows: u16) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
    let slot = manager.slot(&id)?.ok_or("Open the agent first")?;
    if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
    let terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
    if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
    let terminal = terminal_slot.as_ref().ok_or("Open the agent first")?;
    terminal.master.resize(PtySize { rows: rows.clamp(2, 300), cols: columns.clamp(2, 500), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

fn close_session(manager: &ManualTerminals, id: &str) -> Result<(), String> {
    let Some(slot) = manager.slot(id)? else { return Ok(()); };
    if slot.closing.swap(true, Ordering::SeqCst) { return Err("Agent terminal is already closing".into()); }
    let result = (|| {
        let mut terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
        if let Some(terminal) = terminal_slot.as_mut() { close(terminal)?; }
        *terminal_slot = None;
        Ok(())
    })();
    if let Err(error) = result {
        slot.closing.store(false, Ordering::SeqCst);
        return Err(error);
    }
    manager.remove_slot(id, &slot)
}

#[tauri::command]
pub async fn manual_terminal_close(state: State<'_, ManualTerminals>, id: String) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || close_session(&manager, &id)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn staged_attachment_uses_private_random_name_and_preserves_bytes() {
        let directory = std::env::temp_dir().join(format!("atris-attachment-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path = stage_attachment_file(&directory, "../private screenshot.png", b"image bytes").unwrap();
        assert_eq!(path.parent(), Some(directory.as_path()));
        assert_eq!(path.extension().and_then(|value| value.to_str()), Some("png"));
        assert!(!path.to_string_lossy().contains("private screenshot"));
        assert_eq!(std::fs::read(&path).unwrap(), b"image bytes");
        let second = stage_attachment_file(&directory, "../private screenshot.png", b"second").unwrap();
        assert_ne!(path, second);
        assert!(stage_attachment_file(&directory, "empty.png", b"").is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn image_preview_is_scoped_to_its_agent_and_staged_image() {
        let root = std::env::temp_dir().join(format!("atris-preview-test-{}", std::process::id()));
        let id = "00000000-0000-4000-8000-000000000001";
        let directory = root.join("atris-agent-attachments").join(id);
        let image = stage_attachment_file(&directory, "screen.png", b"image bytes").unwrap();
        assert_eq!(read_staged_image(&root, id, image.to_str().unwrap()).unwrap(), b"image bytes");
        assert!(read_staged_image(&root, "00000000-0000-4000-8000-000000000002", image.to_str().unwrap()).is_err());
        assert!(read_staged_image(&root, id, stage_attachment_file(&directory, "private.txt", b"secret").unwrap().to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replay_is_bounded_and_preserves_monotonic_offsets() {
        let mut replay = Replay { chunks: VecDeque::new(), sequence: 0, bytes: 0, ended: false };
        for _ in 0..200 { replay.push("x".repeat(8192)); }
        assert!(replay.bytes <= REPLAY_LIMIT);
        assert_eq!(replay.sequence, 200);
        assert!(replay.chunks.front().unwrap().0 > 1);
    }

    #[test]
    fn closing_empty_session_removes_its_registry_entry() {
        let manager = ManualTerminals::default();
        let id = "00000000-0000-4000-8000-000000000001";
        manager.sessions.lock().unwrap().insert(id.into(), Arc::new(TerminalSlot::default()));
        close_session(&manager, id).unwrap();
        assert!(manager.slot(id).unwrap().is_none());
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_terminal_start_removes_its_empty_registry_entry() {
        let manager = ManualTerminals::default();
        let id = "00000000-0000-4000-8000-000000000002";
        let error = start_with_cleanup(manager.clone(), Launch {
            id: id.into(),
            executable: std::env::current_exe().unwrap().to_string_lossy().to_string(),
            args: Vec::new(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            env: HashMap::from([("UNSUPPORTED".into(), "value".into())]),
        }).unwrap_err();
        assert_eq!(error, "Unsupported CLI environment override");
        assert!(manager.slot(id).unwrap().is_none());
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn real_pty_input_replay_and_independent_close() {
        struct Cleanup(ManualTerminals);
        impl Drop for Cleanup { fn drop(&mut self) { self.0.shutdown(); } }
        let manager = ManualTerminals::default();
        let _cleanup = Cleanup(manager.clone());
        let executable = std::path::PathBuf::from(std::env::var("WINDIR").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe").to_string_lossy().to_string();
        let first = "00000000-0000-4000-8000-000000000001";
        let second = "00000000-0000-4000-8000-000000000002";
        let third = "00000000-0000-4000-8000-000000000003";
        let fourth = "00000000-0000-4000-8000-000000000004";
        for id in [first, second, third, fourth] {
            start(manager.clone(), Launch { id: id.into(), executable: executable.clone(),
                args: vec!["-NoLogo".into(), "-NoProfile".into(), "-Command".into(), "Write-Output 'native-ready'; $line=[Console]::ReadLine(); Write-Output ('received:'+$line); Start-Sleep -Seconds 30".into()],
                cwd: std::env::temp_dir().to_string_lossy().to_string(), env: HashMap::new() }).unwrap();
        }
        let wait_for = |id: &str, text: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let mut replied_to_cursor = false;
            loop {
                let result = snapshot(&manager, id.into(), 0, false).unwrap();
                // ConPTY inherits the terminal cursor. A real xterm renderer answers this query.
                if !replied_to_cursor && result.output.contains("\x1b[6n") {
                    let slot = manager.slot(id).unwrap().unwrap();
                    let mut slot = slot.terminal.lock().unwrap();
                    let terminal = slot.as_mut().unwrap();
                    let mut writer = terminal.writer.lock().unwrap();
                    writer.write_all(b"\x1b[1;1R").unwrap(); writer.flush().unwrap();
                    replied_to_cursor = true;
                }
                if result.output.contains(text) { return result; }
                assert!(std::time::Instant::now() < deadline, "PTY did not emit expected output: {:?}", result.output);
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        wait_for(first, "native-ready"); wait_for(second, "native-ready");
        wait_for(third, "native-ready"); wait_for(fourth, "native-ready");
        {
            let slot = manager.slot(first).unwrap().unwrap();
            let mut slot = slot.terminal.lock().unwrap();
            let terminal = slot.as_mut().unwrap();
            let mut writer = terminal.writer.lock().unwrap();
            writer.write_all(b"isolation-check\r").unwrap(); writer.flush().unwrap();
            terminal.master.resize(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        }
        let replay = wait_for(first, "received:isolation-check");
        assert!(!snapshot(&manager, second.into(), 0, false).unwrap().output.contains("isolation-check"));
        assert!(snapshot(&manager, first.into(), replay.sequence, false).unwrap().output.is_empty());
        {
            let slot = manager.slot(first).unwrap().unwrap();
            let writer = slot.terminal.lock().unwrap().as_ref().unwrap().writer.clone();
            let _busy_input = writer.lock().unwrap();
            // Closing cannot depend on the input lock, even when a write is blocked.
            close(slot.terminal.lock().unwrap().as_mut().unwrap()).unwrap();
        }
        assert_eq!(snapshot(&manager, first.into(), 0, true).unwrap().status, "closed");
        assert_eq!(snapshot(&manager, second.into(), 0, true).unwrap().status, "open");
        assert_eq!(snapshot(&manager, third.into(), 0, true).unwrap().status, "open");
        assert_eq!(snapshot(&manager, fourth.into(), 0, true).unwrap().status, "open");
        assert!(manager.has_live_sessions());
        close_session(&manager, second).unwrap();
        assert!(manager.slot(second).unwrap().is_none(), "closed terminal session is removed from the registry");
        assert_eq!(snapshot(&manager, second.into(), 0, true).unwrap().status, "disconnected");
        manager.shutdown();
        assert!(!manager.has_live_sessions());
    }
}
