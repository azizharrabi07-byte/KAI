// KAI Core is started and owned by KAI itself.
//
// Why this exists: the Phase 2.5 report's own acceptance list named "the app does
// not start the Core" as its one gap. A desktop presence whose control plane has to
// be started by hand in a terminal is not a product, so the app now does it.
//
// Three rules, in this order, and nothing else:
//
//   1. ADOPT.  If something already answers on 127.0.0.1:8788 with a Core-shaped
//      `/state`, use it and never start a second one. Only one Core may run: it
//      binds a fixed port and owns the SQLite file (docs/development.md).
//   2. SPAWN.  Otherwise start `node <core>/dist/server.js` with no console window,
//      inside a Windows job object carrying KILL_ON_JOB_CLOSE. That is what makes the
//      Core die with KAI — including when KAI is killed, not only when it exits
//      cleanly. So no orphan, by construction rather than by good intentions.
//   3. WATCH.  Every few seconds, check. A Core we started that died is started
//      again. An adopted Core that disappears is treated as a cold start: the next
//      pass adopts or spawns, whichever is right. State is never assumed.
//
// The Core's own stdout/stderr is piped into kai.log with a `core:` prefix, so the
// existing log tells the whole story of the control layer in one place. Node's
// `redactedConfig()` is the only config that ever appears there, and the Hermes key
// reaches the Core through the child process environment — never a log, never a file.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use crate::log;
use crate::settings;

/// Same flag the app uses for kai-hook: nothing may flash a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often the supervisor re-checks. Slow on purpose: the only cost is one local
/// HTTP request every few seconds, and a restarted Core must never race its own
/// previous instance's port.
const WATCH_INTERVAL: Duration = Duration::from_secs(4);

/// Per-request cap for the liveness probe. A Core that cannot answer `/state` in
/// this long is not usable, and blocking the supervisor on it would be worse.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CoreOrigin {
    /// Nothing was started: an existing Core on the port was used.
    Adopted,
    /// Started by this app and owned by it.
    Owned,
    /// Nothing is listening and nothing could be started.
    Absent,
}

impl CoreOrigin {
    fn as_str(self) -> &'static str {
        match self {
            CoreOrigin::Adopted => "adopted",
            CoreOrigin::Owned => "owned",
            CoreOrigin::Absent => "absent",
        }
    }
}

/// What the island (or a human reading a log) can ask about the Core.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoreReport {
    /// "adopted" | "owned" | "absent"
    pub origin: String,
    /// The process the app started, when there is one. Absent for an adopted Core.
    pub pid: Option<u32>,
    pub url: String,
    pub port: u16,
    /// The node binary and entry point actually used, for a log that can be acted on.
    pub node: Option<String>,
    pub server_js: Option<String>,
    /// Restarts performed because a Core we started died.
    pub restarts: u64,
}

#[derive(Default)]
pub struct CoreStatus {
    origin: Mutex<String>,
    pid: Mutex<Option<u32>>,
    node: Mutex<Option<String>>,
    server_js: Mutex<Option<String>>,
    restarts: AtomicU64,
}

impl CoreStatus {
    fn set(&self, origin: CoreOrigin, pid: Option<u32>, node: Option<String>, server_js: Option<String>) {
        *self.origin.lock().unwrap() = origin.as_str().to_string();
        *self.pid.lock().unwrap() = pid;
        if node.is_some() {
            *self.node.lock().unwrap() = node;
        }
        if server_js.is_some() {
            *self.server_js.lock().unwrap() = server_js;
        }
    }

    pub fn report(&self, port: u16) -> CoreReport {
        CoreReport {
            origin: self.origin.lock().unwrap().clone(),
            pid: *self.pid.lock().unwrap(),
            url: format!("http://127.0.0.1:{port}"),
            port,
            node: self.node.lock().unwrap().clone(),
            server_js: self.server_js.lock().unwrap().clone(),
            restarts: self.restarts.load(Ordering::Relaxed),
        }
    }
}

