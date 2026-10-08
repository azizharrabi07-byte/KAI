// The main KAI application window — the real, large, decorated window where the
// workspace lives.
//
// The island is a companion: status, progress, approval and open/focus actions.
// This window is KAI. `tauri.conf.json` declares it (`label: "main"`,
// `url: "shell.html"`, 1280×820, min 900×600, decorated, resizable, not
// always-on-top, hidden at launch), so it is created as part of the same
// WebView2 environment as the island and the settings window. Rust only shows,
// focuses and hides it — it never owns the page.
//
// Why a declared window rather than one built at runtime: `create_settings_window`
// records the measured fact that a WebView2 window created later in this app
// silently comes up blank. A window declared beside the island does not have that
// problem, and the settings window's own `WS_VISIBLE` workaround is reused here
// because a `visible(false)` window is not reliably shown by `show()` alone.
//
// Lifecycle invariant (owner §26): closing this window must only HIDE it. KAI and
// therefore KAI Core keep running; the tray's "Open KAI" brings the window back.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// The main window's label. Matched exactly wherever the window is resolved —
/// the `settings` and `island` windows share the `tauri.localhost` host, so the
/// label (and the page path) is what tells them apart.
pub const LABEL: &str = "main";

/// The size this window is DECLARED at in `tauri.conf.json`, in the units the
/// interface is authored in — the webview's own CSS pixels.
///
/// Why the distinction matters, measured on this machine: the display runs at
/// 110 % with the accessibility text size at 130 %, so the webview's
/// `devicePixelRatio` is 1.4354 while the window's own scale factor is 1.1046.
/// Sizing a window "1280 logical wide" therefore produces a CSS viewport of only
/// 985 px — and `presence.css` hides the navigation rail below 1000 px, so the
/// application came up with no visible navigation at all. The declared size only
/// means what it says if the WEBVIEW's viewport is 1280×820, which is what
/// `apply_design_geometry` below asserts. (The island compensates for the same
/// factor via `island::win_text_scale`; see `island::apply_geometry`.)
pub const DESIGN_W: f64 = 1280.0;
pub const DESIGN_H: f64 = 820.0;
/// The declared minimum, so a small work area still gets a usable window.
pub const MIN_W: f64 = 900.0;
pub const MIN_H: f64 = 600.0;
/// Breathing room kept clear of the work-area edges, in the same CSS pixels.
const MARGIN: f64 = 24.0;

/// The window is sized to the design the first time it is shown — once, so a
/// size the owner chose afterwards is never fought.
static SIZED_ONCE: AtomicBool = AtomicBool::new(false);

/// The factor that converts the webview's CSS pixels to the window's physical
/// pixels: the window's scale factor times the accessibility text scale. This is
/// the webview's `devicePixelRatio`, which is the only scale that makes the
/// interface's own geometry mean what it says.
fn css_scale(win: &WebviewWindow) -> f64 {
    (win.scale_factor().unwrap_or(1.0) * crate::island::win_text_scale()).max(0.1)
}

