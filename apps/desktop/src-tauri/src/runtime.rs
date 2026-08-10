#![cfg_attr(debug_assertions, allow(dead_code, unused_imports))]

use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub const READY_PREFIX: &str = "ATRIS_RUNTIME_READY ";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DIAGNOSTIC_LINES: usize = 24;
const MAX_DIAGNOSTIC_LINE_CHARS: usize = 512;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub origin: String,
    pub runtime_token: Option<String>,
    pub transport_protected: bool,
}

#[derive(Debug, Deserialize)]
struct ReadyEnvelope {
    origin: String,
    pid: u32,
    version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyInfo {
    pub origin: String,
    pub pid: u32,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub runtime_dir: PathBuf,
    pub node: PathBuf,
    pub gateway: PathBuf,
    pub bridge: PathBuf,
}

type DiagnosticBuffer = Arc<Mutex<VecDeque<String>>>;

pub struct RuntimeState {
    child: Mutex<Option<Child>>,
    config: Mutex<Option<RuntimeConfig>>,
    startup_error: Mutex<Option<String>>,
    lifecycle: Mutex<()>,
    #[cfg(windows)]
    job: Mutex<Option<JobHandle>>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            config: Mutex::new(None),
            startup_error: Mutex::new(None),
            lifecycle: Mutex::new(()),
            #[cfg(windows)]
            job: Mutex::new(None),
        }
    }
}

