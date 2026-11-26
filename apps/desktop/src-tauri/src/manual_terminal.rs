//! Manual terminals belong to the application, never to a mounted view or mission watchdog.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, io::{Read, Write}, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, path::{Path, PathBuf}, fs::OpenOptions};
use tauri::State;

const REPLAY_LIMIT: usize = 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq)]
struct Geometry { columns: u16, rows: u16 }
const INITIAL_GEOMETRY: Geometry = Geometry { columns: 120, rows: 30 };
#[derive(Serialize, Debug, PartialEq)]
struct ReplayResize { offset: usize, columns: u16, rows: u16 }
struct Replay { chunks: VecDeque<(u64, String, Geometry)>, sequence: u64, last_output: Option<(u64, std::time::Instant)>, bytes: usize, ended: bool, geometry: Geometry, input_ready: Option<bool>, signal_tail: String, agy_input: Option<AntigravityInput> }
impl Replay {
    fn new() -> Self { Self { chunks: VecDeque::new(), sequence: 0, last_output: None, bytes: 0, ended: false, geometry: INITIAL_GEOMETRY, input_ready: None, signal_tail: String::new(), agy_input: None } }
    fn push(&mut self, text: String) {
        if let Some(input) = &mut self.agy_input {
            if !text.is_empty() { input.update(&text); }
            self.input_ready = Some(input.bracketed && input.composer);
        } else if self.input_ready == Some(false) {
            self.signal_tail.push_str(&text);
            // Codex emits this terminal state only after protected startup screens.
            if self.signal_tail.contains("\x1b]7501;state=idle:app=codex\x1b\\") || self.signal_tail.contains("\x1b]7501;state=idle:app=codex\x07") {
                self.input_ready = Some(true);
                self.signal_tail.clear();
            } else if self.signal_tail.len() > 128 {
                let mut start = self.signal_tail.len() - 128;
                while !self.signal_tail.is_char_boundary(start) { start += 1; }
                self.signal_tail.drain(..start);
            }
        }
        self.sequence += 1;
        if !text.is_empty() { self.last_output = Some((self.sequence, std::time::Instant::now())); }
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
    fn recent_text_after(&self, after: u64) -> (String, bool) {
        let mut size = 0;
        let mut start = self.chunks.len();
        for (seq, text, _) in self.chunks.iter().rev() {
            if *seq <= after || size + text.len() > 32 * 1024 { break; }
            size += text.len();
            start -= 1;
        }
        let continuous = self.chunks.get(start).is_some_and(|(seq, _, _)| *seq == after + 1);
        let mut text = String::with_capacity(size);
        for (_, chunk, _) in self.chunks.iter().skip(start) { text.push_str(chunk); }
        (text, continuous)
    }
}

fn paste_output_settled(replay: &Replay, after: u64, started: std::time::Instant, now: std::time::Instant) -> bool {
    use std::time::Duration;
    // Silence by itself is not a repaint. Resize-only replay entries are not
    // output, either. Some TUIs insert pasted text asynchronously, after their
    // stdin handler has already returned and can receive the next key.
    now.duration_since(started) >= Duration::from_millis(250)
        && replay.last_output.is_some_and(|(sequence, at)| sequence > after && now.duration_since(at) >= Duration::from_millis(200))
}

// OpenCode collapses large multiline pastes in its composer. This is stronger
// evidence than terminal quiet: a working session's spinner never stops painting.
fn opencode_paste_summary(data: &str) -> Option<String> {
    let text = data.trim();
    let lines = text.bytes().filter(|byte| *byte == b'\n').count() + 1;
    (lines >= 3 || text.encode_utf16().count() > 150).then(|| format!("[Pasted ~{lines} lines]"))
}

fn output_contains_styled_text(output: &str, expected: &str) -> bool {
    if output.contains(expected) { return true; }
    terminal_text(output).contains(expected)
}

fn terminal_text(output: &str) -> String {
    // Parse ECMA-48 escape sequences properly: drop SGR/mode/OSC/DCS sequences,
    // convert CUF cursor-forward (\x1b[nC) into spaces (ConPTY emits CUF for spaces),
    // and turn cursor-positioning/erase-display codes into '\n' so fragments of
    // separate screen locations cannot fuse into a false acknowledgement.
    let bytes = output.as_bytes();
    let mut plain = String::with_capacity(output.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            if i + 1 >= bytes.len() { break; }
            match bytes[i + 1] {
                b'[' => {
                    let param_start = i + 2;
                    let mut j = param_start;
                    while j < bytes.len() && (0x30..=0x3f).contains(&bytes[j]) { j += 1; }
                    let param_end = j;
                    while j < bytes.len() && (0x20..=0x2f).contains(&bytes[j]) { j += 1; }
                    if j >= bytes.len() || !(0x40..=0x7e).contains(&bytes[j]) { break; }
                    let final_byte = bytes[j];
                    let params = &output[param_start..param_end];
                    match final_byte {
                        b'C' if !params.starts_with(|c: char| !c.is_ascii_digit() && c != ';') => {
                            let count = params.split(';').next().and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).clamp(1, 32);
                            for _ in 0..count { plain.push(' '); }
                        }
                        b'm' | b'h' | b'l' | b'q' | b'r' | b's' | b'u' | b'K' | b'n' | b'c' | b't' => {}
                        _ => plain.push('\n'),
                    }
                    i = j + 1;
                    continue;
                }
                b']' => {
                    let mut j = i + 2;
                    while j < bytes.len() {
                        if bytes[j] == 0x07 { j += 1; break; }
                        if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' { j += 2; break; }
                        j += 1;
                    }
                    i = j;
                    continue;
                }
                b'P' | b'_' | b'^' => {
                    let mut j = i + 2;
                    while j < bytes.len() {
                        if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' { j += 2; break; }
                        j += 1;
                    }
                    i = j;
                    continue;
                }
                b'(' | b')' | b'*' | b'+' => {
                    i = (i + 3).min(bytes.len());
                    while i < bytes.len() && !output.is_char_boundary(i) {
                        i += 1;
                    }
                    continue;
                }
                _ => {
                    i = (i + 2).min(bytes.len());
                    while i < bytes.len() && !output.is_char_boundary(i) {
                        i += 1;
                    }
                    continue;
                }
            }
        }
        let ch = output[i..].chars().next().unwrap();
        plain.push(ch);
        i += ch.len_utf8();
    }
    plain
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_ws = false;
    for ch in text.chars() {
        if ch.is_ascii_whitespace() {
            if !in_ws && !out.is_empty() {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(ch);
            in_ws = false;
        }
    }
    if out.ends_with(' ') { out.pop(); }
    out
}

#[derive(Default)]
struct AntigravityInput { tail: String, bracketed: bool, composer: bool, ready_since: Option<std::time::Instant> }
impl AntigravityInput {
    fn update(&mut self, text: &str) {
        self.tail.push_str(text);
        let on = self.tail.rfind("\x1b[?2004h");
        let off = self.tail.rfind("\x1b[?2004l");
        if on.is_some() || off.is_some() { self.bracketed = on > off; }
        let shown = terminal_text(&self.tail).to_ascii_lowercase();
        let ready = shown.rfind("? for shortcuts");
        let protected = [
            "trust the contents of this project",
            "yes, i trust this folder",
            "trust this folder?",
            "esc skip · ctrl+r review",
            "ctrl+r review",
        ]
            .iter().filter_map(|text| shown.rfind(text)).max();
        if ready.is_some() || protected.is_some() { self.composer = ready > protected; }
        if self.bracketed && self.composer { self.ready_since.get_or_insert_with(std::time::Instant::now); }
        else { self.ready_since = None; }
        let mut start = self.tail.len().saturating_sub(8192);
        while !self.tail.is_char_boundary(start) { start += 1; }
        self.tail.drain(..start);
    }
}

