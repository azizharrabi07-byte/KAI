/**
 * Live probe: the app's own Core client and event stream, run against a real KAI Core.
 *
 * Why this exists: the two modules were written while the Core happened to be down, so
 * their tests use injected fakes and prove the logic but not the contract. This drives
 * the real client against the real server, including the SSE path — a stream event is
 * triggered on purpose (a memory write) and we wait for it to arrive.
 *
 *   node C:/Users/DELL/Desktop/kai/docs/evidence/ui-core-link-probe.mts
 *
 * Read-only except for the one memory it writes, which is marked as a probe.
 */

import { createCoreClient } from "../../app/src/core/kai-core.ts";
import { createCoreEventStream } from "../../app/src/core/core-events.ts";

const client = createCoreClient({ timeoutMs: 8000 });
const events: string[] = [];

const stream = createCoreEventStream({
  onEvent: (event) => events.push(event.type),
  onState: (state) => console.log(`  stream state: ${state}`),
});

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

console.log(`base url: ${client.baseUrl}\n`);

// ── request path ────────────────────────────────────────────────────────────────
const ping = await client.ping();
check("ping", ping.ok);

const state = await client.state();
if (state.ok) {
  const agents = state.value.agents.map((a) => `${a.id}:${a.state}`).join(", ");
  check("GET /state", true, `agents=[${agents}] tools=${state.value.tools?.registered ?? "?"}`);
} else {
  check("GET /state", false, `${state.error.code}: ${state.error.message}`);
}

const agents = await client.agents();
check("GET /agents", agents.ok, agents.ok ? `${agents.value.length} agent(s)` : agents.error.code);

const one = await client.agent("hermes");
check("GET /agents/hermes", one.ok, one.ok ? one.value.state : one.error.code);

const missions = await client.missions({ limit: 5 });
check("GET /missions", missions.ok, missions.ok ? `${missions.value.length} mission(s)` : missions.error.code);

const notifications = await client.notifications({ limit: 5 });
check("GET /notifications", notifications.ok, notifications.ok ? `${notifications.value.length}` : notifications.error.code);

const approvals = await client.approvals();
check("GET /approvals", approvals.ok, approvals.ok ? `${approvals.value.length}` : approvals.error.code);

const memory = await client.memory({ limit: 5 });
check("GET /memory", memory.ok);

// ── the stream, proven by causing an event ──────────────────────────────────────
stream.connect();
await new Promise((resolve) => setTimeout(resolve, 1200));

const wrote = await client.remember({
  type: "project_fact",
  content: "ui-core-link-probe: the island's client reached the Core's event stream.",
  importance: 1,
});
check("POST /memory (triggers memory.created)", wrote.ok, wrote.ok ? "" : wrote.error.code);

await new Promise((resolve) => setTimeout(resolve, 1500));
check("SSE /core/events delivered the event", events.includes("memory.created"), `saw [${events.join(", ")}]`);

// ── chat answered from state, not from a model ──────────────────────────────────
const chat = await client.chat("what is happening?");
if (chat.ok) {
  check("POST /chat", true, `agent=${chat.value.agent} from_state=${String(chat.value.fromState)}`);
  console.log(`      reply: ${chat.value.reply}`);
} else {
  check("POST /chat", false, chat.error.code);
}

stream.disconnect();
console.log(`\nframes received: ${stream.received}`);