impl RuntimeState {
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "Could not acquire the packaged runtime lifecycle lock.".to_string())?;
        self.start_inner(app)
    }

    pub fn ensure_config(&self, app: &AppHandle) -> Result<RuntimeConfig, String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "Could not acquire the packaged runtime lifecycle lock.".to_string())?;
        #[cfg(debug_assertions)]
        {
            let _ = app;
            return self.public_config();
        }
        #[cfg(not(debug_assertions))]
        {
            if self.child_is_alive() {
                return self.public_config();
            }
            self.shutdown();
            self.start_inner(app)?;
            self.public_config()
        }
    }

    fn start_inner(&self, app: &AppHandle) -> Result<(), String> {
        #[cfg(debug_assertions)]
        {
            let _ = app;
            self.set_config(RuntimeConfig {
                origin: "http://127.0.0.1:3001".to_string(),
                runtime_token: None,
                transport_protected: false,
            });
            return Ok(());
        }

        #[cfg(not(debug_assertions))]
        {
            self.start_release(app)
        }
    }

    fn child_is_alive(&self) -> bool {
        let Ok(mut child_state) = self.child.lock() else {
            return false;
        };
        let Some(child) = child_state.as_mut() else {
            return false;
        };
        matches!(child.try_wait(), Ok(None))
    }

    pub fn set_config(&self, config: RuntimeConfig) {
        if let Ok(mut state) = self.config.lock() {
            *state = Some(config);
        }
        if let Ok(mut error) = self.startup_error.lock() {
            *error = None;
        }
    }

    pub fn set_error(&self, error: String) {
        if let Ok(mut state) = self.config.lock() {
            *state = None;
        }
        if let Ok(mut startup_error) = self.startup_error.lock() {
            *startup_error = Some(error);
        }
    }

    pub fn public_config(&self) -> Result<RuntimeConfig, String> {
        if let Ok(state) = self.config.lock() {
            if let Some(config) = state.as_ref() {
                return Ok(config.clone());
            }
        }
        self.startup_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
            .map_or_else(
                || Err("AtrisAgent local runtime has not started.".to_string()),
                Err,
            )
    }

    pub fn shutdown(&self) {
        let config = self.config.lock().ok().and_then(|state| state.clone());
        if let Some(config) = config.as_ref() {
            request_runtime_shutdown(config);
        }
        let Ok(mut child_state) = self.child.lock() else {
            return;
        };
        let Some(mut child) = child_state.take() else {
            #[cfg(windows)]
            {
                let _ = self.job.lock().ok().and_then(|mut job| job.take());
            }
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        if !exited {
            terminate_child(&mut child);
        }
        #[cfg(windows)]
        {
            let _ = self.job.lock().ok().and_then(|mut job| job.take());
        }
    }

    #[cfg(not(debug_assertions))]
    fn start_release(&self, app: &AppHandle) -> Result<(), String> {
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = app;
            return Err(
                "The packaged AtrisAgent runtime is not supported on this operating system yet."
                    .to_string(),
            );
        }

        #[cfg(any(windows, target_os = "linux"))]
        {
            self.shutdown();
            let resource_dir = app.path().resource_dir().map_err(|error| {
                format!("Could not resolve packaged runtime resources: {error}")
            })?;
            let paths = resolve_runtime_paths(&resource_dir)?;
            let data_dir = runtime_data_dir()?;
            fs::create_dir_all(&data_dir)
                .map_err(|error| format!("Could not create AtrisAgent data directory: {error}"))?;
            let runtime_token = random_runtime_token()?;
            let parent_pid = std::process::id().to_string();
            let mut command = Command::new(&paths.node);
            command
                .arg(&paths.gateway)
                .current_dir(&data_dir)
                .env("PORT", "0")
                .env("ATRIS_RUNTIME_TOKEN", &runtime_token)
                .env("ATRIS_PARENT_PID", &parent_pid)
                .env("ATRIS_AGENT_DATA_DIR", &data_dir)
                .env("ATRIS_CONTROL_PLANE_BRIDGE_PATH", &paths.bridge)
                .env("ATRIS_AGENT_VERSION", APP_VERSION)
                .env("NODE_ENV", "production")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }

            let mut child = command.spawn().map_err(|error| {
                format!(
                    "Could not start the packaged AtrisAgent runtime from {}: {error}",
                    paths.node.display()
                )
            })?;

            #[cfg(windows)]
            {
                let job = match create_process_job(&child) {
                    Ok(job) => job,
                    Err(error) => {
                        terminate_child(&mut child);
                        return Err(error);
                    }
                };
                if let Ok(mut job_state) = self.job.lock() {
                    *job_state = job;
                } else {
                    terminate_child(&mut child);
                    return Err("Could not retain the packaged runtime job state.".to_string());
                }
            }

            let stdout = match child.stdout.take() {
                Some(stdout) => stdout,
                None => {
                    terminate_child(&mut child);
                    return Err("Packaged runtime stdout was not available.".to_string());
                }
            };
            let diagnostics = child
                .stderr
                .take()
                .map(capture_diagnostics)
                .unwrap_or_else(|| Arc::new(Mutex::new(VecDeque::new())));

            let receiver = wait_for_ready_line(stdout);
            let ready_line = match receiver.recv_timeout(READY_TIMEOUT) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => {
                    terminate_child(&mut child);
                    return Err(startup_error_with_diagnostics(
                        &error,
                        &diagnostics,
                        &runtime_token,
                    ));
                }
                Err(_) => {
                    terminate_child(&mut child);
                    return Err(startup_error_with_diagnostics(
                        "The packaged AtrisAgent runtime did not become ready before the startup timeout.",
                        &diagnostics,
                        &runtime_token,
                    ));
                }
            };
            let ready = match parse_ready_line(&ready_line) {
                Ok(ready) => ready,
                Err(error) => {
                    terminate_child(&mut child);
                    return Err(startup_error_with_diagnostics(
                        &error,
                        &diagnostics,
                        &runtime_token,
                    ));
                }
            };
            match child.try_wait().map_err(|error| {
                format!("Could not inspect the packaged runtime process: {error}")
            })? {
                Some(status) => {
                    return Err(startup_error_with_diagnostics(
                        &format!(
                            "The packaged AtrisAgent runtime exited immediately after becoming ready ({status})."
                        ),
                        &diagnostics,
                        &runtime_token,
                    ));
                }
                None => {}
            }

            if let Ok(mut child_state) = self.child.lock() {
                *child_state = Some(child);
            } else {
                terminate_child(&mut child);
                return Err("Could not retain the packaged runtime process state.".to_string());
            }
            self.set_config(RuntimeConfig {
                origin: ready.origin,
                runtime_token: Some(runtime_token),
                transport_protected: true,
            });
            Ok(())
        }
    }
}

impl Drop for RuntimeState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn runtime_paths(resource_dir: &Path) -> RuntimePaths {
    let runtime_dir = resource_dir.join("runtime");
    RuntimePaths {
        node: runtime_dir.join(if cfg!(windows) { "node.exe" } else { "node" }),
        gateway: runtime_dir.join("gateway.cjs"),
        bridge: runtime_dir.join("control-plane-bridge.mjs"),
        runtime_dir,
    }
}