fn wait_for_antigravity_startup(replay: &Mutex<Replay>) -> Result<(), String> {
    use std::time::Duration;
    // The composer is painted before agy finishes its startup redraw on
    // Windows. Input sent in that interval can disappear from the composer.
    let warmup = Duration::from_millis(700);
    loop {
        let remaining = {
            let state = replay.lock().map_err(|_| "Terminal output is unavailable")?;
            if state.ended { return Err("Agent is not connected".into()); }
            let since = state.agy_input.as_ref().and_then(|input| input.ready_since).ok_or("Antigravity is not ready. Check Code.")?;
            warmup.saturating_sub(since.elapsed())
        };
        if remaining.is_zero() { return Ok(()); }
        std::thread::sleep(remaining.min(Duration::from_millis(25)));
    }
}

fn strip_composer_chrome(screen: &str) -> String {
    screen
        .lines()
        .map(|line| {
            line.trim_matches(|ch: char| {
                ch.is_ascii_whitespace()
                    || matches!(ch, '│' | '┃' | '║' | '╭' | '╰' | '╮' | '╯' | '─' | '━' | '>' | '❯')
            })
        })
        .collect::<Vec<_>>()
        .join("")
}

fn antigravity_paste_acknowledged(output: &str, data: &str) -> bool {
    let screen = terminal_text(output);
    let normalized = data.replace("\r\n", "\n");
    let raw_lines = normalized.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let trimmed_lines = normalized.trim_end_matches('\n').bytes().filter(|byte| *byte == b'\n').count() + 1;
    let char_count = normalized.chars().count();
    let trimmed_char_count = normalized.trim_end_matches('\n').chars().count();
    let byte_len = normalized.len();
    // Large pastes are collapsed by agy either by line count (`[Pasted text #2 +120 lines]`)
    // or by character count for long lines (`[Pasted text #1 1200 chars]`).
    let collapsed = screen.split("[Pasted text #").skip(1).any(|label| {
        if let Some((id, remainder)) = label.split_once(" +") {
            if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) {
                if let Some((count, _)) = remainder.split_once(" lines]") {
                    if count.parse::<usize>().ok().is_some_and(|n| {
                        n == raw_lines
                            || (normalized.ends_with('\n') && n == trimmed_lines)
                            || (raw_lines > 15 && n.abs_diff(raw_lines) <= 1)
                    }) {
                        return true;
                    }
                }
            }
        }
        if let Some((id, remainder)) = label.split_once(' ') {
            if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) {
                if let Some((count, _)) = remainder.split_once(" chars]") {
                    if count.parse::<usize>().ok().is_some_and(|n| {
                        (n >= trimmed_char_count.saturating_sub(2) && n <= byte_len + 2)
                            || n.abs_diff(char_count) <= 2
                    }) {
                        return true;
                    }
                }
            }
        }
        false
    });
    if collapsed { return true; }
    let non_empty: Vec<String> = normalized
        .lines()
        .map(collapse_whitespace)
        .filter(|line| !line.is_empty())
        .collect();
    let Some(last) = non_empty.last() else { return false; };
    // Avoid false positives from very short trailing delimiters like "---" or "}"
    // when an earlier substantive line exists in the same prompt.
    let primary = if last.chars().count() < 8 {
        non_empty.iter().rev().find(|line| line.chars().count() >= 8).unwrap_or(last)
    } else {
        last
    };
    let mut anchors: Vec<&str> = vec![primary.as_str()];
    // If a multi-line prompt (under the collapse threshold) scrolled in EditArea,
    // also accept a substantive first line as confirmation.
    if non_empty.len() >= 4 {
        if let Some(first_long) = non_empty.iter().find(|line| line.chars().count() >= 12) {
            if first_long.as_str() != primary.as_str() {
                anchors.push(first_long.as_str());
            }
        }
    }
    let flat_screen = collapse_whitespace(&screen);
    let unwrapped: String = screen.chars().filter(|&ch| ch != '\r' && ch != '\n').collect();
    let dechromed = strip_composer_chrome(&screen);
    for anchor in anchors {
        let mut start = if anchor.len() <= 96 { 0 } else { anchor.len().saturating_sub(48) };
        while !anchor.is_char_boundary(start) { start += 1; }
        let needle = &anchor[start..];
        if screen.contains(needle) || flat_screen.contains(needle) { return true; }
        if needle.chars().count() >= 12 {
            if unwrapped.contains(needle) || dechromed.contains(needle) { return true; }
        }
    }
    false
}

fn consume_terminal_protocol_reply(data: &str) -> Option<&str> {
    if let Some(rest) = data.strip_prefix("\x1b[") {
        // Focus in/out (\x1b[I, \x1b[O)
        if let Some(after) = rest.strip_prefix('I').or_else(|| rest.strip_prefix('O')) {
            return Some(after);
        }
        // DSR (\x1b[0n)
        if let Some(after) = rest.strip_prefix("0n") {
            return Some(after);
        }
        let bytes = rest.as_bytes();
        let mut i = 0;
        while i < bytes.len() && (0x30..=0x3f).contains(&bytes[i]) { i += 1; }
        let param_end = i;
        while i < bytes.len() && (0x20..=0x2f).contains(&bytes[i]) { i += 1; }
        if i >= bytes.len() { return None; }
        let params = &rest[..param_end];
        let inter = &rest[param_end..i];
        let final_byte = bytes[i];
        let after = &rest[i + 1..];
        // Cursor Position Report (\x1b[row;colR)
        if final_byte == b'R' && inter.is_empty() {
            if let Some((row, col)) = params.split_once(';') {
                if [row, col].iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())) {
                    return Some(after);
                }
            }
        }
        // Device Attributes (\x1b[?...c or \x1b[>...c)
        if final_byte == b'c' && inter.is_empty() {
            if let Some(attrs) = params.strip_prefix('?').or_else(|| params.strip_prefix('>')) {
                if !attrs.is_empty() && attrs.bytes().all(|b| b.is_ascii_digit() || b == b';') {
                    return Some(after);
                }
            }
        }
        // Kitty keyboard protocol query reply (\x1b[?<flags>u)
        if final_byte == b'u' && inter.is_empty() {
            if let Some(flags) = params.strip_prefix('?') {
                if !flags.is_empty() && flags.bytes().all(|b| b.is_ascii_digit()) {
                    return Some(after);
                }
            }
        }
        // XTWINOPS window size/state reply (\x1b[<digits>;...t)
        if final_byte == b't' && inter.is_empty() {
            if !params.is_empty() && params.contains(';') && params.bytes().all(|b| b.is_ascii_digit() || b == b';') {
                return Some(after);
            }
        }
        // DECRPM Mode Report (\x1b[?2004;1$y or \x1b[2004;1$y)
        if final_byte == b'y' && inter == "$" {
            let body = params.strip_prefix('?').unwrap_or(params);
            if let Some((mode, val)) = body.split_once(';') {
                if [mode, val].iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())) {
                    return Some(after);
                }
            }
        }
        return None;
    }
    // OSC replies (e.g. OSC 10/11 color queries)
    if let Some(rest) = data.strip_prefix("\x1b]") {
        let bytes = rest.as_bytes();
        let mut i = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
        if i == 0 || i >= bytes.len() || bytes[i] != b';' { return None; }
        let mut j = i + 1;
        while j < bytes.len() {
            if bytes[j] == 0x07 { return Some(&rest[j + 1..]); }
            if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' { return Some(&rest[j + 2..]); }
            j += 1;
        }
        return None;
    }
    // DCS / APC replies (e.g. XTVERSION \x1bP>|...\x1b\\ or Kitty graphics \x1b_G...\x1b\\)
    if let Some(rest) = data.strip_prefix("\x1bP").or_else(|| data.strip_prefix("\x1b_")) {
        if let Some(end) = rest.find("\x1b\\") {
            return Some(&rest[end + 2..]);
        }
        return None;
    }
    None
}

