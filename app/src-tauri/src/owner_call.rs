// Owner-authorized calls to KAI Core.
//
// The Core's owner-only routes — goals, the Doer switch, approval decisions,
// policy rules, the soul — refuse any caller that cannot prove it holds the
// per-install host token. That token lives in the OS credential store, and it is
// deliberately NEVER handed to JavaScript: a webview can be inspected and a
// token in JS is a token in devtools.
//
// So the request is made HERE, in Rust, and only the response crosses back. The
// origin is fixed by this module — the caller supplies a PATH, never a URL — so
// the token can never be pointed at another host.
//
// This is the same credential the Core's chat relay already uses
// (see `claude.rs`), reused rather than a second token: one install, one secret,
// no drift.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::{core_process, secrets};

#[derive(Serialize)]
pub struct OwnerResponse {
    pub status: u16,
    pub body: Value,
}

const OWNER_CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// A Core API path, and nothing more.
///
/// Rejecting a scheme, an authority or a traversal keeps the token bound to the
/// loopback Core: without this check a caller could ask this command to send the
/// credential to `http://elsewhere/…`, which is precisely the leak the whole
/// design exists to prevent.
fn is_core_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains("://")
        && !path.contains('@')
        && !path.contains('\\')
        && !path.contains('\n')
        && !path.contains('\r')
        && !path.contains("..")
        && path.len() <= 2048
}

/// Perform an owner-authorized Core request with the install's host token.
///
/// The Core answers 401 when the credential is missing or wrong, so a `status`
/// of 401 here means the Core is enforcing owner-only access and this process
/// could not prove itself — reported as-is rather than retried.
#[tauri::command]
pub async fn core_owner_call(
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<OwnerResponse, String> {
    let method = method.to_uppercase();
    if method != "GET" && method != "POST" {
        return Err("method must be GET or POST".to_string());
    }
    if !is_core_path(&path) {
        return Err("path must be a Core API path, not a URL".to_string());
    }

    let token = secrets::host_token()
        .ok_or_else(|| "the owner credential is unavailable on this machine".to_string())?;

    let url = format!("http://127.0.0.1:{}{}", core_process::port(), path);
    let client = reqwest::Client::builder()
        .timeout(OWNER_CALL_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;

    let mut request = if method == "GET" {
        client.get(&url)
    } else {
        client.post(&url)
    };
    request = request.header("x-kai-host-token", token);
    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    // A non-JSON body (a proxy error page, an empty 204) must not fail the call:
    // the status is the fact the caller needs, and `null` says "no body".
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok(OwnerResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::is_core_path;

    #[test]
    fn accepts_core_paths() {
        assert!(is_core_path("/goals"));
        assert!(is_core_path("/goals/g1/approve"));
        assert!(is_core_path("/doer"));
        assert!(is_core_path("/approvals/apr_1/decide"));
    }

    #[test]
    fn refuses_anything_that_could_redirect_the_token() {
        // A full URL, an authority, a traversal or a scheme must never be sent
        // the credential.
        assert!(!is_core_path("http://elsewhere/steal"));
        assert!(!is_core_path("//elsewhere/steal"));
        assert!(!is_core_path("/../secrets"));
        assert!(!is_core_path("goals"));
        assert!(!is_core_path("/goals\nHost: elsewhere"));
        assert!(!is_core_path("/goals\\..\\.."));
        assert!(!is_core_path("/a@b"));
    }
}