fn runtime_paths_complete(paths: &RuntimePaths) -> bool {
    paths.node.is_file() && paths.gateway.is_file() && paths.bridge.is_file()
}

fn missing_runtime_resources(paths: &RuntimePaths) -> Vec<String> {
    [
        (&paths.node, "Node executable"),
        (&paths.gateway, "API gateway bundle"),
        (&paths.bridge, "control-plane bridge"),
    ]
    .into_iter()
    .filter_map(|(path, label)| {
        (!path.is_file()).then(|| format!("{label}: {}", path.display()))
    })
    .collect()
}

fn local_target_root(resource_dir: &Path) -> Option<PathBuf> {
    let mut current = Some(resource_dir);
    for _ in 0..=3 {
        let directory = current?;
        if directory.file_name().and_then(|value| value.to_str()) == Some("target") {
            return Some(directory.to_path_buf());
        }
        current = directory.parent();
    }
    None
}

pub fn resolve_runtime_paths(resource_dir: &Path) -> Result<RuntimePaths, String> {
    let primary = runtime_paths(resource_dir);
    if runtime_paths_complete(&primary) {
        return Ok(primary);
    }

    // `tauri build` places the raw executable under target/.../release while
    // beforeBuildCommand stages the runtime under target/runtime. Installed
    // bundles still resolve through the primary Tauri resource directory.
    if let Some(target_root) = local_target_root(resource_dir) {
        let local_build = runtime_paths(&target_root);
        if runtime_paths_complete(&local_build) {
            return Ok(local_build);
        }
    }

    let missing = missing_runtime_resources(&primary).join("; ");
    Err(format!(
        "Packaged runtime resources are incomplete under {}. Missing: {missing}",
        primary.runtime_dir.display()
    ))
}

pub fn parse_ready_line(line: &str) -> Result<ReadyInfo, String> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.contains('\r') || line.contains('\n') || !line.starts_with(READY_PREFIX) {
        return Err("The packaged runtime emitted a malformed ready line.".to_string());
    }
    let payload = &line[READY_PREFIX.len()..];
    let ready: ReadyEnvelope = serde_json::from_str(payload)
        .map_err(|_| "The packaged runtime ready payload was not valid JSON.".to_string())?;
    if !is_loopback_origin(&ready.origin) {
        return Err("The packaged runtime reported a non-loopback origin.".to_string());
    }
    if ready.pid == 0 || !is_semver(&ready.version) || ready.version != APP_VERSION {
        return Err("The packaged runtime ready payload was incomplete.".to_string());
    }
    Ok(ReadyInfo {
        origin: ready.origin,
        pid: ready.pid,
        version: ready.version,
    })
}

fn is_semver(version: &str) -> bool {
    let (version, build) = version
        .split_once('+')
        .map_or((version, None), |(core, build)| (core, Some(build)));
    if let Some(build) = build {
        if build.is_empty()
            || !build.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
        {
            return false;
        }
    }
    let (core, prerelease) = version
        .split_once('-')
        .map_or((version, None), |(core, prerelease)| {
            (core, Some(prerelease))
        });
    if let Some(prerelease) = prerelease {
        if prerelease.is_empty()
            || !prerelease.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
        {
            return false;
        }
    }
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && (part == &"0" || !part.starts_with('0'))
                && part.chars().all(|character| character.is_ascii_digit())
        })
}

fn is_loopback_origin(origin: &str) -> bool {
    let Some(port) = origin.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    if port.is_empty() || !port.chars().all(|character| character.is_ascii_digit()) {
        return false;
    }
    port.parse::<u16>().map(|value| value > 0).unwrap_or(false)
}

fn wait_for_ready_line<R>(stdout: R) -> mpsc::Receiver<Result<String, String>>
where
    R: Read + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut ready_sent = false;
        for line in reader.lines() {
            match line {
                Ok(line) if !ready_sent && line.starts_with(READY_PREFIX) => {
                    ready_sent = true;
                    let _ = sender.send(Ok(line));
                }
                Ok(_) => {}
                Err(error) => {
                    if !ready_sent {
                        let _ = sender.send(Err(format!(
                            "Could not read packaged runtime output: {error}"
                        )));
                    }
                    return;
                }
            }
        }
        if !ready_sent {
            let _ = sender.send(Err(
                "The packaged AtrisAgent runtime exited before reporting readiness.".to_string(),
            ));
        }
    });
    receiver
}

