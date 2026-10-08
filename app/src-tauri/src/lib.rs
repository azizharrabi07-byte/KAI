// KAI for Windows — app wiring and the commands the island calls.

mod claude;
mod core_process;
mod files;
mod hooks;
mod integrations;
mod island;
mod log;
mod main_window;
mod pipe;
mod secrets;
mod settings;
mod tray;
mod win_user;

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatReply};
use core_process::{CoreReport, CoreStatus};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[kai] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[kai] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::set_ignore_cursor(&app, false);
    shared.gate.forget_ignore_state();
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    island::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

/// Hands a move to Windows. The island has no title bar and can be dragged from
/// its grip; the OS runs the move loop and the window's `Moved` event saves the
/// result (see `island::note_user_move`).
#[tauri::command]
fn start_island_drag(app: AppHandle) -> Result<(), String> {
    let Some(win) = island::window(&app) else {
        return Err("the island window is gone".into());
    };
    win.start_dragging().map_err(|e| e.to_string())
}

/// Closes the island: the window is hidden, but KAI itself is untouched — Core,
/// the pollers and the hooks all keep running. The island is the visual front
/// door, not the lifetime of the KAI runtime. Reopen from the tray's "Open KAI",
/// or by launching KAI again.
#[tauri::command]
fn close_island(app: AppHandle, shared: State<Shared>) {
    let Some(win) = island::window(&app) else { return };
    shared.gate.closed.store(true, Ordering::Relaxed);
    // Nothing to draw and nothing to show: park the poll so a closed island costs
    // nothing, exactly like a hidden one. Nested here so the gate flags are the
    // only path back.
    shared.gate.set_active(false);
    let _ = win.hide();
    log::line("island closed (window hidden; KAI runtime keeps running)");
}

/// Brings the island back: shows the window and, if it had been closed, places
/// it again and restarts the cursor poll. A no-op when it is already visible
/// (the tray's Open then only re-expands the front end, which happens through
/// the `tray` event the caller emits).
pub fn show_island(app: &AppHandle) {
    let Some(win) = island::window(app) else { return };
    let was_closed = app
        .try_state::<Shared>()
        .map(|s| s.gate.closed.swap(false, Ordering::Relaxed))
        .unwrap_or(false);
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    if was_closed {
        let pref = app
            .try_state::<Shared>()
            .map(|s| s.settings.lock().unwrap().screen.clone())
            .unwrap_or_else(|| "primary".into());
        island::apply_geometry(app, &pref, false);
        island::set_ignore_cursor(app, false);
        if let Some(s) = app.try_state::<Shared>() {
            s.gate.forget_ignore_state();
            s.gate.set_active(true);
        }
        log::line("island reopened");
    }
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let _ = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to Explorer otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No `cmd /C` anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and cmd would happily read `&`, `^` and `%`
    // in a folder name as syntax. Finding the launcher ourselves and handing the
    // path over as a separate argument keeps it a path.
    if let Some(code) = find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
            cmd.arg(p);
        }
        if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        let _ = Command::new("explorer").arg(p).spawn();
    }
    false
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
fn find_on_path(stem: &str) -> Option<std::path::PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// What the app currently knows about KAI Core: who started it, and where the log
/// lines about it can be found. `origin: "absent"` is a statement of fact, not an
/// error — the island stays usable, it just says the Core is not running.
#[tauri::command]
fn core_status(state: State<CoreStatus>) -> CoreReport {
    state.report(core_process::port())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
///
/// `conversation_id` is the KAI session the turn belongs to, so the turn reaches
/// that session's own conversation instead of whichever one was used last.
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
    conversation_id: Option<String>,
) -> Result<ChatReply, String> {
    let model = shared.settings.lock().unwrap().model.clone();
    claude::send(&chat, &model, query, context, conversation_id).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>, conversation_id: Option<String>) {
    chat.reset(conversation_id.as_deref());
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Answers a pending OpenCode permission request from the island.
///
/// Uses OpenCode's own `POST /permission/{requestID}/reply` route, which is in
/// the server's published OpenAPI document. See `integrations::reply_permission`
/// for the honest status of that path.
#[tauri::command]
async fn opencode_reply_permission(request_id: String, reply: String) -> Result<(), String> {
    integrations::reply_permission(&request_id, &reply).await
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — KAI")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    // The island is always-on-top and is centred exactly where the settings window
    // opens (both are horizontally centred), so an island that is open covers the
    // settings window's title bar and its first rows of content. The island is asked
    // to go away first; the window is shown either way, because a settings window
    // that refuses to appear when the front end is wedged would be worse.
    let _ = app.emit_to(island::WINDOW_LABEL, "settings-opening", ());
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    // Windows keeps the WS_VISIBLE bit clear on a window built with
    // `.visible(false)` often enough that relying on `show()` alone is not safe:
    // measured on this host, the page was live and answered over CDP while
    // IsWindowVisible stayed false. Setting the style and asking the OS directly is
    // what actually puts the window on screen.
    if let Some(hwnd) = island::raw_hwnd(&win) {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_STYLE, SWP_NOACTIVATE,
                SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_SHOW, WS_VISIBLE,
            };
            let style = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, GWL_STYLE);
            if style & (WS_VISIBLE.0 as isize) == 0 {
                SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_VISIBLE.0 as isize);
                let _ = ShowWindow(hwnd, SW_SHOW);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
                log::line("settings window: WS_VISIBLE was clear — shown directly");
            }
        }
    }
    log::line("settings window shown");
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

/// Opens (and focuses) the real KAI application window.
///
/// This is the island's "Open KAI" and the tray's "Open KAI". It is deliberately a
/// plain Tauri command so any window can call it without importing another module:
/// from the island, `import { invoke } from "@tauri-apps/api/core"; await invoke("open_main_window")`.
#[tauri::command]
fn open_main_window(app: AppHandle) {
    main_window::show(&app);
}

/// Whether the main KAI workspace is currently open on screen (owner §36). The
/// island reads this on boot so a front end that (re)loaded while the workspace is
/// already open converges on the real answer instead of assuming it is closed.
#[tauri::command]
fn workspace_presence(app: AppHandle) -> bool {
    island::workspace_open(&app)
}

pub fn run() {
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Launching KAI again opens the real application window (and keeps the
            // island available as before).
            show_island(app);
            main_window::show(app);
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(CoreStatus::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            start_island_drag,
            close_island,
            open_url,
            open_in_vscode,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            opencode_reply_permission,
            open_n8n,
            open_settings_window,
            open_main_window,
            workspace_presence,
            core_status,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            // The real application window is declared in tauri.conf.json; attach its
            // close-only-hides behaviour so closing it never ends KAI or its Core.
            main_window::attach(&handle);
            // Seed the companion's workspace-presence flag from the real window state
            // (hidden at launch → the island is the entry point). owner §36.
            island::refresh_workspace_presence(&handle);

            if let Some(win) = island::window(&handle) {
                island::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
                // A move the owner makes by dragging the grip is a `Moved` event;
                // `note_user_move` tells our own placement apart from a real drag
                // and persists the latter. See island::note_user_move.
                let move_handle = handle.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(pos) = event {
                        island::note_user_move(&move_handle, pos.x, pos.y);
                    }
                });
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());
            // The island is reachable while it is hidden because of this thread, not
            // because of the webview: see spawn_wake_monitor.
            island::spawn_wake_monitor(handle.clone(), gate.clone());

            log::line(format!("--- KAI {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            // KAI Core is KAI's own control plane, so KAI starts it: adopt the one
            // already listening, or spawn one that cannot outlive this process.
            core_process::start(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running KAI");
}
