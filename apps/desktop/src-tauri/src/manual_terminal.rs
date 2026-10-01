//! Manual terminals belong to the application, never to a mounted view or mission watchdog.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, io::{Read, Write}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, path::{Path, PathBuf}, fs::OpenOptions};
use tauri::State;

const REPLAY_LIMIT: usize = 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq)]
struct Geometry { columns: u16, rows: u16 }
const INITIAL_GEOMETRY: Geometry = Geometry { columns: 120, rows: 30 };
#[derive(Serialize, Debug, PartialEq)]
struct ReplayResize { offset: usize, columns: u16, rows: u16 }
struct Replay { chunks: VecDeque<(u64, String, Geometry)>, sequence: u64, bytes: usize, ended: bool, geometry: Geometry }
impl Replay {
    fn new() -> Self { Self { chunks: VecDeque::new(), sequence: 0, bytes: 0, ended: false, geometry: INITIAL_GEOMETRY } }
    fn push(&mut self, text: String) {
        self.sequence += 1;
        self.bytes += text.len();
        self.chunks.push_back((self.sequence, text, self.geometry));
        while (self.bytes > REPLAY_LIMIT || self.chunks.len() > 4096) && self.chunks.len() > 1 {
            if let Some((_, value, _)) = self.chunks.pop_front() { self.bytes -= value.len(); }
        }
    }
    fn resized(&mut self, geometry: Geometry) {
        self.geometry = geometry;
        // A resize is an ordered replay event, even if the CLI hasn't emitted a repaint yet.
        self.push(String::new());
    }
    fn output_after(&self, after: u64, reset: bool) -> (String, Vec<ReplayResize>) {
        let mut output = String::new();
        let mut resizes = Vec::new();
        let mut geometry = None;
        let mut offset = 0;
        for (_, text, size) in self.chunks.iter().filter(|(seq, _, _)| reset || *seq > after) {
            if geometry != Some(*size) {
                resizes.push(ReplayResize { offset, columns: size.columns, rows: size.rows });
                geometry = Some(*size);
            }
            // Offsets are JavaScript string positions, not UTF-8 byte offsets.
            offset += text.encode_utf16().count();
            output.push_str(text);
        }
        (output, resizes)
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
pub struct Snapshot { id: String, status: String, sequence: u64, output: String, reset: bool, columns: u16, rows: u16, resizes: Vec<ReplayResize> }

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
    let pair = native_pty_system().openpty(PtySize { rows: INITIAL_GEOMETRY.rows, cols: INITIAL_GEOMETRY.columns, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
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
        if key == "ATRIS_MANUAL_OPENCODE_TUI_CONFIG" {
            let config_file = prepare_tui_config(&value, std::env::var("OPENCODE_TUI_CONFIG").ok().as_deref())?;
            command.env("OPENCODE_TUI_CONFIG", config_file);
            continue;
        }
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
        if !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"].contains(&key.as_str()) { return Err("Unsupported CLI environment override".into()); }
        command.env(key, value);
    }
    // Acquire handles before spawn so a handle error cannot orphan a newly started CLI.
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let replay = Arc::new(Mutex::new(Replay::new()));
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
    let disconnected = || Snapshot { id: id.clone(), status: "disconnected".into(), sequence: 0, output: String::new(), reset: true,
        columns: INITIAL_GEOMETRY.columns, rows: INITIAL_GEOMETRY.rows, resizes: Vec::new() };
    let Some(slot) = manager.slot(&id)? else { return Ok(disconnected()); };
    let mut terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
    let Some(terminal) = terminal_slot.as_mut() else { return Ok(disconnected()); };
    let replay = terminal.replay.lock().map_err(|_| "Terminal output is unavailable")?;
    let status = if terminal.closed { "closed" } else {
        match terminal.child.try_wait() { Ok(Some(_)) => "exited", Ok(None) if !replay.ended => "open", _ => "disconnected" }
    };
    let reset = after > replay.sequence || replay.chunks.front().map(|(seq, _, _)| after.saturating_add(1) < *seq).unwrap_or(false);
    let (output, resizes) = if status_only { (String::new(), Vec::new()) } else { replay.output_after(after, reset) };
    let snapshot = Snapshot { id, status: status.into(), sequence: replay.sequence, output, reset,
        columns: replay.geometry.columns, rows: replay.geometry.rows, resizes };
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

// Keep an inherited explicit TUI configuration local to the native process.
// OpenCode accepts JSONC (comments/trailing commas), including in .json files.
fn read_jsonc(source: &str) -> Result<serde_json::Value, String> {
    let chars: Vec<char> = source.trim_start_matches('\u{feff}').chars().collect();
    let mut clean = String::new();
    let (mut i, mut quoted, mut escaped) = (0, false, false);
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            clean.push(c);
            if escaped { escaped = false; }
            else if c == '\\' { escaped = true; }
            else if c == '"' { quoted = false; }
        } else if c == '"' { quoted = true; clean.push(c); }
        else if c == '/' && chars.get(i+1) == Some(&'/') {
            i += 2;
            while i < chars.len() && chars[i] != '\n' { i += 1; }
            clean.push('\n');
            continue;
        } else if c == '/' && chars.get(i+1) == Some(&'*') {
            i += 2;
            while i+1 < chars.len() && !(chars[i] == '*' && chars[i+1] == '/') { i += 1; }
            if i+1 >= chars.len() { return Err("Unterminated OpenCode TUI config comment".into()); }
            i += 2;
            clean.push(' ');
            continue;
        } else { clean.push(c); }
        i += 1;
    }
    let chars: Vec<char> = clean.chars().collect();
    let mut result = String::new();
    quoted = false; escaped = false;
    for (i, &c) in chars.iter().enumerate() {
        if !quoted && c == ',' && matches!(chars[i+1..].iter().find(|c| !c.is_whitespace()), Some('}') | Some(']')) { continue; }
        result.push(c);
        if quoted {
            if escaped { escaped = false; }
            else if c == '\\' { escaped = true; }
            else if c == '"' { quoted = false; }
        } else if c == '"' { quoted = true; }
    }
    serde_json::from_str(&result).map_err(|_| "Inherited OpenCode TUI configuration is not valid JSONC".into())
}

fn prepare_tui_config(managed: &str, inherited: Option<&str>) -> Result<String, String> {
    let Some(inherited) = inherited.filter(|value| !value.is_empty() && *value != managed) else { return Ok(managed.into()); };
    let mut config = read_jsonc(&std::fs::read_to_string(inherited).map_err(|_| "Could not read inherited OpenCode TUI configuration")?)?;
    let managed_config = read_jsonc(&std::fs::read_to_string(managed).map_err(|_| "Could not read managed OpenCode TUI configuration")?)?;
    let object = config.as_object_mut().ok_or("OpenCode TUI configuration must be an object")?;
    if let Some(serde_json::Value::Object(nested)) = object.remove("tui") {
        for (key, value) in nested { object.entry(key).or_insert(value); }
    }
    let plugins = object.entry("plugin").or_insert_with(|| serde_json::json!([])).as_array_mut().ok_or("OpenCode TUI plugins must be an array")?;
    for plugin in managed_config["plugin"].as_array().ok_or("Managed TUI plugins are missing")? {
        if !plugins.contains(plugin) { plugins.push(plugin.clone()); }
    }
    // Relative plugins must keep resolving against their original config directory.
    let parent = Path::new(inherited).parent().unwrap_or(Path::new("."));
    for plugin in plugins {
        let target = if plugin.is_array() { plugin.get_mut(0) } else { Some(plugin) };
        if let Some(target) = target {
            if let Some(spec) = target.as_str() {
                if spec.starts_with("./") || spec.starts_with("../") { *target = serde_json::Value::String(parent.join(spec).to_string_lossy().into_owned()); }
            }
        }
    }
    let destination = Path::new(managed).with_file_name("tui-inherited.json");
    if std::fs::symlink_metadata(&destination).map(|meta| meta.file_type().is_symlink()).unwrap_or(false) { return Err("Managed TUI configuration must not be a symbolic link".into()); }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut output = options.open(&destination).map_err(|_| "Could not save OpenCode TUI configuration")?;
    output.write_all(&serde_json::to_vec(&config).map_err(|_| "Could not encode OpenCode TUI configuration")?).map_err(|_| "Could not save OpenCode TUI configuration")?;
    Ok(destination.to_string_lossy().into_owned())
}
#[tauri::command]
pub async fn manual_project_image_preview(cwd: String, path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || read_project_image(Path::new(&cwd), &path)).await.map_err(|e| e.to_string())?
}
fn read_project_image(root: &Path, reference: &str) -> Result<Vec<u8>, String> {
    if reference.is_empty() || reference.len() > 2048 || reference.chars().any(char::is_control) { return Err("Invalid image path".into()); }
    let root = std::fs::canonicalize(root).map_err(|_| "Project is unavailable")?;
    if !root.is_dir() { return Err("Project is unavailable".into()); }
    let supplied = Path::new(reference);
    let candidate = std::fs::canonicalize(if supplied.is_absolute() { supplied.to_path_buf() } else { root.join(supplied) })
        .map_err(|_| "Image is unavailable")?;
    if !candidate.starts_with(&root) { return Err("Image is outside this project".into()); }
    let extension = candidate.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif"].contains(&extension.as_str()) { return Err("Not a supported image".into()); }
    let metadata = std::fs::metadata(&candidate).map_err(|_| "Image is unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 { return Err("Image is unavailable or exceeds 8 MB".into()); }
    let bytes = std::fs::read(&candidate).map_err(|_| "Image is unavailable")?;
    let valid = match extension.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()),
        _ => false,
    };
    if !valid { return Err("Image format does not match its filename".into()); }
    Ok(bytes)
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
    tauri::async_runtime::spawn_blocking(move || resize(&manager, &id, columns, rows)).await.map_err(|e| e.to_string())?
}
fn resize(manager: &ManualTerminals, id: &str, columns: u16, rows: u16) -> Result<(), String> {
    let slot = manager.slot(&id)?.ok_or("Open the agent first")?;
    if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
    let terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
    if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
    let terminal = terminal_slot.as_ref().ok_or("Open the agent first")?;
    let geometry = Geometry { rows: rows.clamp(2, 300), columns: columns.clamp(2, 500) };
    let mut replay = terminal.replay.lock().map_err(|_| "Terminal output is unavailable")?;
    if replay.geometry == geometry { return Ok(()); }
    terminal.master.resize(PtySize { rows: geometry.rows, cols: geometry.columns, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    replay.resized(geometry);
    Ok(())
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
    fn tui_config_preserves_inherited_jsonc_and_relative_plugins() {
        let root = std::env::temp_dir().join(format!("atris-tui-config-{}",std::process::id()));
        std::fs::create_dir_all(root.join("inherited")).unwrap();
        let inherited = root.join("inherited/tui.jsonc");
        let managed = root.join("tui.json");
        let source = r#"{/* comment */ "theme":"light", "plugin":[["./own.ts",{"url":"https://host/*literal*/"}],], "keybinds":{"x":"ctrl+x",},}"#;
        std::fs::write(&inherited,source).unwrap();
        std::fs::write(&managed,r#"// managed
{"plugin":["file:///managed.mjs"]}"#).unwrap();
        let merged = prepare_tui_config(managed.to_str().unwrap(),Some(inherited.to_str().unwrap())).unwrap();
        let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(merged).unwrap()).unwrap();
        assert_eq!(config["theme"],"light");
        assert_eq!(config["keybinds"]["x"],"ctrl+x");
        assert_eq!(config["plugin"][0][1]["url"],"https://host/*literal*/");
        assert_eq!(config["plugin"][0][0],root.join("inherited").join("./own.ts").to_string_lossy().as_ref());
        assert_eq!(config["plugin"][1],"file:///managed.mjs");
        assert_eq!(std::fs::read_to_string(inherited).unwrap(),source);
        assert!(read_jsonc("{/* unclosed").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn installed_opencode_tui_controls() {
        let Ok(fixture) = std::env::var("ATRIS_TEST_OPENCODE_FIXTURE") else { return; };
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
        let request: Launch = serde_json::from_value(fixture.clone()).unwrap();
        let id = request.id.clone();
        let root = PathBuf::from(fixture["root"].as_str().unwrap());
        let manager = ManualTerminals::default();
        struct Cleanup(ManualTerminals);
        impl Drop for Cleanup { fn drop(&mut self) { self.0.shutdown(); } }
        let _cleanup = Cleanup(manager.clone());
        start_with_cleanup(manager.clone(),request).unwrap();
        let mut sequence = 0;
        let mut output = String::new();
        let mut wait_for = |file: &str, matches: &dyn Fn(&serde_json::Value)->bool| {
            let deadline = std::time::Instant::now()+std::time::Duration::from_secs(45);
            loop {
                let snapshot = snapshot(&manager,id.clone(),sequence,false).unwrap();
                sequence = snapshot.sequence;
                output.push_str(&snapshot.output);
                if snapshot.output.contains("\x1b[6n") {
                    let slot = manager.slot(&id).unwrap().unwrap();
                    let slot = slot.terminal.lock().unwrap();
                    let mut writer = slot.as_ref().unwrap().writer.lock().unwrap();
                    writer.write_all(b"\x1b[1;1R").unwrap(); writer.flush().unwrap();
                }
                if let Ok(value) = std::fs::read_to_string(root.join(file)) {
                    if let Ok(value) = serde_json::from_str(&value) { if matches(&value) { return; } }
                }
                assert!(snapshot.status == "open" && std::time::Instant::now()<deadline,"OpenCode did not confirm {file}: route={:?}, output={output}",std::fs::read_to_string(root.join("opencode-route-state.json")));
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        wait_for("opencode-auto-mode.json", &|value|value["version"]==4 && value["enabled"]==false);
        // The previous low/none unit-test route is replaced with a fresh real high selection.
        std::fs::write(root.join("opencode-route.json"),r#"{"id":"native-high","model":"openai/test","reasoning":"high"}"#).unwrap();
        wait_for("opencode-route-state.json", &|value|value["id"]=="native-high" && value["applied"]==true);
        std::fs::write(root.join("opencode-route.json"),r#"{"id":"native-low","model":"openai/test","reasoning":"low"}"#).unwrap();
        wait_for("opencode-route-state.json", &|value|value["id"]=="native-low" && value["applied"]==true);
        std::fs::write(root.join("opencode-auto-request.json"),r#"{"id":"native-auto","enabled":true}"#).unwrap();
        wait_for("opencode-auto-mode.json", &|value|value["enabled"]==true);
        std::fs::write(root.join("opencode-auto-request.json"),r#"{"id":"native-normal","enabled":false}"#).unwrap();
        wait_for("opencode-auto-mode.json", &|value|value["enabled"]==false);
        let selected: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("state/opencode/model.json")).unwrap()).unwrap();
        assert_eq!(selected["variant"]["openai/test"],"low");
        resize(&manager,&id,57,46).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let replay = snapshot(&manager,id.clone(),0,false).unwrap();
        println!("Installed OpenCode TUI confirmed high → low reasoning and Auto → normal without submitting a provider prompt.");
        if let Ok(destination) = std::env::var("ATRIS_TEST_OPENCODE_CAPTURE") { std::fs::write(destination,serde_json::to_vec(&replay).unwrap()).unwrap(); }
        close_session(&manager,&id).unwrap();
    }

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
    fn project_image_preview_accepts_only_project_local_image_bytes() {
        let root = std::env::temp_dir().join(format!("atris-project-image-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let project = root.join("workspace");
        std::fs::create_dir_all(project.join("AtrisAgent")).unwrap();
        let image = b"\x89PNG\r\n\x1a\npreview";
        std::fs::write(project.join("AtrisAgent/screen.png"), image).unwrap();
        std::fs::write(root.join("private.png"), image).unwrap();
        std::fs::write(project.join("not-image.png"), b"private data").unwrap();
        assert_eq!(read_project_image(&project, "AtrisAgent/screen.png").unwrap(), image.to_vec());
        assert_eq!(read_project_image(&project, project.join("AtrisAgent/screen.png").to_str().unwrap()).unwrap(), image.to_vec());
        assert!(read_project_image(&project, "../private.png").is_err());
        assert!(read_project_image(&project, "not-image.png").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replay_is_bounded_and_preserves_monotonic_offsets() {
        let mut replay = Replay::new();
        for _ in 0..200 { replay.push("x".repeat(8192)); }
        assert!(replay.bytes <= REPLAY_LIMIT);
        assert_eq!(replay.sequence, 200);
        assert!(replay.chunks.front().unwrap().0 > 1);
    }

    #[test]
    fn replay_preserves_resize_boundaries_and_javascript_offsets() {
        let mut replay = Replay::new();
        replay.push("\x1b[Hready 🦀".into());
        let first = replay.sequence;
        replay.resized(Geometry { columns: 57, rows: 46 });
        replay.push("\x1b[46;1Hfooter".into());
        let (output, resizes) = replay.output_after(0, false);
        assert_eq!(output, "\x1b[Hready 🦀\x1b[46;1Hfooter");
        assert_eq!(resizes, vec![ReplayResize { offset: 0, columns: 120, rows: 30 }, ReplayResize { offset: 11, columns: 57, rows: 46 }]);
        assert_eq!(replay.output_after(first, false).1, vec![ReplayResize { offset: 0, columns: 57, rows: 46 }]);
        assert_eq!(replay.output_after(replay.sequence, false), (String::new(), Vec::new()));
        replay.resized(Geometry { columns: 80, rows: 24 });
        assert_eq!(replay.output_after(replay.sequence - 1, false), (String::new(), vec![ReplayResize { offset: 0, columns: 80, rows: 24 }]));
    }

    #[test]
    fn evicted_replay_keeps_geometry_of_the_retained_output() {
        let mut replay = Replay::new();
        replay.push("old".into());
        replay.resized(Geometry { columns: 57, rows: 46 });
        for _ in 0..200 { replay.push("x".repeat(8192)); }
        assert_eq!(replay.output_after(0, true).1, vec![ReplayResize { offset: 0, columns: 57, rows: 46 }]);
        // Empty resize events are bounded too.
        for _ in 0..5000 { replay.resized(Geometry { columns: 80, rows: 24 }); }
        assert!(replay.chunks.len() <= 4096);
    }

    #[cfg(windows)]
    #[test]
    fn real_pty_resize_replay_retains_screen_geometry() {
        let manager = ManualTerminals::default();
        let id = "00000000-0000-4000-8000-000000000099";
        let executable = std::path::PathBuf::from(std::env::var("WINDIR").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe").to_string_lossy().to_string();
        // A disposable full-screen TUI. It exits on its own; no user process or session is touched.
        let script = "$e=[char]27; $last=''; $end=(Get-Date).AddSeconds(5); [Console]::Write($e+'[?1049h'); while((Get-Date) -lt $end) { $w=[Console]::WindowWidth; $h=[Console]::WindowHeight; $key=$w.ToString()+'x'+$h; if($key -ne $last) { [Console]::Write($e+'[2J'+$e+'[1;1HHEADER-'+$key+$e+'[2;1H'+('TRANSCRIPT '*28)+$e+'['+$h+';1HFOOTER-'+$key); $last=$key }; Start-Sleep -Milliseconds 50 }";
        start(manager.clone(), Launch { id: id.into(), executable,
            args: vec!["-NoLogo".into(), "-NoProfile".into(), "-Command".into(), script.into()],
            cwd: std::env::temp_dir().to_string_lossy().to_string(), env: HashMap::new() }).unwrap();
        let wait_for = |after: u64, text: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
            let mut replied = false;
            loop {
                let result = snapshot(&manager, id.into(), after, false).unwrap();
                if !replied && result.output.contains("\x1b[6n") {
                    let slot = manager.slot(id).unwrap().unwrap();
                    let slot = slot.terminal.lock().unwrap();
                    let mut writer = slot.as_ref().unwrap().writer.lock().unwrap();
                    writer.write_all(b"\x1b[1;1R").unwrap(); writer.flush().unwrap(); replied = true;
                }
                if result.output.contains(text) { return result; }
                assert!(std::time::Instant::now() < deadline, "Native TUI did not emit {text}: {:?}", result.output);
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        };
        let initial = wait_for(0, "FOOTER-120x30");
        assert_eq!(initial.resizes.first(), Some(&ReplayResize { offset: 0, columns: 120, rows: 30 }));
        resize(&manager, id, 57, 20).unwrap();
        let narrow = wait_for(initial.sequence, "FOOTER-57x20");
        assert_eq!((narrow.columns, narrow.rows), (57, 20));
        let resize_events = || manager.slot(id).unwrap().unwrap().terminal.lock().unwrap().as_ref().unwrap().replay.lock().unwrap().chunks.iter().filter(|(_, text, _)| text.is_empty()).count();
        let events = resize_events();
        resize(&manager, id, 57, 20).unwrap();
        assert_eq!(resize_events(), events, "same-size resize must not emit a replay event");
        let replay = snapshot(&manager, id.into(), 0, false).unwrap();
        assert!(replay.resizes.iter().any(|size| size.columns == 120 && size.rows == 30));
        assert!(replay.resizes.iter().any(|size| size.columns == 57 && size.rows == 20));
        println!("TERMINAL_NATIVE_FIXTURE={}", serde_json::to_string(&serde_json::json!({ "initial": initial, "narrow": narrow, "replay": replay })).unwrap());
        // Keep the output reader alive until the fixture exits naturally.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while snapshot(&manager, id.into(), replay.sequence, true).unwrap().status == "open" {
            assert!(std::time::Instant::now() < deadline, "Native fixture failed to exit naturally");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
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