/// Size and centre the window so its WEBVIEW viewport is the declared design,
/// clamped to what the display can actually host.
///
/// The clamp is not a fallback: at 130 % text scale a 820 px-tall design needs
/// 1177 physical px, more than this 1080 px-tall screen can show. Filling the
/// work area is then the largest CSS viewport that exists, and the honest answer
/// — rather than a window taller than the screen, which the shell clips.
///
/// Called from `attach` (so the window is never even briefly wrong) and again on
/// the FIRST `show` — a window that has never been visible has no final DPI, so
/// the second call is the one that settles it.
pub fn apply_size(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else {
        return;
    };
    let win = &win;
    let scale = css_scale(win);
    // The frame is MEASURED, never guessed: whatever `outer - inner` is now is the
    // decoration the size must leave room for.
    let (frame_w, frame_h) = match (win.outer_size(), win.inner_size()) {
        (Ok(o), Ok(i)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    };
    let Some(monitor) = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.app_handle().primary_monitor().ok().flatten())
    else {
        return;
    };
    let area = monitor.work_area();
    let (avail_w, avail_h) = (area.size.width as f64, area.size.height as f64);
    let origin = (area.position.x, area.position.y);

    // The largest CSS viewport that fits inside the work area with the margin kept
    // AND the measured frame: the check is about the finished window, so the
    // decoration it will carry has to come out of the budget before the size is
    // chosen — otherwise the window is created taller than the screen.
    let max_css_w = ((avail_w - frame_w as f64 - MARGIN * 2.0 * scale) / scale).floor();
    let max_css_h = ((avail_h - frame_h as f64 - MARGIN * 2.0 * scale) / scale).floor();
    let css_w = DESIGN_W.min(max_css_w).max(MIN_W.min(max_css_w));
    let css_h = DESIGN_H.min(max_css_h).max(MIN_H.min(max_css_h));

    let outer_w = (css_w * scale).round() as u32 + frame_w;
    let outer_h = (css_h * scale).round() as u32 + frame_h;
    let x = origin.0 + ((avail_w as i32 - outer_w as i32) / 2).max(0);
    let y = origin.1 + ((avail_h as i32 - outer_h as i32) / 2).max(0);

    let _ = win.set_size(PhysicalSize::new(outer_w, outer_h));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    crate::log::line(format!(
        "main window sized to a {css_w}x{css_h} css viewport ({outer_w}x{outer_h} px at scale {scale:.4}, work area {avail_w}x{avail_h})"
    ));
}

/// Closing the main window only hides it, so the app — and the Core tied to its
/// lifetime — survives. Reopening is the tray's "Open KAI" or the island's own
/// primary action, both of which route through `show`.
pub fn attach(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else {
        crate::log::line("main window missing at setup — cannot attach its close behaviour");
        return;
    };
    // Sizing is asserted in `show()` (see `apply_design_geometry`): a window that
    // has never been visible has no final DPI yet, so it must be sized once the
    // webview really exists.
    let hidden = win.clone();
    let events_handle = app.clone();
    win.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = hidden.hide();
                // Closed → the island returns as the companion (owner §36).
                crate::island::refresh_workspace_presence(&events_handle);
            }
            // Minimise, restore, maximise and a show all arrive as a resize on
            // Windows; each can change whether the workspace is on screen.
            tauri::WindowEvent::Resized(_) => {
                crate::island::refresh_workspace_presence(&events_handle);
            }
            // A destroyed window is certainly not present.
            tauri::WindowEvent::Destroyed => {
                crate::island::refresh_workspace_presence(&events_handle);
            }
            _ => {}
        }
    });
    crate::log::line("main window ready (hidden until opened)");
}

/// Bring the main window to the front and focus it.
///
/// Mirrors `show_settings_window`: a window built with `visible(false)` can keep
/// the `WS_VISIBLE` bit clear even after `show()`, so the style is re-asserted
/// directly. Without it the window is live (it answers IPC) but invisible.
pub fn show(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else {
        crate::log::line("main window missing — cannot open");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    // The declared size is asserted AFTER the window is shown: a window that has
    // never been visible has no final DPI yet, which is what left this one at a
    // 985 px CSS viewport (navigation rail hidden) instead of the declared 1280.
    if !SIZED_ONCE.swap(true, Ordering::Relaxed) {
        apply_size(app);
    }
    let _ = win.set_focus();
    if let Some(hwnd) = crate::island::raw_hwnd(&win) {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_STYLE,
                SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_SHOW,
                WS_VISIBLE,
            };
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
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
                crate::log::line("main window: WS_VISIBLE was clear — shown directly");
            }
        }
    }
    crate::log::line("main window shown");
    // The workspace is now on screen → the island steps aside as the companion. Run
    // after the show so `is_visible()` reports the truth rather than the pre-show
    // state. (owner §36)
    crate::island::refresh_workspace_presence(app);
}

/// Hides the main window without destroying it. Used nowhere yet, but kept
/// beside `show` so the window's two states live in one place.
#[allow(dead_code)]
pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

/// The raw window handle, for callers that need OS-level style access.
#[allow(dead_code)]
pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}
