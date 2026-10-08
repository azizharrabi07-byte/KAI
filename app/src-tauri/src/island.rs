// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use windows::Win32::Foundation::{HWND, POINT};
use windows::core::{w, BOOL};
use windows::Win32::Foundation::LPARAM;
use windows::Win32::System::Ole::RevokeDragDrop;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW, IsIconic};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

/// How far outside the collapsed strip still counts as "on the strip", in *physical*
/// px. The strip is 6 logical px tall — about 9 physical here — and a wake path that
/// demands the pointer land inside a 9 px band is not a path a person can use.
const WAKE_SLACK: f64 = 6.0;

/// How often the wake monitor reads the cursor while the island is hidden. 24 Hz:
/// cheap enough to be invisible in Task Manager (one GetCursorPos, no window calls)
/// and fast enough that the island starts to move the moment the pointer arrives.
const WAKE_POLL: Duration = Duration::from_millis(42);

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into Win32 when it changes.
    ignoring: AtomicBool,
    /// The last placement `apply_geometry` asked for. A `Moved` event that
    /// matches it is our own positioning, not the owner dragging the island, so
    /// it must not be written back as a user placement.
    pub expected: Mutex<Option<(i32, i32)>>,
    /// True once the owner has closed the island. The window is hidden and the
    /// wake strip must stop resurrecting it; reopening is an explicit act (the
    /// tray's Open, or launching KAI again).
    pub closed: AtomicBool,
    /// True while the main KAI workspace window is open on screen (shown and not
    /// minimised). The island is a companion: while this is true the front end
    /// keeps it out of the primary desktop presence (owner §36). Mirrored here so
    /// the transition is computed once, wherever it is observed.
    pub workspace_open: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
            expected: Mutex::new(None),
            closed: AtomicBool::new(false),
            workspace_open: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// Windows accessibility text scale — Settings ▸ Accessibility ▸ Text size,
/// stored as a percentage where 100 means "off".
///
/// It belongs in every window-geometry calculation because WebView2 folds it
/// into the webview's device scale factor: Chromium computes the scale as
/// `GetScaleFactorsForDPI(dpi, include_accessibility)` — the monitor DPI scale
/// *multiplied by* the text scale — and the WebView2 API documents its
/// rasterization scale as "the combination of the monitor DPI scale and text
/// scaling set by the user".
///
/// So a window sized with the monitor scale alone hands the page a CSS viewport
/// that is `text_scale` times too small, and a fixed-geometry island is clipped
/// down the right-hand edge and along the bottom. Measured on this machine at
/// 110 % display + 130 % text: `devicePixelRatio` 1.4354 versus a monitor scale
/// of 1.1042, a 240 px wake strip given 185 px of CSS width, and the 720 px
/// panel given 554 px.
///
/// Reading it here (rather than caching) keeps a change to the accessibility
/// setting working without a restart: this is one registry read on a path that
/// already re-queries every monitor.
pub fn win_text_scale() -> f64 {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

    let mut value: u32 = 100;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Accessibility"),
            w!("TextScaleFactor"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut core::ffi::c_void),
            Some(&mut size),
        )
    };
    // Absent key, unreadable key or a nonsense value: behave as if text size is
    // at 100 %, which is exactly what Windows itself does.
    if status.0 != 0 || value < 100 {
        return 1.0;
    }
    // Windows offers 100–225 %; clamp so a corrupt value cannot size the window
    // off the screen.
    (value as f64 / 100.0).clamp(1.0, 2.25)
}

fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// Lets dropped files reach the app again.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything — the
/// "no drop" cursor, with nothing reaching Tauri. Revoking it makes OLE fall
/// through to the target wry registered on the parent widget, which is the one
/// that feeds Tauri's drag events.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    for label in [WINDOW_LABEL, "settings"] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let Some(hwnd) = hwnd_of(&win) else { continue };
        unsafe {
            let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
        }
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the island lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };

    // A placement the owner chose wins over the display preference: the island
    // stays where they put it. If that point is not on any present monitor (the
    // display was unplugged, the layout was rearranged) fall back to the normal
    // target, and the clamp below pulls the window back into view — an island
    // stranded in coordinates that no longer exist is an island nobody can reach.
    let saved = app
        .try_state::<crate::Shared>()
        .and_then(|s| s.settings.lock().unwrap().island_pos);
    let monitor = saved
        .and_then(|p| monitor_containing(app, p.x, p.y))
        .or_else(|| target_monitor(app, pref));
    let Some(m) = monitor else { return };

    // Sized in *webview* pixels, not monitor pixels: WebView2 multiplies the
    // monitor scale by the accessibility text scale, so sizing by the monitor
    // scale alone gives the page a CSS viewport that is text_scale times too
    // small. Scaling the window by the same factor keeps the island's CSS
    // geometry exactly as designed and lets the user's text size make the whole
    // panel bigger instead of clipping it.
    let scale = m.scale_factor() * win_text_scale();
    let mp = *m.position();
    let ms = *m.size();

    let (lw, lh) = if collapsed { (STRIP_W, STRIP_H) } else { (PANEL_W, PANEL_H) };
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;

    let (x, y) = match saved {
        Some(p) => {
            let max_x = (mp.x + ms.width as i32 - pw as i32).max(mp.x);
            let max_y = (mp.y + ms.height as i32 - ph as i32).max(mp.y);
            (p.x.clamp(mp.x, max_x), p.y.clamp(mp.y, max_y))
        }
        None => (mp.x + (ms.width as i32 - pw as i32) / 2, mp.y),
    };

    // Remember what we are about to ask for, so the resulting `Moved` event is
    // not mistaken for a drag and written back as a user placement.
    if let Some(shared) = app.try_state::<crate::Shared>() {
        *shared.gate.expected.lock().unwrap() = Some((x, y));
    }

    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
}

/// The monitor whose rectangle contains a physical desktop point, if any.
fn monitor_containing(app: &AppHandle, x: i32, y: i32) -> Option<Monitor> {
    app.available_monitors()
        .ok()?
        .into_iter()
        .find(|m| monitor_contains(m, x as f64, y as f64))
}

/// The top-left the shell parks a *minimized* window at.
///
/// Windows does not have a real position for an iconic window: `WM_MOVE` and
/// `GetWindowRect` report it at the top-left of the virtual "minimized" desktop
/// — historically `(-32000, -32000)`, chosen so it is inside no monitor. It is a
/// shell convention, not somewhere a window is ever *shown*, so it is never a
/// place the owner put KAI. A monitor to the left of the primary legitimately has
/// a negative x (e.g. `-1920`), but never two coordinates tens of thousands below
/// the desktop, so both axes must cross this threshold to be the sentinel.
pub(crate) const MINIMIZED_SENTINEL: i32 = -30_000;

/// True when a reported top-left is the shell's minimized-window slot rather than
/// a real desktop position.
pub(crate) fn looks_minimized(x: i32, y: i32) -> bool {
    x <= MINIMIZED_SENTINEL && y <= MINIMIZED_SENTINEL
}

/// Whether the OS currently considers the island window minimized.
fn is_iconic(win: &WebviewWindow) -> bool {
    let Some(hwnd) = hwnd_of(win) else { return false };
    unsafe { IsIconic(hwnd).as_bool() }
}

/// Decide what a `Moved` event means, with none of the app state, so the rule can
/// be tested directly.
///
/// Returns `Some(pos)` only when the *owner* really moved the island and the new
/// top-left should be saved. Returns `None` when the event must be ignored:
///
///   - it matches the placement `apply_geometry` just asked for (our own move);
///   - the window is minimized (`iconic`) — the shell moved it to its parked slot;
///   - the geometry is the minimized-window sentinel, even if `IsIconic` has not
///     been observed yet (the `Moved` event can race the window state);
///   - it is already the saved position (nothing to write).
///
/// The invariant this preserves: a real persisted position survives a minimize.
/// The sentinel may exist in the OS/window state for as long as the window is
/// iconic, but it can never become the persisted position.
pub(crate) fn user_move_from_event(
    x: i32,
    y: i32,
    iconic: bool,
    expected: Option<(i32, i32)>,
    current: Option<crate::settings::IslandPos>,
) -> Option<crate::settings::IslandPos> {
    if expected == Some((x, y)) {
        return None;
    }
    if iconic || looks_minimized(x, y) {
        return None;
    }
    if current == Some(crate::settings::IslandPos { x, y }) {
        return None;
    }
    Some(crate::settings::IslandPos { x, y })
}

