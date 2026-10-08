// Claude API client — the same integration as ClaudeService.swift: multi-turn
// chat with web search, and files sent as document/image/text blocks.
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;
/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;

/// KAI Core's chat relay (see core/src/server.ts, POST /chat).
///
/// The control layer answers through the local agent servers, so a turn works on
/// a machine with no Anthropic account — which is the difference between the
/// island's chat working and not. Left as a constant rather than a setting: it is
/// loopback, needs no credential, and there is exactly one place it can be.
const CORE_CHAT_URL: &str = "http://127.0.0.1:8788/chat";
/// A turn has to survive a slow model; the whole run is one HTTP request.
const CORE_CHAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// What KAI says, in its own voice, when KAI Core cannot be reached and KAI has
/// no direct model of its own to answer with.
///
/// KAI Core is the only authority that may speak as KAI. The Hermes worker is
/// NOT KAI: it answers in its own voice and self-describes as Hermes on its own
/// model/profile, and presenting that as KAI's own speech is exactly the
/// "Hermes wearing KAI's name" defect. So the offline behaviour is one named
/// thing — honest, in KAI's words, and never silent.
const CORE_UNREACHABLE: &str = "I can't reach my Core right now — KAI Core isn't \
running, so I can't take this turn as myself. KAI starts its Core on its own; if \
it stays down, check the KAI log or open Settings.";

pub const DEFAULT_MODEL: &str = "claude-opus-5";

const SYSTEM_PROMPT: &str = "You are KAI, a personal AI assistant living at the top of the user's screen. \
You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

#[derive(Default)]
pub struct Chat {
    /// Direct-Claude multi-turn history, keyed by the KAI session it belongs to.
    ///
    /// Only used by the direct Claude path — KAI Core keeps its own per-session
    /// transcript and binds the worker conversation to the session. A single
    /// global transcript was the session-isolation bug: after switching KAI
    /// sessions, a turn could continue the previous session's conversation.
    conversations: Mutex<HashMap<String, Vec<Value>>>,
}

impl Chat {
    /// Clears one KAI session's direct-path history. `None` is the no-session bucket.
    pub fn reset(&self, conversation_id: Option<&str>) {
        self.conversations
            .lock()
            .unwrap()
            .remove(conversation_id.unwrap_or(""));
    }

    fn is_empty(&self, key: &str) -> bool {
        self.conversations
            .lock()
            .unwrap()
            .get(key)
            .map_or(true, |messages| messages.is_empty())
    }

    fn push(&self, key: &str, message: Value) {
        self.conversations
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default()
            .push(message);
    }

    fn pop(&self, key: &str) {
        if let Some(messages) = self.conversations.lock().unwrap().get_mut(key) {
            messages.pop();
        }
    }

    fn snapshot(&self, key: &str) -> Vec<Value> {
        self.conversations
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
    conversation_id: Option<String>,
) -> Result<ChatReply, String> {
    // The direct-Claude history is per KAI session; `""` is the no-session bucket.
    let key = conversation_id.clone().unwrap_or_default();

    // KAI CORE IS TRIED FIRST. It is the control plane: it decides whether this is a
    // question about KAI's own state (answered from state, no model turn), ordinary
    // work for a worker agent, or something it needs to plan. Only when the Core is
    // not running at all does the chain below take over, so the island still works on
    // a machine without it.
    //
    // This order was the other way round until now, and it was the single reason the
    // product's own claim was false: with the Hermes gateway first, every message the
    // user typed went to Hermes and the Core was never reached, so "KAI" was a UI in
    // front of Hermes rather than the agent making the decision.
    //
    // The turn names the KAI session it belongs to (`conversation_id`). The worker
    // conversation is Core's to bind to that session, so the app must NOT send a
    // cached worker `session_id`: doing so overrode the per-session binding and let a
    // turn after a session switch continue the previous session's worker conversation.
    match core_chat(conversation_id.as_deref(), &query).await {
        Ok(Some(text)) => return Ok(ChatReply { text }),
        Ok(None) => {}
        // The Core answered and it said no: that is the honest error to show.
        // Silently retrying against another provider would report a success the
        // control plane never had.
        Err(message) => return Err(message),
    }

    // KAI's Core did not take the turn. KAI Core is the only authority that may
    // speak as KAI, so the Hermes worker's reply is NOT handed back as KAI's own
    // speech: the worker answers in its own voice — it self-describes as Hermes on
    // its own model/profile — and showing that under KAI's name is exactly the
    // "Hermes with KAI's name" defect this path used to produce. KAI says, honestly
    // and in its own words, that it cannot reach its Core instead of going silent or
    // borrowing the worker's words.
    //
    // KAI's own direct model still answers under KAI's system prompt, so it is KAI's
    // voice, not a worker's: when the owner has stored a key the turn goes there;
    // otherwise the honest failure below is the whole answer.
    let Some(key_secret) = secrets::get("anthropic-api-key") else {
        return answer_without_core(None);
    };

    let mut content: Vec<Value> = Vec::new();

    // File / window context rides along with the first message only, exactly
    // like ClaudeService.chat().
    if chat.is_empty(&key) {
        match &context {
            Some(ChatContext::File { name, path }) => {
                if let Some(block) = file_block(path) {
                    content.push(block);
                }
                content.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                content.push(json!({ "type": "text", "text": text }));
            }
            None => {}
        }
    }
    content.push(json!({ "type": "text", "text": query }));

    chat.push(&key, json!({ "role": "user", "content": content }));

    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "fallbacks": "default",
        "messages": chat.snapshot(&key),
    });

    let response = match call(&key_secret, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(&key); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        chat.pop(&key);
        let why = response
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("Claude declined this one.");
        return Err(why.to_string());
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array).cloned() else {
        chat.pop(&key);
        return Err("Unexpected API response.".into());
    };

    // Store the whole content — tool_use / tool_result blocks included — so the
    // next turn has the right context.
    chat.push(&key, json!({ "role": "assistant", "content": blocks.clone() }));

    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("No response text.".into());
    }
    answer_without_core(Some(text))
}

