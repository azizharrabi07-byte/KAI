// API keys live in the Windows Credential Manager, never on disk and never in
// the front end — the island can only ask whether a key is present.

use std::sync::OnceLock;

use keyring::Entry;

const SERVICE: &str = "com.aziz.kai";

/// Every key KAI may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    // ── KAI control layer ────────────────────────────────────────────────────
    // Hermes Agent api-server key (Bearer for the authenticated /v1 and
    // /api/sessions routes on 127.0.0.1:8642). Optional: /health needs none.
    "hermes-api-key",
    // Shared secret for the Core's host-attested chat relay (POST /chat). The
    // Core reads it from KAI_HOST_TOKEN; the app sends it back on
    // x-kai-host-token. Generated once, kept here so a Core started by a
    // previous run (or adopted on this one) still authenticates.
    "kai-host-token",
    // ── Third-party integrations ─────────────────────────────────────────────
    "anthropic-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

// ── The Core's host token ─────────────────────────────────────────────────────

const HOST_TOKEN_KEY: &str = "kai-host-token";

/// The shared secret for the Core's host-attested chat relay.
///
/// Generated once per install and kept in the Credential Manager, so the Core
/// (which reads it from `KAI_HOST_TOKEN`) and the app (which sends it on
/// `x-kai-host-token`) agree across restarts and across adoption of a Core a
/// previous run started. A `OnceLock` means every caller in this process gets the
/// same value even if the supervisor and the chat path race at startup.
///
/// `None` when the credential store is unavailable: the Core's relay then fails
/// closed (nothing is learned), which is the safe direction — an invented token
/// the Core was never told about would authenticate nothing anyway.
pub fn host_token() -> Option<String> {
    HOST_TOKEN.get_or_init(|| {
        if let Some(existing) = get(HOST_TOKEN_KEY) {
            return Some(existing);
        }
        let token = random_token();
        set(HOST_TOKEN_KEY, &token).ok().map(|()| token)
    }).clone()
}

static HOST_TOKEN: OnceLock<Option<String>> = OnceLock::new();

/// 128 bits of hex from the OS-seeded hasher plus the clock and pid. Not a
/// cryptographic RNG, but unpredictable enough for a loopback IPC token whose
/// only job is to be secret from other local processes.
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        hasher.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}