/// Records a window move the *owner* made, and nothing else.
///
/// Called from the island window's `Moved` event. `apply_geometry` stamps the
/// placement it is about to ask for into `gate.expected`; a move that matches
/// that stamp is our own positioning and is dropped. A minimized window is
/// *moved* by the shell to its parked slot at `(-32000, -32000)` and that arrives
/// here as a `Moved` event exactly like a drag would — it is rejected so it can
/// never overwrite the real saved position (see `user_move_from_event`).
pub fn note_user_move(app: &AppHandle, x: i32, y: i32) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };

    let expected = {
        let mut expected = shared.gate.expected.lock().unwrap();
        let current = *expected;
        if current == Some((x, y)) {
            *expected = None;
        }
        current
    };

    // `IsIconic` is the API-level answer; the sentinel check inside
    // `user_move_from_event` catches the same geometry even if this tick raced the
    // window's minimize/restore state.
    let iconic = window(app).map(|w| is_iconic(&w)).unwrap_or(false);
    let current = shared.settings.lock().unwrap().island_pos;

    let Some(pos) = user_move_from_event(x, y, iconic, expected, current) else {
        if iconic || looks_minimized(x, y) {
            crate::log::line(format!(
                "island reported at {x},{y} while minimized (sentinel) — not saved; \
                 the saved position is unchanged"
            ));
        }
        return;
    };

    let mut settings = shared.settings.lock().unwrap();
    settings.island_pos = Some(pos);
    let _ = crate::settings::save(&settings);
    crate::log::line(format!("island moved by the owner → {x},{y} (saved)"));
}

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// The raw window handle of a webview window, for the Win32 calls that have no
/// Tauri equivalent (reading styles, showing a window directly).
pub fn raw_hwnd(win: &WebviewWindow) -> Option<HWND> {
    hwnd_of(win)
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(16));

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % 30 == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                // While the island is not collapsed it is meant to take the mouse, so
                // re-assert its own window style about once a second. Deliberately
                // ABOVE the "cursor has not moved" early-continue below: a pointer that
                // is standing still is exactly the case where nothing else would ever
                // put a lost WS_EX_TRANSPARENT bit back, and a visible island that
                // silently refuses every click is the state this is here to prevent.
                if ticks % 60 == 0 && !gate.collapsed.load(Ordering::Relaxed) {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || clear_transparent_style(&handle));
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                // Physical → CSS pixels, i.e. the units the page's own hit-testing
                // and the island rect pushed by the front end are in. The text
                // scale is part of the webview's device scale factor, so leaving
                // it out puts every cursor position ~30 % out at 130 % text size
                // and the island stops responding where it looks like it should.
                let scale = win.scale_factor().unwrap_or(1.0) * win_text_scale();
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                // A press may be the start of a drag: make sure the drop target is
                // ours before the file arrives.
                let down = left_button_down();
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || unblock_webview_drops(&handle));
                }
                was_down = down;

                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y });
            }

            // The island is hidden now: whatever the last in-flight tick decided, the
            // wake strip has to be able to take the mouse. WS_EX_TRANSPARENT is what
            // click-through is on Windows, and a strip carrying it can never be
            // entered — which is how the island became unreachable once hidden. The
            // decision is re-made here, after the loop, so a single racing tick can
            // no longer leave the flag set on a hidden island.
            gate.ignoring.store(false, Ordering::Relaxed);
            if let Some(win) = window(&app) {
                let _ = win.set_ignore_cursor_events(false);
            }

            // Cheap and idempotent: a collapsed window may have been left with a
            // stale transparent style by a previous collapse, and a hidden island
            // costs one call to be sure.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || clear_transparent_style(&handle));
        }
    });
}