fn capture_diagnostics<R>(stderr: R) -> DiagnosticBuffer
where
    R: Read + Send + 'static,
{
    let diagnostics = Arc::new(Mutex::new(VecDeque::new()));
    let writer = diagnostics.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let compact = line.trim();
            if compact.is_empty() {
                continue;
            }
            let bounded: String = compact.chars().take(MAX_DIAGNOSTIC_LINE_CHARS).collect();
            if let Ok(mut buffer) = writer.lock() {
                if buffer.len() >= MAX_DIAGNOSTIC_LINES {
                    buffer.pop_front();
                }
                buffer.push_back(bounded);
            }
        }
    });
    diagnostics
}

fn sanitize_diagnostic_line(line: &str, runtime_token: &str) -> String {
    let line = line.replace(runtime_token, "[runtime-token-redacted]");
    let normalized = line.to_ascii_lowercase();
    if [
        "authorization:",
        "password=",
        "password:",
        "api_key=",
        "apikey=",
        "secret=",
        "token=",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return "[sensitive runtime diagnostic redacted]".to_string();
    }
    line
}

fn startup_error_with_diagnostics(
    base: &str,
    diagnostics: &DiagnosticBuffer,
    runtime_token: &str,
) -> String {
    // Give the stderr reader a brief chance to consume a final line after an
    // early child-process exit without extending the normal startup timeout.
    thread::sleep(Duration::from_millis(20));
    let lines = diagnostics
        .lock()
        .ok()
        .map(|buffer| {
            buffer
                .iter()
                .map(|line| sanitize_diagnostic_line(line, runtime_token))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if lines.is_empty() {
        return base.to_string();
    }
    format!("{base} Runtime diagnostic: {}", lines.join(" | "))
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
fn create_process_job(child: &Child) -> Result<Option<JobHandle>, String> {
    use std::{mem, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let process_handle = child.as_raw_handle() as _;
    let mut already_in_job = 0;
    let inspected = unsafe { IsProcessInJob(process_handle, ptr::null_mut(), &mut already_in_job) };
    if inspected == 0 {
        return Err("Could not inspect the packaged runtime job membership.".to_string());
    }
    if already_in_job != 0 {
        // Some shells, IDEs and enterprise launchers already place descendants
        // in a Windows job. The gateway also has a parent-PID watchdog, so a
        // nested assignment is unnecessary and may be rejected by Windows.
        return Ok(None);
    }

    let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if job.is_null() {
        return Err("Could not create the packaged runtime job object.".to_string());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0
    };
    if !configured {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        return Err("Could not configure the packaged runtime job object.".to_string());
    }
    let assigned = unsafe { AssignProcessToJobObject(job, process_handle) != 0 };
    if !assigned {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        return Err("Could not attach the packaged runtime to its job object.".to_string());
    }
    Ok(Some(JobHandle(job)))
}

fn request_runtime_shutdown(config: &RuntimeConfig) {
    let Some(token) = config.runtime_token.as_deref() else {
        return;
    };
    let Some(port) = config
        .origin
        .strip_prefix("http://127.0.0.1:")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
    else {
        return;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(500),
    ) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let request = format!(
        "POST /api/internal/runtime/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Atris-Runtime-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(request.as_bytes());
    let mut response = [0u8; 128];
    let _ = stream.read(&mut response);
}

#[cfg(windows)]
fn runtime_data_dir() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("ATRIS_AGENT_DATA_DIR") {
        return validate_explicit_data_dir(Some(Path::new(&configured)))
            .map(|path| path.expect("configured data dir was present"));
    }
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not available for the AtrisAgent runtime.".to_string())?;
    let legacy_app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    Ok(select_runtime_data_dir(
        &local_app_data,
        legacy_app_data.as_deref(),
    ))
}

#[cfg(target_os = "linux")]
fn runtime_data_dir() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("ATRIS_AGENT_DATA_DIR") {
        return validate_explicit_data_dir(Some(Path::new(&configured)))
            .map(|path| path.expect("configured data dir was present"));
    }
    let xdg_data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let home = std::env::var_os("HOME").map(PathBuf::from);
    select_unix_runtime_data_dir(home.as_deref(), xdg_data_home.as_deref())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn runtime_data_dir() -> Result<PathBuf, String> {
    Err("The packaged AtrisAgent runtime data directory is not supported on this operating system yet.".to_string())
}

fn select_runtime_data_dir(local_app_data: &Path, legacy_app_data: Option<&Path>) -> PathBuf {
    let local_dir = local_app_data.join("AtrisAgent");
    if local_dir.join("atris.db").is_file() {
        return local_dir;
    }
    if let Some(legacy_dir) = legacy_app_data.map(|path| path.join("AtrisAgent")) {
        if legacy_dir.join("atris.db").is_file() {
            return legacy_dir;
        }
    }
    local_dir
}

fn select_unix_runtime_data_dir(
    home: Option<&Path>,
    xdg_data_home: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(xdg_data_home) = xdg_data_home.filter(|path| path.is_absolute()) {
        return Ok(xdg_data_home.join("AtrisAgent"));
    }
    let home = home
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "HOME is not available for the AtrisAgent runtime.".to_string())?;
    Ok(home.join(".local").join("share").join("AtrisAgent"))
}

fn validate_explicit_data_dir(path: Option<&Path>) -> Result<Option<PathBuf>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err("ATRIS_AGENT_DATA_DIR must be a non-empty absolute path.".to_string());
    }
    Ok(Some(path.to_path_buf()))
}

fn random_runtime_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Could not generate runtime token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::{
        is_semver, parse_ready_line, resolve_runtime_paths, runtime_paths,
        sanitize_diagnostic_line, select_runtime_data_dir, select_unix_runtime_data_dir,
        validate_explicit_data_dir, READY_PREFIX,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn create_runtime_files(root: &Path) {
        let runtime = root.join("runtime");
        fs::create_dir_all(&runtime).expect("runtime directory");
        fs::write(
            runtime.join(if cfg!(windows) { "node.exe" } else { "node" }),
            b"node",
        )
        .expect("node runtime");
        fs::write(runtime.join("gateway.cjs"), b"gateway").expect("gateway");
        fs::write(runtime.join("control-plane-bridge.mjs"), b"bridge").expect("bridge");
    }

    #[test]
    fn parses_only_loopback_ready_payloads() {
        let ready = parse_ready_line(&format!(
            "{READY_PREFIX}{{\"origin\":\"http://127.0.0.1:43127\",\"pid\":42,\"version\":\"0.2.0\"}}\n"
        ))
        .expect("valid ready payload");
        assert_eq!(ready.origin, "http://127.0.0.1:43127");
        assert_eq!(ready.pid, 42);
    }

    #[test]
    fn rejects_non_loopback_or_malformed_payloads() {
        for line in [
            "ATRIS_RUNTIME_READY {\"origin\":\"http://localhost:43127\",\"pid\":42,\"version\":\"0.2.0\"}",
            "ATRIS_RUNTIME_READY {\"origin\":\"http://127.0.0.1:0\",\"pid\":42,\"version\":\"0.2.0\"}",
            "ATRIS_RUNTIME_READY {\"origin\":\"http://127.0.0.1:43127\",\"pid\":0,\"version\":\"0.2\"}",
            "ATRIS_RUNTIME_READY {\"origin\":\"http://127.0.0.1:43127\",\"pid\":42,\"version\":\"99.0.0\"}",
            "not a ready line",
        ] {
            assert!(parse_ready_line(line).is_err(), "unexpectedly accepted: {line}");
        }
    }

    #[test]
    fn accepts_full_semver_metadata_but_rejects_malformed_versions() {
        assert!(is_semver("1.2.3-alpha.1+ci.7"));
        assert!(is_semver("0.2.0"));
        assert!(!is_semver("1.2"));
        assert!(!is_semver("1.2.3+"));
        assert!(!is_semver("01.2.3"));
    }

    #[test]
    fn selects_runtime_files_under_resource_runtime_directory() {
        let resource_dir = Path::new("resource-root");
        let paths = runtime_paths(resource_dir);
        assert_eq!(paths.runtime_dir, resource_dir.join("runtime"));
        assert!(paths.gateway.ends_with("gateway.cjs"));
        assert!(paths.bridge.ends_with("control-plane-bridge.mjs"));
    }

    #[test]
    fn resolves_installed_resources_before_local_build_fallback() {
        let root = std::env::temp_dir().join(format!(
            "atris-runtime-resource-test-{}-primary",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        create_runtime_files(&root);
        let resolved = resolve_runtime_paths(&root).expect("installed runtime resources");
        assert_eq!(resolved.runtime_dir, root.join("runtime"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_raw_tauri_release_from_target_runtime() {
        let root = std::env::temp_dir().join(format!(
            "atris-runtime-resource-test-{}-raw",
            std::process::id()
        ));
        let target = root.join("target");
        let raw_release = target.join("x86_64-test-target").join("release");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&raw_release).expect("raw release directory");
        create_runtime_files(&target);
        let resolved = resolve_runtime_paths(&raw_release).expect("raw build runtime fallback");
        assert_eq!(resolved.runtime_dir, target.join("runtime"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_incomplete_packaged_resources_with_actionable_paths() {
        let root = std::env::temp_dir().join(format!(
            "atris-runtime-resource-test-{}-missing",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("resource directory");
        let error = resolve_runtime_paths(&root).expect_err("incomplete resources must fail");
        assert!(error.contains("Packaged runtime resources are incomplete"));
        assert!(error.contains("gateway.cjs"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prefers_existing_local_db_then_legacy_db_then_local_default() {
        let root =
            std::env::temp_dir().join(format!("atris-runtime-data-test-{}", std::process::id()));
        let local = root.join("local");
        let legacy = root.join("legacy");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(local.join("AtrisAgent")).expect("local directory");
        fs::create_dir_all(legacy.join("AtrisAgent")).expect("legacy directory");
        assert_eq!(
            select_runtime_data_dir(&local, Some(&legacy)),
            local.join("AtrisAgent")
        );
        fs::write(legacy.join("AtrisAgent").join("atris.db"), b"legacy").expect("legacy database");
        assert_eq!(
            select_runtime_data_dir(&local, Some(&legacy)),
            legacy.join("AtrisAgent")
        );
        fs::write(local.join("AtrisAgent").join("atris.db"), b"local").expect("local database");
        assert_eq!(
            select_runtime_data_dir(&local, Some(&legacy)),
            local.join("AtrisAgent")
        );
        let _ = fs::remove_dir_all(PathBuf::from(root));
    }

    #[test]
    fn selects_xdg_or_home_linux_data_directory() {
        let root = std::env::temp_dir().join("atris-linux-data-test");
        let xdg = root.join("xdg");
        let home = root.join("home");
        assert_eq!(
            select_unix_runtime_data_dir(Some(&home), Some(&xdg)).expect("xdg path"),
            xdg.join("AtrisAgent")
        );
        assert_eq!(
            select_unix_runtime_data_dir(Some(&home), None).expect("home path"),
            home.join(".local").join("share").join("AtrisAgent")
        );
        assert!(select_unix_runtime_data_dir(None, None).is_err());
    }

    #[test]
    fn accepts_only_non_empty_absolute_explicit_data_dirs() {
        let absolute = std::env::temp_dir().join("atris-agent-explicit-data");
        assert_eq!(
            validate_explicit_data_dir(Some(&absolute)).expect("absolute path"),
            Some(absolute)
        );
        assert!(validate_explicit_data_dir(Some(Path::new("relative-data"))).is_err());
        assert!(validate_explicit_data_dir(Some(Path::new(""))).is_err());
        assert_eq!(validate_explicit_data_dir(None).expect("unset path"), None);
    }

    #[test]
    fn runtime_diagnostics_redact_transport_and_secret_values() {
        let token = "runtime-token-value";
        assert_eq!(
            sanitize_diagnostic_line("failed runtime-token-value", token),
            "failed [runtime-token-redacted]"
        );
        assert_eq!(
            sanitize_diagnostic_line("password=do-not-print", token),
            "[sensitive runtime diagnostic redacted]"
        );
    }
}
