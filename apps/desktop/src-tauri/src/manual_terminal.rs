//! Manual terminals belong to the application, never to a mounted view or mission watchdog.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, io::{Read, Write}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, path::Path};
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
#[derive(Default, Clone)]
pub struct ManualTerminals { sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Option<Terminal>>>>>>, stopping: Arc<AtomicBool> }
impl ManualTerminals {
    fn slot(&self, id: &str) -> Result<Option<Arc<Mutex<Option<Terminal>>>>, String> {
        Ok(self.sessions.lock().map_err(|_| "Terminal state is unavailable")?.get(id).cloned())
    }
    pub fn has_live_sessions(&self) -> bool {
        self.sessions.lock().map(|sessions| sessions.values().any(|slot| {
            match slot.try_lock() {
                Ok(mut slot) => slot.as_mut().map(|t| !t.closed && matches!(t.child.try_wait(), Ok(None))).unwrap_or(false),
                Err(_) => true, // Starting/writing: keep the app alive without blocking the window thread.
            }
        })).unwrap_or(true)
    }
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let slots = self.sessions.lock().map(|mut sessions| sessions.drain().map(|(_, slot)| slot).collect::<Vec<_>>()).unwrap_or_default();
        for slot in slots { if let Ok(mut value) = slot.lock() { if let Some(terminal) = value.as_mut() { let _ = close(terminal); } } }
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
    let slot = manager.sessions.lock().map_err(|_| "Terminal state is unavailable")?.entry(request.id.clone()).or_insert_with(|| Arc::new(Mutex::new(None))).clone();
    let mut slot = slot.lock().map_err(|_| "Agent state is unavailable")?;
    if let Some(existing) = slot.as_mut() {
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
    *slot = Some(terminal);
    Ok(())
}

#[tauri::command]
pub async fn manual_terminal_start(state: State<'_, ManualTerminals>, request: Launch) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start(manager, request)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn manual_terminal_snapshot(state: State<'_, ManualTerminals>, id: String, after: u64, status_only: Option<bool>) -> Result<Snapshot, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || snapshot(&manager, id, after, status_only.unwrap_or(false))).await.map_err(|e| e.to_string())?
}
fn snapshot(manager: &ManualTerminals, id: String, after: u64, status_only: bool) -> Result<Snapshot, String> {
    let disconnected = || Snapshot { id: id.clone(), status: "disconnected".into(), sequence: 0, output: String::new(), reset: true };
    let Some(slot) = manager.slot(&id)? else { return Ok(disconnected()); };
    let mut slot = slot.lock().map_err(|_| "Agent state is unavailable")?;
    let Some(terminal) = slot.as_mut() else { return Ok(disconnected()); };
    let replay = terminal.replay.lock().map_err(|_| "Terminal output is unavailable")?;
    let status = if terminal.closed { "closed" } else {
        match terminal.child.try_wait() { Ok(Some(_)) => "exited", Ok(None) if !replay.ended => "open", _ => "disconnected" }
    };
    let reset = after > replay.sequence || replay.chunks.front().map(|(seq, _)| after.saturating_add(1) < *seq).unwrap_or(false);
    let output = if status_only { String::new() } else { replay.chunks.iter().filter(|(seq, _)| reset || *seq > after).map(|(_, text)| text.as_str()).collect::<String>() };
    Ok(Snapshot { id, status: status.into(), sequence: replay.sequence, output, reset })
}
#[tauri::command]
pub async fn manual_terminal_write(state: State<'_, ManualTerminals>, id: String, data: String, paste: bool) -> Result<(), String> {
    if data.len() > 65536 { return Err("Terminal input is too large".into()); }
    if paste && data.chars().any(|c| c.is_control() && c != '\n' && c != '\t') { return Err("Message contains unsupported control characters".into()); }
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let slot = manager.slot(&id)?.ok_or("Open the agent first")?;
        let mut slot = slot.lock().map_err(|_| "Agent state is unavailable")?;
        let terminal = slot.as_mut().ok_or("Open the agent first")?;
        if terminal.closed || !matches!(terminal.child.try_wait(), Ok(None)) { return Err("Agent is not connected".into()); }
        let writer = terminal.writer.clone();
        // A full PTY input buffer must not prevent Close from reaching the child.
        drop(slot);
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
#[tauri::command]
pub async fn manual_terminal_resize(state: State<'_, ManualTerminals>, id: String, columns: u16, rows: u16) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
    let slot = manager.slot(&id)?.ok_or("Open the agent first")?;
    let slot = slot.lock().map_err(|_| "Agent state is unavailable")?;
    let terminal = slot.as_ref().ok_or("Open the agent first")?;
    terminal.master.resize(PtySize { rows: rows.clamp(2, 300), cols: columns.clamp(2, 500), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn manual_terminal_close(state: State<'_, ManualTerminals>, id: String) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(slot) = manager.slot(&id)? {
            let mut slot = slot.lock().map_err(|_| "Agent state is unavailable")?;
            if let Some(terminal) = slot.as_mut() { close(terminal)?; }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_is_bounded_and_preserves_monotonic_offsets() {
        let mut replay = Replay { chunks: VecDeque::new(), sequence: 0, bytes: 0, ended: false };
        for _ in 0..200 { replay.push("x".repeat(8192)); }
        assert!(replay.bytes <= REPLAY_LIMIT);
        assert_eq!(replay.sequence, 200);
        assert!(replay.chunks.front().unwrap().0 > 1);
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
        for id in [first, second] {
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
                    let mut slot = slot.lock().unwrap();
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
        {
            let slot = manager.slot(first).unwrap().unwrap();
            let mut slot = slot.lock().unwrap();
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
            let writer = slot.lock().unwrap().as_ref().unwrap().writer.clone();
            let _busy_input = writer.lock().unwrap();
            // Closing cannot depend on the input lock, even when a write is blocked.
            close(slot.lock().unwrap().as_mut().unwrap()).unwrap();
        }
        assert_eq!(snapshot(&manager, first.into(), 0, true).unwrap().status, "closed");
        assert_eq!(snapshot(&manager, second.into(), 0, true).unwrap().status, "open");
        assert!(manager.has_live_sessions());
        manager.shutdown();
        assert!(!manager.has_live_sessions());
    }
}