/// The wake path when the island is hidden.
///
/// The DOM `mouseenter` on `#wake-strip` is the intended mechanism, and it works —
/// while the window can take mouse input at all. It cannot be the *only* mechanism:
/// a layered, click-through window receives no mouse messages, so if anything leaves
/// the strip transparent the island has no way back and the user is stuck with a
/// presence they cannot reach.
///
/// This monitor asks the OS directly instead. `GetCursorPos` works regardless of
/// window styles, needs no window to be hit-testable, and cannot be defeated by a
/// style race. It runs only while the island is collapsed, and it fires on *entry*
/// (never on "already there"), so a pointer parked at the top of the screen when the
/// island hides does not immediately bring it back.
pub fn spawn_wake_monitor(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_collapsed = false;
        let mut was_inside = true;
        // Backstop for the companion contract (owner §36): the main window's own
        // events drive presence, but a minimise that does not surface as a resize
        // must still bring the island back. Checked about every 2.5 s — one
        // visibility/iconic query, far cheaper than the wake poll it rides on.
        let mut presence_ticks: u32 = 0;
        loop {
            std::thread::sleep(WAKE_POLL);
            presence_ticks = presence_ticks.wrapping_add(1);
            if presence_ticks % 60 == 0 {
                refresh_workspace_presence(&app);
            }
            // The owner closed the island: it is gone from the screen on purpose,
            // so hovering where it used to be must not bring it back. Reopening is
            // the tray's Open (or launching KAI again).
            if gate.closed.load(Ordering::Relaxed) {
                was_collapsed = false;
                continue;
            }
            if !gate.collapsed.load(Ordering::Relaxed) {
                was_collapsed = false;
                continue;
            }
            let Some(win) = window(&app) else { continue };
            let (Ok(origin), Ok(size)) = (win.outer_position(), win.outer_size()) else { continue };
            let Some((cx, cy)) = cursor_physical() else { continue };

            let left = origin.x as f64;
            let top = origin.y as f64;
            let right = left + size.width as f64;
            let bottom = top + size.height as f64;
            let inside = cx >= left - WAKE_SLACK
                && cx <= right + WAKE_SLACK
                && cy >= top - WAKE_SLACK
                && cy <= bottom + WAKE_SLACK;

            if !was_collapsed {
                // First observation after the island hid: record where the pointer
                // already was, and do not treat that as an entry.
                was_collapsed = true;
                was_inside = inside;
                continue;
            }
            if inside && !was_inside {
                crate::log::line(format!(
                    "ui  [island] wake strip entered at {cx},{cy} (window {left},{top} {size:?}) — waking"
                ));
                let _ = app.emit_to(WINDOW_LABEL, "wake", ());
            }
            was_inside = inside;
        }
    });
}

/// Clears WS_EX_TRANSPARENT (and leaves WS_EX_LAYERED, which is what makes the
/// island's transparent background work at all).
pub fn clear_transparent_style(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let Some(hwnd) = hwnd_of(&win) else { return };
    unsafe {
        const WS_EX_TRANSPARENT: isize = 0x0000_0020;
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & WS_EX_TRANSPARENT != 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !WS_EX_TRANSPARENT);
        }
    }
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

// ── Workspace presence: the island as a companion (owner §36) ─────────────────
//
// The island and the main workspace window are two different windows. The owner is
// explicit that they must not compete: while the REAL workspace is open, the island
// hides from the primary desktop presence; when that workspace is closed OR
// minimised, the island returns as the companion. This is the one place that decides
// "is the workspace on screen", so the transition is computed once and the front end
// is told only on a genuine change.

/// True while the main KAI window is on screen AND not minimised.
///
/// A hidden main window (KAI's launch state, or after its close→hide) and a
/// minimised one both mean "the island should be the companion". `is_visible`
/// covers the closed/hidden case; `is_iconic` covers minimise — Windows keeps a
/// minimised window "visible", so visibility alone would wrongly keep the island
/// aside while the workspace sits in the taskbar.
pub fn workspace_visible(app: &AppHandle) -> bool {
    let Some(win) = app.get_webview_window(crate::main_window::LABEL) else {
        return false;
    };
    let iconic = is_iconic(&win);
    let visible = win.is_visible().unwrap_or(false);
    workspace_on_screen(visible, iconic)
}

/// The rule, with none of the app state, so it can be tested directly (owner §36):
/// the workspace counts as "on screen" only when the window is visible AND not
/// minimised. Windows keeps a minimised window *visible*, so a visibility-only
/// check would wrongly leave the island aside while the workspace sits in the
/// taskbar — the bug this predicate exists to prevent.
pub fn workspace_on_screen(visible: bool, iconic: bool) -> bool {
    visible && !iconic
}