/// The port KAI Core binds. Read here only so the supervisor probes the same address
/// the Core will use; the value itself is the Core's own default (core/src/config.ts).
pub fn port() -> u16 {
    std::env::var("KAI_CORE_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(8788)
}

fn state_url() -> String {
    format!("http://127.0.0.1:{}/state", port())
}

/// True when a Core-shaped server answers. `/state` is the Core's own cheap snapshot
/// route: unlike `/health` it does not probe Hermes or OpenCode, so this is a
/// liveness check, not an upstream check.
async fn core_answers(client: &reqwest::Client) -> bool {
    let Ok(res) = client.get(state_url()).send().await else {
        return false;
    };
    if !res.status().is_success() {
        return false;
    }
    // Core identity, not just "something is listening": `/state` always carries an
    // `agents` array. A stranger on 8788 must not be mistaken for the control plane.
    match res.json::<serde_json::Value>().await {
        Ok(value) => value.get("agents").map(serde_json::Value::is_array).unwrap_or(false),
        Err(_) => false,
    }
}

// ── Where the Core lives ──────────────────────────────────────────────────────

/// `core/dist/server.js`, looked for in every layout this project actually uses:
/// the repo (running target/release/kai.exe), a bundled resource (installed app),
/// and an explicit override for anything else.
fn server_js(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = std::env::var("KAI_CORE_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    for base in ["core", "resources/core", "_up_/core", "_up_/core/dist"] {
        if let Ok(p) = app.path().resolve(base, tauri::path::BaseDirectory::Resource) {
            candidates.push(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for rel in ["core", "resources/core", "_up_/core"] {
                candidates.push(parent.join(rel));
            }
        }
        // Walk up from the running binary: app/target/release/kai.exe is three
        // levels below the repository root that holds core/.
        let mut dir = exe.parent().map(PathBuf::from);
        for _ in 0..6 {
            let Some(d) = dir else { break };
            candidates.push(d.join("core"));
            dir = d.parent().map(PathBuf::from);
        }
    }

    for dir in candidates {
        for rel in ["dist/server.js", "server.js"] {
            let candidate = dir.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The node that will run the Core. Nothing is downloaded and nothing is guessed
/// silently: every candidate is tried in order and the winner is logged.
fn node_binary(_app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(explicit) = std::env::var("KAI_NODE") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
        log::line(format!("core: KAI_NODE={} is not a file — falling back", p.display()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("node.exe"));
        }
    }
    candidates.push(settings::local_dir().join("bin").join("node.exe"));
    if let Some(p) = crate::find_on_path("node") {
        candidates.push(p);
    }
    candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
    // Last resort on this host: the node shipped with the Hermes Agent install that
    // KAI's control layer talks to. Used only if nothing else resolved.
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let tools = PathBuf::from(home).join(".hermes").join("tools");
        if let Ok(entries) = std::fs::read_dir(&tools) {
            let mut found: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("node-") && !n.contains("modules"))
                        .unwrap_or(false)
                })
                .map(|p| p.join("node.exe"))
                .filter(|p| p.is_file())
                .collect();
            found.sort();
            candidates.extend(found);
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// A path node can actually be given.
///
/// Tauri's resource lookup returns a Windows *verbatim* path (`\\?\C:\...`). Node
/// treats a `\\?\`-prefixed argument as a module specifier rather than a file, and
/// dies before loading anything with `EISDIR: illegal operation on a directory,
/// lstat 'C:'` — which is exactly what the first cold-start run of this supervisor
/// did. The prefix exists to bypass MAX_PATH, and this is the one place it has to be
/// taken off again.
fn usable_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => text,
    }
}

// ── The job object that makes the Core die with KAI ───────────────────────────

struct JobObject(HANDLE);

// The handle is only ever used to keep the job alive (and to be closed with the
// process). No aliasing concerns: it is opened once and never mutated.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl Drop for JobObject {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE means closing the handle is what ends the Core. This is
        // the last line of defence, not the mechanism: the handle is held in the
        // supervisor task for as long as KAI runs.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// A job with KILL_ON_JOB_CLOSE, so every process in it dies when the last handle
/// closes — which is when KAI exits, however it exits.
fn kill_on_close_job() -> Option<JobObject> {
    unsafe {
        let job = CreateJobObjectW(None, None).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            size,
        )
        .is_err()
        {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return None;
        }
        Some(JobObject(job))
    }
}

fn spawn_core(node: &PathBuf, server: &PathBuf) -> Result<Child, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(node);
    // A real path, not a verbatim one: see usable_path.
    cmd.arg(usable_path(server))
        .current_dir(server.parent().unwrap_or(std::path::Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    // The Core reads its key from the environment. It is passed to the child process
    // only; it is never written down and never logged.
    if let Some(key) = crate::secrets::get("hermes-api-key") {
        cmd.env("KAI_HERMES_KEY", key);
    }
    // The shared host token authenticates the chat relay's user-authority learning
    // call (core/src/server.ts). Passed the same way as the Hermes key — through the
    // child's environment only, never written down and never logged.
    if let Some(token) = crate::secrets::host_token() {
        cmd.env("KAI_HOST_TOKEN", token);
    }
    let child = cmd.spawn().map_err(|e| format!("{}: {e}", node.display()))?;
    Ok(child)
}

fn pump(stream: impl std::io::Read + Send + 'static, label: &'static str) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                // Long lines are truncated: the log is for humans, and one runaway
                // line must not push everything else out of it.
                let shown: String = trimmed.chars().take(400).collect();
                log::line(format!("core: {shown}"));
                let _ = label;
            }
        }
    });
}