/// The reply for a turn KAI Core did not take.
///
/// `direct_model` is what KAI's OWN direct model answered, when one is configured.
/// There is deliberately NO input for a worker's reply: the Hermes worker is not a
/// source of KAI's speech, so no worker text can reach KAI's chat by this path —
/// which is the identity leak this pins.
fn answer_without_core(direct_model: Option<String>) -> Result<ChatReply, String> {
    match direct_model {
        Some(text) => Ok(ChatReply { text }),
        None => Err(CORE_UNREACHABLE.to_string()),
    }
}

/// One turn through KAI Core's relay.
///
/// `Ok(Some(text))` — the control layer answered.
/// `Ok(None)`      — nothing is listening on KAI Core's port; not an error, the
///                   caller falls back to the direct Claude path.
/// `Err(message)`  — KAI Core answered and the turn failed; message is shown.
///
/// The turn carries `conversation_id` — the KAI session it belongs to — and NOT a
/// worker `session_id`. Core binds each worker conversation to its KAI session and
/// prefers that binding, so sending a cached worker id here is exactly what let a
/// turn continue the previous session's worker conversation after a switch. The
/// worker binding persists in Core, so a restart resumes the same conversation.
async fn core_chat(conversation_id: Option<&str>, query: &str) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(CORE_CHAT_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let mut body = json!({ "text": query });
    if let Some(id) = conversation_id {
        if !id.is_empty() {
            body["conversation_id"] = json!(id);
        }
    }

    // The host token authenticates the user-authority learning call the relay
    // makes for this turn. Without it the Core answers the turn but records no
    // user authority — which is exactly right for anything that is not KAI.
    let mut request = client.post(CORE_CHAT_URL).json(&body);
    if let Some(token) = secrets::host_token() {
        request = request.header("x-kai-host-token", token);
    }

    let response = match request.send().await {
        Ok(response) => response,
        // Connection refused / no route: KAI Core is simply not running.
        Err(_) => return Ok(None),
    };

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .or_else(|| v.get("reason"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("KAI Core {status}: {detail}"));
    }

    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Bad KAI Core response: {e}"))?;

    // Core owns the worker-session binding now; the returned `session_id` is the
    // WORKER's conversation id and must not be cached here as KAI's session. The
    // next turn names its KAI session instead and lets Core resolve the binding.

    let reply = value
        .get("reply")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if reply.is_empty() {
        return Err("KAI Core returned an empty reply.".into());
    }
    Ok(Some(reply))
}

async fn call(key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(ENDPOINT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("Claude API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// PDF → document block, image → image block, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{answer_without_core, base64, CORE_UNREACHABLE};

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    /// The offline path (KAI Core unreachable) must speak as KAI — honestly, and
    /// never as a worker.
    ///
    /// The live defect this pins: with the Core stopped, `send` fell through to
    /// the Hermes worker, and the island rendered the worker's OWN
    /// self-description ("running on the default profile (deepseek-v4.1-flash via
    /// opencode-go)") as KAI's speech. The behaviour chosen instead is an honest,
    /// KAI-voiced failure, with KAI's own direct model as the only other voice.
    #[test]
    fn without_core_kai_answers_in_its_own_voice_never_a_workers() {
        // No direct model configured: KAI says, in its own words, that it cannot
        // reach its Core. Not silence, and not the worker's words.
        let err = match answer_without_core(None) {
            Err(message) => message,
            Ok(_) => panic!("the offline path must be an honest failure, not an answer"),
        };
        assert_eq!(err, CORE_UNREACHABLE);
        assert!(!err.trim().is_empty(), "KAI must never go silent");
        assert!(err.contains("Core"), "the failure must name KAI's Core: {err}");

        // No worker identity may appear: these are the marks of the Hermes worker
        // that leaked in the live defect. A worker's self-description is not KAI's.
        for leaked in [
            "Hermes",
            "Nous Research",
            "opencode-go",
            "deepseek",
            "default profile",
            "api_server",
            "worker",
        ] {
            assert!(
                !err.contains(leaked),
                "worker identity leaked into KAI's offline reply: {leaked}"
            );
        }

        // KAI's own direct model answers under KAI's system prompt, so it IS KAI's
        // voice and passes through unchanged.
        let ok = match answer_without_core(Some("I am KAI.".to_string())) {
            Ok(reply) => reply,
            Err(message) => panic!("a direct answer must not fail: {message}"),
        };
        assert_eq!(ok.text, "I am KAI.");
    }
}