/// Recompute workspace presence and, on a real change, tell the island front end.
///
/// Idempotent and cheap: called on every main-window event that can change presence
/// (show, close→hide, resize/minimise/restore) and periodically from the wake
/// monitor as a backstop. The `swap` makes the emit happen exactly once per change.
pub fn refresh_workspace_presence(app: &AppHandle) {
    let present = workspace_visible(app);
    let changed = app
        .try_state::<crate::Shared>()
        .map(|s| {
            s.gate
                .workspace_open
                .swap(present, Ordering::Relaxed)
                != present
        })
        .unwrap_or(false);
    if !changed {
        return;
    }
    let _ = app.emit_to(WINDOW_LABEL, "workspace-presence", present);
    crate::log::line(if present {
        "main workspace open — island stepping aside".to_string()
    } else {
        "main workspace closed/minimised — island returning".to_string()
    });
}

/// The front end asks (on boot or on demand) whether the workspace is currently
/// open, so an island that reloaded mid-session converges on the real answer
/// instead of assuming the workspace is closed.
pub fn workspace_open(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|s| s.gate.workspace_open.load(Ordering::Relaxed))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::IslandPos;

    /// The headline regression: a real persisted position survives a minimize.
    ///
    /// The owner drags KAI to a real spot, Windows minimizes it and reports the
    /// parked slot `(-32000, -32000)` as a `Moved` event. That must not become the
    /// saved position — the invariant is untouched.
    #[test]
    fn minimize_sentinel_never_becomes_the_saved_position() {
        let real = IslandPos { x: 731, y: 412 };
        assert_eq!(
            user_move_from_event(-32000, -32000, true, None, Some(real)),
            None,
            "a minimized-window sentinel must never be persisted, even when the \
             real position is known"
        );
        // Nothing changed the stored value: a restart still restores `real`.
        assert_eq!(Some(real), Some(IslandPos { x: 731, y: 412 }));
    }

    /// The `Moved` event can race the window's iconic state: `IsIconic` may still
    /// report false on the tick that carries the sentinel. The geometry alone has
    /// to be rejected too.
    #[test]
    fn sentinel_is_rejected_even_if_the_window_state_raced() {
        assert_eq!(
            user_move_from_event(-32000, -32000, false, None, Some(IslandPos { x: 731, y: 412 })),
            None
        );
    }

    /// A genuine drag is still saved — the guard must not swallow real moves.
    #[test]
    fn a_real_drag_is_saved() {
        assert_eq!(
            user_move_from_event(731, 412, false, None, Some(IslandPos { x: 100, y: 100 })),
            Some(IslandPos { x: 731, y: 412 })
        );
        // The very first move, with nothing saved yet, is saved too.
        assert_eq!(
            user_move_from_event(731, 412, false, None, None),
            Some(IslandPos { x: 731, y: 412 })
        );
    }

    /// Our own placement is not a user move.
    #[test]
    fn our_own_placement_is_not_a_user_move() {
        assert_eq!(user_move_from_event(731, 412, false, Some((731, 412)), None), None);
    }

    /// A monitor to the left of the primary has a legitimate negative x; it must
    /// not be mistaken for the sentinel.
    #[test]
    fn looks_minimized_matches_only_the_parked_slot() {
        assert!(looks_minimized(-32000, -32000));
        assert!(looks_minimized(MINIMIZED_SENTINEL, MINIMIZED_SENTINEL));
        assert!(!looks_minimized(-1920, 0), "a left-hand monitor is not a sentinel");
        assert!(!looks_minimized(0, 0));
        assert!(!looks_minimized(-32000, 412), "one negative axis is not the convention");
        assert!(!looks_minimized(731, -32000));
    }

    /// The companion contract's core rule (owner §36): the workspace is "on screen"
    /// only while it is visible and NOT minimised. A minimised main window must
    /// make the island return, and a hidden one must too.
    #[test]
    fn workspace_is_on_screen_only_when_visible_and_not_minimised() {
        assert!(workspace_on_screen(true, false), "shown and restored → island steps aside");
        assert!(!workspace_on_screen(true, true), "minimised → island returns even though Windows calls it visible");
        assert!(!workspace_on_screen(false, false), "hidden (closed) → island returns");
        assert!(!workspace_on_screen(false, true), "hidden and iconic → island returns");
    }
}