/// The supervisor. Runs for the life of the app and owns the job object, so the
/// kill-on-close guarantee holds exactly as long as KAI does.
pub fn start(app: AppHandle) {
    let status = app.state::<CoreStatus>();
    status.set(CoreOrigin::Absent, None, None, None);

    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
            Ok(c) => c,
            Err(err) => {
                log::line(format!("core: supervisor could not build an HTTP client: {err}"));
                return;
            }
        };

        // Held for the whole task: dropping it would close the job handle and kill
        // the Core, which is exactly the point, but only at the end.
        let job = kill_on_close_job();
        if job.is_none() {
            log::line("core: could not create a job object — the Core will not be tied to KAI's lifetime");
        }

        let mut child: Option<Child> = None;
        let mut announced_absent = false;
        // Adoption is a state, not an event: without this the same line would be
        // written on every watch tick (every 4 s) for as long as an adopted Core is
        // running.
        let mut announced_adopt = false;

        loop {
            let answers = core_answers(&client).await;

            if answers {
                if child.is_none() && !announced_adopt {
                    announced_adopt = true;
                    log::line(format!(
                        "core: adopted the Core already listening on 127.0.0.1:{} — not starting a second one",
                        port()
                    ));
                }
                announced_absent = false;
                let pid = child.as_ref().map(Child::id);
                let origin = if child.is_some() { CoreOrigin::Owned } else { CoreOrigin::Adopted };
                let node = node_binary(&app).map(|p| p.display().to_string());
                let server = server_js(&app).map(|p| p.display().to_string());
                app.state::<CoreStatus>().set(origin, pid, node, server);
                tokio::time::sleep(WATCH_INTERVAL).await;
                continue;
            }

            // Nothing is answering. Did ours die?
            if let Some(mut running) = child.take() {
                let exit = running.try_wait();
                if let Ok(Some(status)) = exit {
                    let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                    app.state::<CoreStatus>().restarts.fetch_add(1, Ordering::Relaxed);
                    log::line(format!("core: the Core we started exited ({code}) — starting it again"));
                } else {
                    // Still running but not answering yet: give it another interval
                    // rather than starting a second process on the same port.
                    child = Some(running);
                    tokio::time::sleep(WATCH_INTERVAL).await;
                    continue;
                }
            }

            match (node_binary(&app), server_js(&app)) {
                (Some(node), Some(server)) => match spawn_core(&node, &server) {
                    Ok(mut started) => {
                        let pid = started.id();
                        if let (Some(stdout), Some(stderr)) = (started.stdout.take(), started.stderr.take()) {
                            pump(stdout, "out");
                            pump(stderr, "err");
                        }
                        let assigned = match (&job, started.as_raw_handle_of_child()) {
                            (Some(job), Some(handle)) => unsafe {
                                AssignProcessToJobObject(job.0, handle).is_ok()
                            },
                            _ => false,
                        };
                        log::line(format!(
                            "core: started {} {} (pid {pid}{})",
                            node.display(),
                            usable_path(&server),
                            if assigned { ", tied to KAI's lifetime" } else { "" }
                        ));
                        // Starting one of our own ends any adoption episode; a later
                        // adoption (the app restarted under an existing Core) is a new
                        // one and deserves its own line.
                        announced_adopt = false;
                        app.state::<CoreStatus>().set(
                            CoreOrigin::Owned,
                            Some(pid),
                            Some(node.display().to_string()),
                            Some(usable_path(&server)),
                        );
                        child = Some(started);
                    }
                    Err(err) => {
                        log::line(format!("core: could not start the Core — {err}"));
                        app.state::<CoreStatus>().set(CoreOrigin::Absent, None, None, None);
                    }
                },
                (node, server) => {
                    if !announced_absent {
                        announced_absent = true;
                        log::line(format!(
                            "core: nothing on {} and no way to start one (node: {}, server.js: {})",
                            state_url(),
                            node.map(|p| p.display().to_string()).unwrap_or_else(|| String::from("not found")),
                            server.map(|p| p.display().to_string()).unwrap_or_else(|| String::from("not found")),
                        ));
                    }
                    app.state::<CoreStatus>().set(CoreOrigin::Absent, None, None, None);
                }
            }

            tokio::time::sleep(WATCH_INTERVAL).await;
        }
    });
}

/// `Child::as_raw_handle()` needs the trait in scope; kept in one place so the
/// unsafe conversion below has a name.
trait RawProcessHandle {
    fn as_raw_handle_of_child(&self) -> Option<HANDLE>;
}

impl RawProcessHandle for Child {
    fn as_raw_handle_of_child(&self) -> Option<HANDLE> {
        use std::os::windows::io::AsRawHandle;
        let raw = self.as_raw_handle();
        if raw.is_null() {
            None
        } else {
            Some(HANDLE(raw))
        }
    }
}