fn terminal_protocol_reply(data: &str) -> bool {
    // xterm returns cursor positions, device attributes, focus events, DECRPM,
    // OSC color and DCS version replies on the same onData channel as keystrokes.
    // Only exact reply shapes (single or batched) are exempt.
    if data.is_empty() { return false; }
    let mut remaining = data;
    while !remaining.is_empty() {
        let Some(next) = consume_terminal_protocol_reply(remaining) else { return false; };
        remaining = next;
    }
    true
}

struct Terminal {
    master: Box<dyn MasterPty + Send>, writer: Arc<Mutex<Box<dyn Write + Send>>>, child: Box<dyn Child + Send + Sync>,
    replay: Arc<Mutex<Replay>>, closed: bool, opencode: bool, antigravity: bool, paste_pending: Arc<AtomicBool>, paste_epoch: Arc<AtomicU64>,
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
pub struct Launch { id: String, executable: String, args: Vec<String>, cwd: String, #[serde(default)] env: HashMap<String, String>, #[serde(default)] runtime_type: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { id: String, status: String, sequence: u64, output: String, reset: bool, columns: u16, rows: u16, resizes: Vec<ReplayResize>, input_ready: Option<bool> }

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
    let mut opencode_plugin: Option<String> = None;
    let mut opencode_mcp: Option<String> = None;
    for (key, value) in request.env {
        if key == "ATRIS_MANUAL_OPENCODE_TUI_CONFIG" {
            let config_file = prepare_tui_config(&value, std::env::var("OPENCODE_TUI_CONFIG").ok().as_deref())?;
            command.env("OPENCODE_TUI_CONFIG", config_file);
            continue;
        }
        if key == "ATRIS_MANUAL_OPENCODE_PLUGIN" {
            opencode_plugin = Some(value);
            continue;
        }
        if key == "ATRIS_MANUAL_OPENCODE_MCP" {
            opencode_mcp = Some(value);
            continue;
        }
        if !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "ATRIS_CODEX_REMOTE_TOKEN", "ATRIS_CONTROL_PLANE_URL", "ATRIS_CONTROL_PLANE_TOKEN", "ATRIS_MANUAL_COORDINATION"].contains(&key.as_str()) { return Err("Unsupported CLI environment override".into()); }
        command.env(key, value);
    }
    let opencode = opencode_plugin.is_some() || opencode_mcp.is_some()
        || Path::new(&request.executable).file_stem().and_then(|name| name.to_str()).is_some_and(|name| name.eq_ignore_ascii_case("opencode"));
    if opencode_plugin.is_some() || opencode_mcp.is_some() {
        let mut config: serde_json::Value = match std::env::var("OPENCODE_CONFIG_CONTENT") {
            Ok(value) => serde_json::from_str(&value).map_err(|_| "Inherited OpenCode configuration is not valid JSON")?,
            Err(_) => serde_json::json!({}),
        };
        let object = config.as_object_mut().ok_or("Inherited OpenCode configuration must be an object")?;
        if let Some(plugin) = opencode_plugin {
            let plugins = object.entry("plugin").or_insert_with(|| serde_json::json!([])).as_array_mut().ok_or("OpenCode plugin configuration must be an array")?;
            let plugin = serde_json::Value::String(plugin);
            if !plugins.contains(&plugin) { plugins.push(plugin); }
        }
        if let Some(mcp) = opencode_mcp {
            let mut value: serde_json::Value = serde_json::from_str(&mcp).map_err(|_| "Invalid coordination configuration")?;
            let major = value.get("major").and_then(|v| v.as_u64()).unwrap_or(1);
            let server = value.get_mut("server").map(serde_json::Value::take).ok_or("Missing coordination server")?;
            let mcp = object.entry("mcp").or_insert_with(|| serde_json::json!({})).as_object_mut().ok_or("OpenCode MCP configuration must be an object")?;
            let servers = if major >= 2 { mcp.entry("servers").or_insert_with(|| serde_json::json!({})).as_object_mut().ok_or("OpenCode MCP servers must be an object")? } else { mcp };
            if servers.contains_key("atris_workspace") { return Err("The atris_workspace MCP name is already in use".into()); }
            servers.insert("atris_workspace".into(), server);
        }
        command.env("OPENCODE_CONFIG_CONTENT", serde_json::to_string(&config).map_err(|_| "Could not prepare OpenCode configuration")?);
    }
    // Acquire handles before spawn so a handle error cannot orphan a newly started CLI.
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let antigravity = request.runtime_type == "antigravity" || Path::new(&request.executable).file_stem().and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("agy") || name.eq_ignore_ascii_case("antigravity"));
    let mut initial_replay = Replay::new();
    if antigravity { initial_replay.agy_input = Some(AntigravityInput::default()); }
    if antigravity || request.args.iter().any(|arg| arg.starts_with("atris-manual-")) { initial_replay.input_ready = Some(false); }
    let replay = Arc::new(Mutex::new(initial_replay));
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
    let mut terminal = Terminal { master: pair.master, writer, child, replay, closed: false, opencode, antigravity, paste_pending: Arc::new(AtomicBool::new(false)), paste_epoch: Arc::new(AtomicU64::new(0)) };
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
        columns: INITIAL_GEOMETRY.columns, rows: INITIAL_GEOMETRY.rows, resizes: Vec::new(), input_ready: None };
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
        columns: replay.geometry.columns, rows: replay.geometry.rows, resizes, input_ready: replay.input_ready };
    drop(replay);
    // Snapshot is observational. Status-only polling can race with the full
    // output poll, so only an explicit close may release the terminal slot.
    Ok(snapshot)
}
#[tauri::command]
pub async fn manual_terminal_write(state: State<'_, ManualTerminals>, id: String, data: String, paste: bool) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || write_input(&manager, &id, &data, paste)).await.map_err(|e| e.to_string())?
}
fn write_input(manager: &ManualTerminals, id: &str, data: &str, paste: bool) -> Result<(), String> {
    let normalized: std::borrow::Cow<'_, str> = if paste && data.contains("\r\n") {
        std::borrow::Cow::Owned(data.replace("\r\n", "\n"))
    } else {
        std::borrow::Cow::Borrowed(data)
    };
    let data = normalized.as_ref();
    if data.len() > 65536 { return Err("Terminal input is too large".into()); }
    if paste && data.chars().any(|c| c.is_control() && c != '\n' && c != '\t') { return Err("Message contains unsupported control characters".into()); }
    let slot = manager.slot(id)?.ok_or("Open the agent first")?;
    if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
    let mut terminal_slot = slot.terminal.lock().map_err(|_| "Agent state is unavailable")?;
    if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
    let terminal = terminal_slot.as_mut().ok_or("Open the agent first")?;
    if terminal.closed || !matches!(terminal.child.try_wait(), Ok(None)) { return Err("Agent is not connected".into()); }
    let antigravity = terminal.antigravity;
    let writer = terminal.writer.clone();
    let replay = terminal.replay.clone();
    let opencode = terminal.opencode;
    let paste_pending = terminal.paste_pending.clone();
    let paste_epoch = terminal.paste_epoch.clone();
    let codex = !antigravity && replay.lock().map_err(|_| "Terminal output is unavailable")?.input_ready.is_some();
    // A full PTY input buffer must not prevent Close from reaching the child.
    drop(terminal_slot);
    if paste && antigravity { wait_for_antigravity_startup(&replay)?; }
    let mut input = writer.lock().map_err(|_| "Terminal input is unavailable")?;
    if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
    if paste {
        if paste_pending.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err("A previous message is still pending in Code. Inspect the terminal and finish that message before sending another; nothing was pasted again.".into());
        }
        struct ClearPastePending(Arc<AtomicBool>);
        impl Drop for ClearPastePending {
            fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
        }
        let _paste_guard = ClearPastePending(paste_pending.clone());
        let after = {
            let state = replay.lock().map_err(|_| "Terminal output is unavailable")?;
            if state.input_ready == Some(false) {
                return Err(if antigravity { "Antigravity is not ready. Check Code." } else { "Codex is still starting. Your draft is kept; check CLI setup in Code." }.into());
            }
            state.sequence
        };
        let epoch = paste_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        input.write_all(format!("\x1b[200~{}\x1b[201~", data).as_bytes()).map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())?;
        // Terminal replies (e.g. cursor position), manual recovery and interrupt
        // must still reach the PTY while the CLI paints the paste.
        drop(input);
        // Codex's Win32 input path can classify ConPTY paste as key bursts.
        // Enter inside its 120 ms suppression window becomes a newline.
        // Wait for the paste repaint to settle as well, so a long input's
        // queued keys cannot make the delay expire before the CLI reads them.
        let started = std::time::Instant::now();
        let mut quiet_since = started;
        let mut sequence = after;
        // The Windows console can take seconds to decode tens of thousands
        // of keys. A timer alone cannot acknowledge that paste. Codex's
        // collapsed-paste label includes the received Unicode character count.
        let paste_labels = (codex && data.chars().count() > 1000).then(|| {
            let count = data.chars().count();
            // Win32 may insert the held first character directly before
            // collapsing the remainder. Both spellings acknowledge all keys.
            [format!("Pasted Content {count} chars"), format!("Pasted Content {} chars", count - 1)]
        });
        let mut acknowledged_at = None;
        let mut signal_sequence = after;
        let mut signal_tail = String::new();
        let open_summary = opencode.then(|| opencode_paste_summary(data)).flatten();
        let open_echo = if opencode {
            // The final line can be rendered after earlier wrapped lines.
            data.trim().lines().last().filter(|line| (12..=96).contains(&line.chars().count()))
        } else { None };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(25));
            if slot.closing.load(Ordering::SeqCst) { return Err("Agent is closing".into()); }
            if paste_epoch.load(Ordering::SeqCst) != epoch { return Err("Automatic submit canceled by Code input. Check the terminal; the draft is kept.".into()); }
            let state = replay.lock().map_err(|_| "Terminal output is unavailable")?;
            if state.ended { return Err("Agent disconnected before the message could be submitted.".into()); }
            if antigravity && state.input_ready != Some(true) { return Err("Antigravity is waiting for input in Code. Message not submitted.".into()); }
            let current = state.sequence;
            let settled = !codex && paste_output_settled(&state, after, started, std::time::Instant::now());
            let next_signal = if acknowledged_at.is_none() && current != signal_sequence && (antigravity || opencode || paste_labels.is_some()) {
                let result = state.recent_text_after(signal_sequence);
                signal_sequence = current;
                Some(result)
            } else { None };
            drop(state);
            if let Some((text, continuous)) = next_signal {
                if !continuous { signal_tail.clear(); }
                signal_tail.push_str(&text);
                let expected = open_summary.as_deref().into_iter().chain(open_echo)
                    .chain(paste_labels.iter().flatten().map(String::as_str));
                if (antigravity && antigravity_paste_acknowledged(&signal_tail, data)) || expected.into_iter().any(|text| output_contains_styled_text(&signal_tail, text)) {
                    acknowledged_at = Some(std::time::Instant::now());
                }
                let mut trim = signal_tail.len().saturating_sub(16384);
                while !signal_tail.is_char_boundary(trim) { trim += 1; }
                signal_tail.drain(..trim);
            }
            if current != sequence { sequence = current; quiet_since = std::time::Instant::now(); }
            if !codex {
                if antigravity {
                    if acknowledged_at.is_some_and(|at: std::time::Instant| {
                        at.elapsed() >= std::time::Duration::from_millis(150)
                            && (quiet_since.elapsed() >= std::time::Duration::from_millis(120)
                                || at.elapsed() >= std::time::Duration::from_millis(800))
                    }) { break; }
                    if acknowledged_at.is_none()
                        && current > after
                        && started.elapsed() >= std::time::Duration::from_millis(1500)
                        && quiet_since.elapsed() >= std::time::Duration::from_millis(450)
                    { break; }
                    if started.elapsed() >= std::time::Duration::from_secs(10) {
                        return Err("Paste attempted, but the CLI did not confirm it. Nothing was submitted automatically. Check the active screen in Code before continuing.".into());
                    }
                    continue;
                }
                if acknowledged_at.is_some_and(|at: std::time::Instant| at.elapsed() >= std::time::Duration::from_millis(90)) { break; }
                if acknowledged_at.is_none() && settled { break; }
                if started.elapsed() >= std::time::Duration::from_secs(if opencode { 10 } else { 5 }) {
                    return Err("Paste attempted, but the CLI did not confirm it. Nothing was submitted automatically. Check the active screen in Code before continuing.".into());
                }
                continue;
            }
            if paste_labels.is_some() {
                if acknowledged_at.map(|at: std::time::Instant| at.elapsed() >= std::time::Duration::from_millis(200)).unwrap_or(false) { break; }
                if started.elapsed() >= std::time::Duration::from_secs(30) {
                    return Err("Message was pasted but Codex did not confirm the complete input. Open Code to inspect it and press Enter once; it was not submitted automatically.".into());
                }
                continue;
            }
            if started.elapsed() >= std::time::Duration::from_millis(250)
                && quiet_since.elapsed() >= std::time::Duration::from_millis(200) { break; }
            if started.elapsed() >= std::time::Duration::from_secs(2) { break; }
        }
        // Exactly one submit key; never retry Enter against an unknown dialog.
        input = writer.lock().map_err(|_| "Terminal input is unavailable")?;
        {
            let state = replay.lock().map_err(|_| "Terminal output is unavailable")?;
            if slot.closing.load(Ordering::SeqCst) || state.ended { return Err("Agent disconnected before the message could be submitted.".into()); }
            if antigravity && state.input_ready != Some(true) { return Err("Antigravity is waiting for input in Code. Message not submitted.".into()); }
        }
        if paste_epoch.load(Ordering::SeqCst) != epoch { return Err("Automatic submit canceled by Code input. Check the terminal; the draft is kept.".into()); }
        input.write_all(b"\r").map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())?;
        return Ok(());
    } else {
        let resolves_paste = matches!(data, "\r" | "\n" | "\r\n" | "\x03" | "\x15" | "\x1b");
        if paste_pending.load(Ordering::SeqCst) && !terminal_protocol_reply(data) { paste_epoch.fetch_add(1, Ordering::SeqCst); }
        input.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        if resolves_paste { paste_pending.store(false, Ordering::SeqCst); }
    }
    input.flush().map_err(|e| e.to_string())?;
    Ok(())
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
fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    }
}
fn percent_decode_path(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = ((bytes[i + 1] as char).to_digit(16), (bytes[i + 2] as char).to_digit(16)) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| "Invalid image path".into())
}
fn read_project_image(root: &Path, reference: &str) -> Result<Vec<u8>, String> {
    read_project_image_with_home(root, reference, user_home_dir().as_deref())
}
fn read_project_image_with_home(root: &Path, reference: &str, home_dir: Option<&Path>) -> Result<Vec<u8>, String> {
    if reference.is_empty() || reference.len() > 2048 || reference.chars().any(char::is_control) { return Err("Invalid image path".into()); }
    let clean = reference.trim();
    let stripped = if clean.to_ascii_lowercase().starts_with("file://") {
        let after_scheme = &clean[7..];
        #[cfg(windows)]
        let normalized = {
            let bytes = after_scheme.as_bytes();
            if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
                &after_scheme[1..]
            } else {
                after_scheme
            }
        };
        #[cfg(not(windows))]
        let normalized = after_scheme;
        percent_decode_path(normalized)?
    } else {
        clean.to_string()
    };
    if stripped.is_empty() || stripped.chars().any(char::is_control) { return Err("Invalid image path".into()); }
    let supplied = Path::new(&stripped);
    let canonical_root = if !root.as_os_str().is_empty() {
        std::fs::canonicalize(root).ok().filter(|p| p.is_dir())
    } else {
        None
    };
    let candidate_input = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        let base = canonical_root.as_ref().ok_or("Project is unavailable")?;
        base.join(supplied)
    };
    let candidate = std::fs::canonicalize(candidate_input).map_err(|_| "Image is unavailable")?;
    let in_project = canonical_root.as_ref().map(|r| candidate.starts_with(r)).unwrap_or(false);
    let in_attachments = supplied.is_absolute() && {
        let attachments = std::env::temp_dir().join("atris-agent-attachments");
        std::fs::canonicalize(&attachments).map(|t| candidate.starts_with(t)).unwrap_or(false)
    };
    let in_antigravity_brain = supplied.is_absolute() && home_dir.map(|h| {
        [
            h.join(".gemini").join("antigravity-cli").join("brain"),
            h.join(".gemini").join("antigravity").join("brain"),
        ]
        .into_iter()
        .filter_map(|d| std::fs::canonicalize(d).ok())
        .any(|brain_root| candidate.starts_with(&brain_root))
    }).unwrap_or(false);
    if !in_project && !in_attachments && !in_antigravity_brain { return Err("Image is outside this project".into()); }
    let extension = candidate.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif"].contains(&extension.as_str()) { return Err("Not a supported image".into()); }
    let metadata = std::fs::metadata(&candidate).map_err(|_| "Image is unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 { return Err("Image is unavailable or exceeds 8 MB".into()); }
    let bytes = std::fs::read(&candidate).map_err(|_| "Image is unavailable")?;
    let is_png = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
    let is_jpeg = bytes.starts_with(b"\xff\xd8\xff");
    let is_gif = bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a");
    let is_webp = bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice());
    if !(is_png || is_jpeg || is_gif || is_webp) { return Err("Image format is not a supported image".into()); }
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
    fn opencode_multiline_echo_can_be_confirmed_while_background_frames_continue() {
        use std::time::{Duration, Instant};
        let label = opencode_paste_summary("  Edit the file\n\nAttached files:\n- diagram.png \n").unwrap();
        assert_eq!(label, "[Pasted ~4 lines]");
        let mut replay = Replay::new();
        let after = replay.sequence;
        let started = Instant::now();
        replay.push("\x1b[9;2H\x1b[38;5;214m[Pasted ~".into());
        replay.push("4\x1b[1m lines]\x1b[0m".into());
        replay.push("\x1b[14;2H⠋ working".into());
        let now = started + Duration::from_secs(2);
        replay.last_output = Some((replay.sequence, now - Duration::from_millis(20)));
        assert!(!paste_output_settled(&replay, after, started, now));
        assert!(output_contains_styled_text(&replay.output_after(after, false).0, &label));
        assert!(!output_contains_styled_text("[Pasted ~4\x1b[12;2H lines]", &label));
    }
    #[test]
    fn automatic_enter_waits_for_delayed_paste_output_not_silence_or_resize() {
        use std::time::{Duration, Instant};
        let mut replay = Replay::new();
        replay.push("original prompt".into());
        let after = replay.sequence;
        let started = Instant::now();
        replay.resized(Geometry { columns: 80, rows: 24 });
        assert!(!paste_output_settled(&replay, after, started, started + Duration::from_millis(500)));

        let echo_at = started + Duration::from_millis(700);
        replay.push("pasted prompt".into());
        replay.last_output = Some((replay.sequence, echo_at));
        assert!(!paste_output_settled(&replay, after, started, echo_at + Duration::from_millis(199)));
        assert!(paste_output_settled(&replay, after, started, echo_at + Duration::from_millis(200)));
    }
    #[test]
    fn codex_readiness_requires_a_complete_cli_signal() {
        let mut replay = Replay::new();
        replay.input_ready = Some(false);
        replay.push("Folder access\nTrust and continue\n".into());
        assert_eq!(replay.input_ready, Some(false));
        replay.push("\x1b]7501;state=idle:app=codex".into());
        assert_eq!(replay.input_ready, Some(false));
        replay.push("\x1b\\".into());
        assert_eq!(replay.input_ready, Some(true));
        let mut other = Replay::new();
        other.push("\x1b]7501;state=idle:app=codex\x07".into());
        assert_eq!(other.input_ready, None, "Other providers retain their existing input behavior");
    }
    #[cfg(windows)]
    #[test]
    fn installed_codex_first_chat_paste_submits_once() {
        let Ok(fixture) = std::env::var("ATRIS_TEST_CODEX_PASTE_FIXTURE") else { return; };
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
        let request: Launch = serde_json::from_value(fixture["launch"].clone()).unwrap();
        let id = request.id.clone();
        let received = PathBuf::from(fixture["received"].as_str().unwrap());
        let prompt = fixture["prompt"].as_str().unwrap();
        let manager = ManualTerminals::default();
        struct Cleanup(ManualTerminals);
        impl Drop for Cleanup { fn drop(&mut self) { self.0.shutdown(); } }
        let _cleanup = Cleanup(manager.clone());
        start_with_cleanup(manager.clone(), request).unwrap();
        let mut sequence = 0;
        let mut output = String::new();
        let mut cursor_replied = false;
        let mut read = || {
            let result = snapshot(&manager, id.clone(), sequence, false).unwrap();
            sequence = result.sequence;
            if !cursor_replied && result.output.contains("\x1b[6n") {
                write_input(&manager, &id, "\x1b[1;1R", false).unwrap();
                cursor_replied = true;
            }
            output.push_str(&result.output);
            assert_eq!(result.status, "open", "Codex exited during setup: {output}");
            output.clone()
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
        loop {
            let output = read();
            if snapshot(&manager, id.clone(), 0, true).unwrap().input_ready == Some(true) { break; }
            assert!(std::time::Instant::now() < deadline, "Codex startup did not finish: {output}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        read();
        write_input(&manager, &id, prompt, true).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        loop {
            let output = read();
            if received.is_file() { break; }
            assert!(std::time::Instant::now() < deadline, "First pasted message never reached the local provider: {output}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let bodies = std::fs::read_to_string(&received).unwrap();
        let requests: Vec<serde_json::Value> = bodies.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(requests.len(), 1, "Chat must issue one submission, not repeated Enter retries");
        let sent = requests[0]["input"].as_array().unwrap().iter().any(|item| item["role"] == "user" && item["content"].as_array().map(|content| content.iter().any(|part| part["text"] == prompt)).unwrap_or(false));
        assert!(sent, "The complete pasted prompt must reach the local provider unchanged");
        println!("Installed Codex started without folder/hook/permission prompts; first {}-character paste submitted exactly once through real ConPTY.", prompt.chars().count());
    }
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
    fn installed_codex_live_permissions() {
        let Ok(filename) = std::env::var("ATRIS_TEST_CODEX_LIVE_FIXTURE") else { return; };
        let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(filename).unwrap()).unwrap();
        let request: Launch = serde_json::from_value(fixture["launch"].clone()).unwrap();
        let id = request.id.clone();
        let root = PathBuf::from(fixture["root"].as_str().unwrap());
        let prompts = fixture["prompts"].as_array().unwrap();
        let manager = ManualTerminals::default();
        struct Cleanup(ManualTerminals);
        impl Drop for Cleanup { fn drop(&mut self) { self.0.shutdown(); } }
        let _cleanup = Cleanup(manager.clone());
        start_with_cleanup(manager.clone(), request).unwrap();
        let mut cursor_replied = false;
        let mut fixture_trusted = false;
        let mut output = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
        loop {
            let frame = snapshot(&manager, id.clone(), 0, false).unwrap();
            output.clone_from(&frame.output);
            if !cursor_replied && output.contains("\x1b[6n") {
                write_input(&manager, &id, "\x1b[1;1R", false).unwrap(); cursor_replied = true;
            }
            // This test is opt-in and trusts only its disposable fixture directory.
            if !fixture_trusted && output.contains("Trust and continue") {
                std::thread::sleep(std::time::Duration::from_millis(500));
                write_input(&manager, &id, "\r", false).unwrap(); fixture_trusted = true;
            }
            if frame.input_ready == Some(true) { break; }
            if frame.status != "open" || std::time::Instant::now() >= deadline {
                if fixture["allowDiagnosticCapture"] == true { std::fs::write(root.join("native-startup.txt"), &output).unwrap(); }
                panic!("Codex fixture did not become input-ready");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::fs::write(root.join("native-ready"), b"ready").unwrap();
        for (index, prompt) in prompts.iter().enumerate() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
            while !root.join(format!("send-{index}")).is_file() {
                assert!(std::time::Instant::now() < deadline, "Controller did not request the next native turn");
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            write_input(&manager, &id, prompt.as_str().unwrap(), true).unwrap();
            std::fs::write(root.join(format!("sent-{index}")), b"sent").unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        while !root.join("finish").is_file() {
            assert!(std::time::Instant::now() < deadline, "Controller did not finish acceptance");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        close_session(&manager, &id).unwrap();
        assert!(!manager.has_live_sessions());
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

    #[cfg(windows)]
    #[test]
    fn installed_antigravity_local_command_from_chat() {
        let (Ok(executable), Ok(cwd)) = (std::env::var("ATRIS_TEST_AGY_EXECUTABLE"), std::env::var("ATRIS_TEST_AGY_TRUSTED_CWD")) else { return; };
        use std::time::{Duration, Instant};
        let root = std::env::temp_dir().join(format!("atris-agy-pty-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let manager = ManualTerminals::default();
        struct Cleanup(ManualTerminals, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) { self.0.shutdown(); let _ = std::fs::remove_dir_all(&self.1); }
        }
        let _cleanup = Cleanup(manager.clone(), root.clone());
        let id = "00000000-0000-4000-8000-000000000041";
        let start_trusted = |id: &str| {
            start_with_cleanup(manager.clone(), Launch { id: id.into(), executable: executable.clone(), cwd: cwd.clone(), env: HashMap::new(), runtime_type: "antigravity".into(),
                args: vec!["--log-file".into(), root.join(format!("{id}.log")).to_string_lossy().into_owned()] }).unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut answered_cursor = false;
            loop {
                let frame = snapshot(&manager, id.into(), 0, false).unwrap();
                if !answered_cursor && frame.output.contains("\x1b[6n") {
                    write_input(&manager, id, "\x1b[1;1R", false).unwrap();
                    answered_cursor = true;
                }
                assert!(!output_contains_styled_text(&frame.output, "trust the contents"), "Fixture directory is not already trusted; no approval was sent");
                if frame.input_ready == Some(true) { break; }
                assert!(frame.status == "open" && Instant::now() < deadline, "Antigravity composer did not appear");
                std::thread::sleep(Duration::from_millis(25));
            }
        };
        start_trusted(id);
        // Verify a real local slash command (/help) actually submits on Enter (opening Help dialog),
        // then dismiss it with Esc, and verify /exit submits and exits cleanly.
        let before_help = snapshot(&manager, id.into(), 0, true).unwrap().sequence;
        write_input(&manager, id, "/help", true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let frame = snapshot(&manager, id.into(), before_help, false).unwrap();
            let help_output = terminal_text(&frame.output);
            let plain = help_output.to_ascii_lowercase();
            if plain.contains("slash commands") || plain.contains("keyboard shortcuts") || plain.contains("available commands") || plain.contains("/clear") { break; }
            assert!(frame.status == "open" && Instant::now() < deadline, "Antigravity did not submit /help on Enter. Screen:\n{help_output}");
            std::thread::sleep(Duration::from_millis(50));
        }
        println!("AGY /help submitted cleanly!");
        write_input(&manager, id, "\x1b", false).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        write_input(&manager, id, "/exit", true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if snapshot(&manager, id.into(), 0, true).unwrap().status == "exited" { break; }
            assert!(Instant::now() < deadline, "Antigravity did not submit the local exit command. Screen:\n{}", terminal_text(&snapshot(&manager, id.into(), before_help, false).unwrap().output));
            std::thread::sleep(Duration::from_millis(50));
        }

        let long_id = "00000000-0000-4000-8000-000000000043";
        start_trusted(long_id);
        let slot = manager.slot(long_id).unwrap().unwrap();
        let replay = slot.terminal.lock().unwrap().as_ref().unwrap().replay.clone();
        wait_for_antigravity_startup(&replay).unwrap();
        // Verify long single-line paste (>1000 chars -> [Pasted text #N <N> chars]) and 16-line paste against real agy.
        let long_single_line = "Uzun tek satırlı Türkçe test promptu ".repeat(35);
        let sixteen_lines = (1..=16).map(|i| format!("Line {i}: Antigravity multiline check")).collect::<Vec<_>>().join("\n");
        for fixture in [long_single_line.as_str(), sixteen_lines.as_str()] {
            let before = snapshot(&manager, long_id.into(), 0, true).unwrap().sequence;
            write_input(&manager, long_id, &format!("\x1b[200~{fixture}\x1b[201~"), false).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let frame = snapshot(&manager, long_id.into(), before, false).unwrap();
                if antigravity_paste_acknowledged(&frame.output, fixture) { break; }
                assert!(frame.status == "open" && Instant::now() < deadline, "Antigravity did not confirm collapsed paste fixture (len={}): {:?}", fixture.len(), terminal_text(&frame.output));
                std::thread::sleep(Duration::from_millis(25));
            }
            write_input(&manager, long_id, "\x15\x1b", false).unwrap();
            std::thread::sleep(Duration::from_millis(120));
        }
        // Verify narrow-pane wrapped Turkish prompt, attachment path, and tab prompt against real agy.
        resize(&manager, long_id, 72, 24).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        for fixture in [
            "Bu uzun Türkçe tek satırlı prompt 72 sütunluk dar bir terminal panelinde otomatik olarak satır saracaktır ve yine de doğrulanmalıdır.",
            "Ekli dosyayı incele\n\nAttached files (read these local paths to inspect their contents, including images):\n- \"screenshot.png\": \"C:\\Users\\merte\\AppData\\Local\\Temp\\atris-agent-attachments\\00000000-0000-4000-8000-000000000043\\0123456789abcdef0123456789abcdef.png\"",
            "İlk satır\tsekme ile\nİkinci satır\nÜçüncü Türkçe satır",
        ] {
            let before = snapshot(&manager, long_id.into(), 0, true).unwrap().sequence;
            write_input(&manager, long_id, &format!("\x1b[200~{fixture}\x1b[201~"), false).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let frame = snapshot(&manager, long_id.into(), before, false).unwrap();
                if antigravity_paste_acknowledged(&frame.output, fixture) { break; }
                assert!(frame.status == "open" && Instant::now() < deadline, "Antigravity did not confirm fixture in 72-col pane: {fixture:?}\nscreen: {:?}", terminal_text(&frame.output));
                std::thread::sleep(Duration::from_millis(25));
            }
            // Clear the composer line before the next fixture without submitting to the model.
            write_input(&manager, long_id, "\x15\x1b", false).unwrap();
            std::thread::sleep(Duration::from_millis(120));
        }
        let prompt = (0..120).map(|i| format!("Fixture line {i}: abcdefghijklmnopqrstuvwxyz 0123456789 Türkçe test")).collect::<Vec<_>>().join("\n");
        let before = snapshot(&manager, long_id.into(), 0, true).unwrap().sequence;
        // Use the production startup gate and verify agy's acknowledgement, without
        // sending this fixture text to the model.
        write_input(&manager, long_id, &format!("\x1b[200~{prompt}\x1b[201~"), false).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let frame = snapshot(&manager, long_id.into(), before, false).unwrap();
            if antigravity_paste_acknowledged(&frame.output, &prompt) { break; }
            assert!(frame.status == "open" && Instant::now() < deadline, "Antigravity did not accept the 120-line fixture");
            std::thread::sleep(Duration::from_millis(25));
        }
        close_session(&manager, long_id).unwrap();

        // Verify --add-dir coordination directory (production launch shape) does not block trusted workspace startup.
        let coord_id = "00000000-0000-4000-8000-000000000044";
        let coord_dir = root.join("coord-dir");
        std::fs::create_dir_all(coord_dir.join(".agents")).unwrap();
        std::fs::write(coord_dir.join(".agents").join("mcp_config.json"), r#"{"mcpServers":{}}"#).unwrap();
        start_with_cleanup(manager.clone(), Launch { id: coord_id.into(), executable: executable.clone(), cwd: cwd.clone(), env: HashMap::new(), runtime_type: "antigravity".into(),
            args: vec!["--log-file".into(), root.join("coord.log").to_string_lossy().into_owned(), "--add-dir".into(), coord_dir.to_string_lossy().into_owned()] }).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut answered_cursor = false;
        loop {
            let frame = snapshot(&manager, coord_id.into(), 0, false).unwrap();
            if !answered_cursor && frame.output.contains("\x1b[6n") {
                write_input(&manager, coord_id, "\x1b[1;1R", false).unwrap();
                answered_cursor = true;
            }
            if frame.input_ready == Some(true) { break; }
            assert!(frame.status == "open" && Instant::now() < deadline, "Antigravity with --add-dir did not become ready: {:?}", terminal_text(&frame.output));
            std::thread::sleep(Duration::from_millis(25));
        }
        println!("Antigravity with --add-dir coordination directory became input-ready cleanly");
        close_session(&manager, coord_id).unwrap();

        let untrusted_id = "00000000-0000-4000-8000-000000000042";
        let untrusted = root.join("untrusted-project");
        std::fs::create_dir(&untrusted).unwrap();
        start_with_cleanup(manager.clone(), Launch { id: untrusted_id.into(), executable,
            cwd: untrusted.to_string_lossy().into_owned(), env: HashMap::new(), runtime_type: "antigravity".into(),
            args: vec!["--log-file".into(), root.join("untrusted.log").to_string_lossy().into_owned()] }).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut answered_cursor = false;
        loop {
            let frame = snapshot(&manager, untrusted_id.into(), 0, false).unwrap();
            if !answered_cursor && frame.output.contains("\x1b[6n") {
                write_input(&manager, untrusted_id, "\x1b[1;1R", false).unwrap();
                answered_cursor = true;
            }
            if output_contains_styled_text(&frame.output, "trust the contents") || output_contains_styled_text(&frame.output, "Trust this folder?") {
                assert_eq!(frame.input_ready, Some(false));
                break;
            }
            assert!(frame.status == "open" && Instant::now() < deadline, "Antigravity did not prompt for trust on the temporary folder");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(write_input(&manager, untrusted_id, "/exit", true).unwrap_err().contains("not ready"));
        println!("Antigravity trust prompt rejected Chat input without accepting trust");
    }

    #[cfg(windows)]
    #[test]
    fn installed_opencode_bracketed_paste_submits_local_command() {
        let Ok(executable) = std::env::var("ATRIS_TEST_OPENCODE_EXECUTABLE") else { return; };
        let root = std::env::temp_dir().join(format!("atris-opencode-enter-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let manager = ManualTerminals::default();
        struct Cleanup(ManualTerminals, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) { self.0.shutdown(); let _ = std::fs::remove_dir_all(&self.1); }
        }
        let _cleanup = Cleanup(manager.clone(), root.clone());
        let id = "00000000-0000-4000-8000-000000000040";
        let env = [ ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state") ]
            .into_iter().map(|(key, dir)| (key.into(), root.join(dir).to_string_lossy().into_owned())).collect();
        start_with_cleanup(manager.clone(), Launch {
            id: id.into(), executable, env, args: vec![], cwd: root.to_string_lossy().into_owned(), runtime_type: "opencode".into(),
        }).unwrap();

        use std::time::{Duration, Instant};
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut cursor_replied = false;
        loop {
            let frame = snapshot(&manager, id.into(), 0, false).unwrap();
            if !cursor_replied && frame.output.contains("\x1b[6n") {
                write_input(&manager, id, "\x1b[1;1R", false).unwrap();
                cursor_replied = true;
            }
            if frame.output.contains("Ask anything") { break; }
            assert!(frame.status == "open" && Instant::now() < deadline, "OpenCode prompt did not become ready");
            std::thread::sleep(Duration::from_millis(50));
        }

        // :q runs locally; it exits only if OpenCode processes the submit key.
        write_input(&manager, id, ":q", true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let frame = snapshot(&manager, id.into(), 0, true).unwrap();
            if frame.status == "exited" { break; }
            assert!(Instant::now() < deadline, "OpenCode did not submit the pasted local command");
            std::thread::sleep(Duration::from_millis(50));
        }
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
        let jpeg_named_png = b"\xff\xd8\xff\xe0jpeg";
        std::fs::write(project.join("AtrisAgent/screen.png"), image).unwrap();
        std::fs::write(project.join("AtrisAgent/photo.png"), jpeg_named_png).unwrap();
        std::fs::write(root.join("private.png"), image).unwrap();
        std::fs::write(project.join("not-image.png"), b"private data").unwrap();
        assert_eq!(read_project_image(&project, "AtrisAgent/screen.png").unwrap(), image.to_vec());
        assert_eq!(read_project_image(&project, project.join("AtrisAgent/screen.png").to_str().unwrap()).unwrap(), image.to_vec());
        assert_eq!(read_project_image(&project, "AtrisAgent/photo.png").unwrap(), jpeg_named_png.to_vec());
        assert!(read_project_image(&project, "../private.png").is_err());
        assert!(read_project_image(&project, "not-image.png").is_err());
        let fake_home = root.join("home");
        let brain_session = fake_home.join(".gemini").join("antigravity-cli").join("brain").join("7fd73736-96f6-452d-b233-a1edbdd186fd");
        std::fs::create_dir_all(&brain_session).unwrap();
        let brain_img = brain_session.join("walkthrough-slide.png");
        std::fs::write(&brain_img, image).unwrap();
        assert_eq!(read_project_image_with_home(&project, brain_img.to_str().unwrap(), Some(&fake_home)).unwrap(), image.to_vec());
        assert_eq!(read_project_image_with_home(Path::new(""), brain_img.to_str().unwrap(), Some(&fake_home)).unwrap(), image.to_vec());
        assert!(read_project_image_with_home(&project, brain_session.join("../../../../private.png").to_str().unwrap(), Some(&fake_home)).is_err());
        let agy_brain_session = fake_home.join(".gemini").join("antigravity").join("brain").join("8bd84847-1111-452d-b233-a1edbdd186fd");
        std::fs::create_dir_all(&agy_brain_session).unwrap();
        let agy_brain_img = agy_brain_session.join("diagram.png");
        std::fs::write(&agy_brain_img, image).unwrap();
        assert_eq!(read_project_image_with_home(&project, agy_brain_img.to_str().unwrap(), Some(&fake_home)).unwrap(), image.to_vec());
        assert_eq!(read_project_image_with_home(Path::new(""), agy_brain_img.to_str().unwrap(), Some(&fake_home)).unwrap(), image.to_vec());
        assert!(read_project_image_with_home(&project, agy_brain_session.join("../../../../private.png").to_str().unwrap(), Some(&fake_home)).is_err());
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
    fn antigravity_paste_requires_echo_or_matching_collapsed_line_count() {
        let prompt = "İlk satır\nBir orta satır\nSon satır";
        assert!(!antigravity_paste_acknowledged("\x1b[?25lThinking…\x1b[?25h", prompt));
        assert!(!antigravity_paste_acknowledged("[Pasted text #2 +2 lines]", prompt));
        assert!(antigravity_paste_acknowledged("[Pasted text #\x1b[36m2\x1b[0m +3 lines]", prompt));
        assert!(antigravity_paste_acknowledged("> Son \x1b[36msatır\x1b[0m", prompt));
        // Wrapped single-line prompt and CUF cursor-forward spaces.
        let wrapped = "Bu uzun tek satırlı mesaj dar bir terminalde iki satıra bölünerek sarıldı";
        assert!(antigravity_paste_acknowledged("> Bu\x1b[1Cuzun tek satırlı mesaj dar bir\x1b[2;3Hterminalde iki satıra bölünerek sarıldı", wrapped));
        // Long attachment path wrapped mid-token in a narrow pane.
        let attach = "Bak\n- \"shot.png\": \"C:\\Users\\merte\\AppData\\Local\\Temp\\atris-agent-attachments\\00000000-0000-4000-8000-000000000043\\0123456789abcdef0123456789abcdef.png\"";
        assert!(antigravity_paste_acknowledged("00000000-0000-4000-8000-000000000043\\0123456789abc\r\ndef0123456789abcdef.png\"", attach));
        // Tab-expanded prompt echo.
        assert!(antigravity_paste_acknowledged("> hello   world", "hello\tworld"));
        // Context transfer ending with "---" must not false-match an unrelated screen divider.
        let transfer = "Use this context.\n---\nActual substantive context line\n---";
        assert!(!antigravity_paste_acknowledged("─────────\n---\n? for shortcuts", transfer));
        assert!(antigravity_paste_acknowledged("> Actual substantive context line\n---", transfer));
        // Long single-line paste collapsed by char count in agy 1.5.14 (`[Pasted text #1 1200 chars]`).
        let long_line = "a".repeat(1200);
        assert!(antigravity_paste_acknowledged("[Pasted text #1 1200 chars]", &long_line));
        assert!(!antigravity_paste_acknowledged("[Pasted text #1 500 chars]", &long_line));
        // Private CSI modes (?2026h, ?25l) and OSC sequences must not leak parameter garbage.
        assert_eq!(terminal_text("\x1b[?2026h\x1b]0;agy\x07?\x1b[1Cfor\x1b[1Cshortcuts\x1b[?25l\x1b[?2026l"), "? for shortcuts");
    }

    #[test]
    fn antigravity_paste_mode_alone_does_not_make_trust_ready() {
        let mut replay = Replay::new();
        replay.agy_input = Some(AntigravityInput::default());
        replay.push("\x1b[?2004hDo you trust the contents of this project?".into());
        assert_eq!(replay.input_ready, Some(false));
        replay.push("\x1b[2J? \x1b[36mfor short".into());
        assert_eq!(replay.input_ready, Some(false));
        replay.push("cuts\x1b[0m".into());
        assert_eq!(replay.input_ready, Some(true));
        replay.push("\x1b[2JTrust this folder?".into());
        assert_eq!(replay.input_ready, Some(false));
        replay.push("\x1b[?2004l\x1b[2J? for shortcuts".into());
        assert_eq!(replay.input_ready, Some(false));
        // AskQuestion modal must pause normal Chat composer readiness.
        let mut question_replay = Replay::new();
        question_replay.agy_input = Some(AntigravityInput::default());
        question_replay.push("\x1b[?2004h? for shortcuts".into());
        assert_eq!(question_replay.input_ready, Some(true));
        question_replay.push("\x1b[2JQuestion 1/4\r\n↑/↓ Navigate · → Next · enter Select · esc Skip · ctrl+r Review".into());
        assert_eq!(question_replay.input_ready, Some(false));
        // Heavy ANSI + CUF spaces + private mode codes must still detect readiness.
        let mut heavy = Replay::new();
        heavy.agy_input = Some(AntigravityInput::default());
        let padding = "\x1b[38;2;122;162;247mstatus\x1b[0m ".repeat(60);
        heavy.push(format!("\x1b[?2004h\x1b[?2026h?\x1b[1Cfor\x1b[1Cshortcuts{padding}\x1b[?2026l"));
        assert_eq!(heavy.input_ready, Some(true));
    }

    #[test]
    fn terminal_reply_is_not_confused_with_keys_or_raw_paste() {
        for reply in [
            "\x1b[12;4R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[0n",
            "\x1b[I", "\x1b[O", "\x1b[?2004;1$y", "\x1b[?0u", "\x1b[8;30;120t",
            "\x1b]11;rgb:1010/1111/1414\x07", "\x1b]10;rgb:e4e4/e4e4/e7e7\x1b\\",
            "\x1bP>|xterm.js(5.3.0)\x1b\\", "\x1b_Gi=31;OK\x1b\\",
            "\x1b[12;4R\x1b[?1;2c\x1b[I\x1b[?0u",
        ] {
            assert!(terminal_protocol_reply(reply), "expected protocol reply: {reply:?}");
        }
        for user_input in ["", "\x1b[1;2A", "\x1b[1;2Rtext", "\x1b[200~typed\x1b[201~", "\r", "text", "\x1b[Ihello"] {
            assert!(!terminal_protocol_reply(user_input), "must not classify user input as reply: {user_input:?}");
        }
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
    static REAL_PTY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(windows)]
    #[test]
    fn real_pty_resize_replay_retains_screen_geometry() {
        let _serial = REAL_PTY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        struct Cleanup(ManualTerminals);
        impl Drop for Cleanup { fn drop(&mut self) { self.0.shutdown(); } }
        let manager = ManualTerminals::default();
        let _cleanup = Cleanup(manager.clone());
        let id = "00000000-0000-4000-8000-000000000099";
        let executable = std::path::PathBuf::from(std::env::var("WINDIR").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe").to_string_lossy().to_string();
        // A disposable full-screen TUI. It exits on its own after emitting both initial and resized frames; no user process or session is touched.
        let script = "$e=[char]27; $last=''; $draws=0; $end=(Get-Date).AddSeconds(15); [Console]::Write($e+'[?1049h'); while((Get-Date) -lt $end) { $w=[Console]::WindowWidth; $h=[Console]::WindowHeight; $key=$w.ToString()+'x'+$h; if($key -ne $last) { [Console]::Write($e+'[2J'+$e+'[1;1HHEADER-'+$key+$e+'[2;1H'+('TRANSCRIPT '*28)+$e+'['+$h+';1HFOOTER-'+$key); $last=$key; $draws+=1; if($draws -ge 2) { Start-Sleep -Milliseconds 300; break } }; Start-Sleep -Milliseconds 50 }";
        start(manager.clone(), Launch { id: id.into(), executable,
            args: vec!["-NoLogo".into(), "-NoProfile".into(), "-Command".into(), script.into()],
            cwd: std::env::temp_dir().to_string_lossy().to_string(), env: HashMap::new(), runtime_type: String::new() }).unwrap();
        let wait_for = |after: u64, text: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
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
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
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
            runtime_type: String::new(),
        }).unwrap_err();
        assert_eq!(error, "Unsupported CLI environment override");
        assert!(manager.slot(id).unwrap().is_none());
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn real_pty_input_replay_and_independent_close() {
        let _serial = REAL_PTY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
                cwd: std::env::temp_dir().to_string_lossy().to_string(), env: HashMap::new(), runtime_type: if id == fourth { "antigravity".into() } else { String::new() } }).unwrap();
        }
        let wait_for = |id: &str, text: &str| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
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
        assert!(write_input(&manager, fourth, "must-not-reach-the-terminal", true).unwrap_err().contains("not ready"));
        write_input(&manager, fourth, "typed-explicitly\r", false).unwrap();
        assert!(!wait_for(fourth, "received:typed-explicitly").output.contains("must-not-reach-the-terminal"));
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
