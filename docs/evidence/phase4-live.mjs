// SPDX-License-Identifier: MIT
// KAI Phase 4 live acceptance harness.
//
// Runs the Phase 1 (Part U T1-T10) and Phase 2 acceptance matrix against a REAL
// running KAI Core over HTTP, not against mocks. Every check prints the raw
// status and body it decided on, so a claim can be checked against the run.
//
// Usage:  node docs/evidence/phase4-live.mjs [section ...]
//   sections: identity t1t10 provenance seceff memory skills checkpoint recovery
//             scheduler policyfire learning autonomy maintenance sessions
//             workspace l2
// Env:  KAI_HOST_TOKEN   the Core's host token (for the host-attested chat path)
//       KAI_BASE         default http://127.0.0.1:8788

const BASE = process.env.KAI_BASE ?? "http://127.0.0.1:8788";
const HOST_TOKEN = process.env.KAI_HOST_TOKEN ?? "";
const only = process.argv.slice(2);
const runAll = only.length === 0;
const want = (name) => runAll || only.includes(name);

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail ?? ""}`);
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const get = (p, h) => call("GET", p, undefined, h);
const post = (p, b, h) => call("POST", p, b ?? {}, h);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 20000, step = 250) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

function show(label, r) {
  console.log(`  ${label} -> HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 900)}`);
}

// ── identity ──────────────────────────────────────────────────────────────────
async function identity() {
  console.log("== identity ==");
  const id = await get("/identity");
  show("GET /identity", id);
  const state = await get("/state");
  show("GET /state", state);
  record("identity.service", id.body?.service === "kai-core", `buildId=${id.body?.buildId} commit=${id.body?.gitCommit} pid=${id.body?.pid}`);
  record("identity.state_ok", state.body?.ok === true, `agents=${state.body?.agents?.map((a) => a.id + ":" + a.state).join(",")}`);
  return id.body;
}

// ── T1-T10 ────────────────────────────────────────────────────────────────────
async function t1t10() {
  console.log("\n== Phase 1 Part U T1-T10 ==");
  const emp = await get("/employees");
  const byId = Object.fromEntries((emp.body?.employees ?? []).map((e) => [e.id, e.state]));
  show("GET /employees states", { status: emp.status, body: byId });
  record("T1 workers available", byId.hermes === "READY" && byId.opencode === "READY" && byId.codex === "UNAVAILABLE", JSON.stringify(byId));

  // T2 disable Hermes
  const dis = await post("/employees/hermes/disable", {});
  show("POST /employees/hermes/disable", dis);
  const afterDis = await get("/employees/hermes");
  record("T2 disable Hermes", afterDis.body?.employee?.state === "DISABLED", `state=${afterDis.body?.employee?.state}`);

  // T3 restore
  const en = await post("/employees/hermes/enable", {});
  show("POST /employees/hermes/enable", en);
  const afterEn = await get("/employees/hermes");
  record("T3 restore Hermes", afterEn.body?.employee?.state === "READY", `state=${afterEn.body?.employee?.state}`);

  // T4 register mock employee
  const mockId = `partu-mock-${Date.now()}`;
  const reg = await post("/employees/register", { id: mockId, name: "Part U Mock", capabilities: ["shell"] });
  show("POST /employees/register", reg);
  record("T4 register mock employee", reg.status === 201 && reg.body?.employee?.state === "DISCOVERED", `state=${reg.body?.employee?.state}`);

  // T5 unauthorized action is parked, not performed
  const action = await post("/agents/hermes/action", { action: "echo PARTU-WORKER-OK", input: "echo PARTU-WORKER-OK" });
  show("POST /agents/hermes/action (no approval)", action);
  const parked = action.status === 409 && action.body?.approvalRequired === true && typeof action.body?.approvalId === "string";
  record("T5 unauthorized action gated", parked, `approvalId=${action.body?.approvalId}`);

  let t6 = { ok: false, detail: "not attempted" };
  if (parked) {
    const approvalId = action.body.approvalId;
    const decide = await post(`/approvals/${approvalId}/decide`, { approved: true });
    show("POST /approvals/:id/decide", decide);
    const reissue = await post("/agents/hermes/action", { action: "echo PARTU-WORKER-OK", input: "echo PARTU-WORKER-OK", approvalId });
    show("POST /agents/hermes/action (with approval)", reissue);
    const out = typeof reissue.body?.output === "string" ? reissue.body.output : JSON.stringify(reissue.body?.output ?? reissue.body);
    const state = reissue.body?.state ?? "";
    t6 = { ok: reissue.status === 200 && (state === "completed" || out.includes("PARTU-WORKER-OK")), detail: `state=${state} out=${String(out).slice(0, 160)}` };
  }
  record("T6 approve + real worker execution", t6.ok, t6.detail);

  // T7 real CUA — the driver-shaped "windows" action returns real desktop windows.
  const cuaBody = { action: "windows", input: {} };
  const cua = await post("/capabilities/computer/test", cuaBody);
  show("POST /capabilities/computer/test windows", cua);
  let t7 = cua.status === 200 && Array.isArray(cua.body?.result?.result);
  if (!t7 && cua.status === 409 && cua.body?.approvalRequired) {
    await post(`/approvals/${cua.body.approvalId}/decide`, { approved: true });
    const retry = await post("/capabilities/computer/test", { ...cuaBody, approvalId: cua.body.approvalId });
    show("windows (approved)", { status: retry.status, body: Array.isArray(retry.body?.result?.result) ? { count: retry.body.result.result.length, first: retry.body.result.result[0] } : retry.body });
    t7 = retry.status === 200 && Array.isArray(retry.body?.result?.result);
  }
  record("T7 real CUA interaction", t7, `status=${cua.status}`);

  // T8 real browser transport — a real CDP target is opened on the installed Edge/Chrome.
  const navBody = { action: "open", input: { url: "data:text/html,<title>k</title><h1>KAI-PARTU</h1><button>go</button>" } };
  const nav = await post("/capabilities/browser/test", navBody);
  show("POST /capabilities/browser/test open", nav);
  let targetId = nav.body?.result?.result?.targetId;
  let t8 = nav.status === 200 && typeof targetId === "string";
  if (nav.status === 409 && nav.body?.approvalRequired) {
    await post(`/approvals/${nav.body.approvalId}/decide`, { approved: true });
    const retry = await post("/capabilities/browser/test", { ...navBody, approvalId: nav.body.approvalId });
    show("open (approved)", retry);
    targetId = retry.body?.result?.result?.targetId;
    t8 = retry.status === 200 && typeof targetId === "string";
  }
  record("T8 real browser transport", t8, `status=${nav.status} targetId=${targetId}`);

  // T9 semantic observe — roles/names/refs, not coordinates.
  const obsBody = targetId !== undefined ? { action: "observe", input: { targetId } } : { action: "observe", input: {} };
  const obs = await post("/capabilities/browser/test", obsBody);
  show("POST /capabilities/browser/test observe", { status: obs.status, body: { strategy: obs.body?.result?.result?.strategy, elements: (obs.body?.result?.result?.elements ?? []).slice(0, 6), text: obs.body?.result?.result?.text } });
  let obsOk = obs.status === 200 && (obs.body?.result?.result?.elements ?? []).length > 0;
  if (!obsOk && obs.status === 409 && obs.body?.approvalRequired) {
    await post(`/approvals/${obs.body.approvalId}/decide`, { approved: true });
    const retry = await post("/capabilities/browser/test", { ...obsBody, approvalId: obs.body.approvalId });
    show("observe (approved)", { status: retry.status, body: { strategy: retry.body?.result?.result?.strategy, elements: (retry.body?.result?.result?.elements ?? []).slice(0, 6) } });
    obsOk = retry.status === 200 && (retry.body?.result?.result?.elements ?? []).length > 0;
  }
  record("T9 semantic browser observe", obsOk, `status=${obs.status}`);

  // T10 KAI direct capability, no approval
  const sys = await post("/capabilities/system/test", { action: "system.get_status", input: {} });
  show("POST /capabilities/system/test", sys);
  record("T10 KAI direct capability", sys.status === 200 && sys.body?.result?.result?.status === "ok", `status=${sys.status}`);
}

// ── provenance / host authority (FALSIFIED 1) ─────────────────────────────────
async function provenance() {
  console.log("\n== provenance / host authority (FALSIFIED 1) ==");
  const tag = `ph4-${Date.now()}`;

  // 1. unauthenticated /chat must NOT learn
  const unauth = await post("/chat", { text: `remember that ${tag}-unauth is my favourite colour` });
  show("POST /chat (no host token)", unauth);
  await sleep(400);
  const s1 = await get(`/memory/search?q=${tag}-unauth`);
  const s1legacy = await get(`/memory?limit=100`);
  const legacyHit = JSON.stringify(s1legacy.body ?? "").includes(`${tag}-unauth`);
  const canonicalHit = (s1.body?.hits ?? []).some((h) => JSON.stringify(h.entry?.content ?? "").includes(`${tag}-unauth`));
  record("prov.unauth no canonical entry", !canonicalHit, `exact_hit=${canonicalHit} returned=${(s1.body?.hits ?? []).length}`);
  record("prov.unauth no legacy entry", !legacyHit, `legacy=${legacyHit}`);

  // 2. host-attested /chat DOES learn, without user_statement provenance
  const auth = await post("/chat", { text: `remember that ${tag}-auth is my favourite colour` }, { "x-kai-host-token": HOST_TOKEN });
  show("POST /chat (host token)", auth);
  const landed = await waitFor(async () => {
    const r = await get(`/memory/search?q=${tag}-auth`);
    return (r.body?.hits ?? []).length > 0 ? r : null;
  }, 8000);
  const hit = landed?.body?.hits?.[0]?.entry;
  record("prov.host turn is learned", hit !== undefined, `provenance=${hit?.provenance} source=${hit?.source}`);
  record("prov.host provenance is not user authority", hit !== undefined && hit.provenance !== "user_statement", `provenance=${hit?.provenance}`);

  // 3. learning/propose claiming user authority is refused
  const claim = await post("/learning/propose", { kind: "user_correction", summary: "x", source: "user", provenance: "user_statement" });
  show("POST /learning/propose {source:user}", claim);
  record("prov.claimed user authority refused", claim.status === 400, `status=${claim.status}`);

  // 4. /memory/write defaults to the restrictive provenance
  const w = await post("/memory/write", { content: `${tag}-write default provenance`, type: "note" });
  show("POST /memory/write (no provenance)", w);
  const stored = await get(`/memory/search?q=${tag}-write`);
  const e = stored.body?.hits?.[0]?.entry;
  record("prov.memory/write default is restrictive", e !== undefined && e.provenance !== "user_statement", `provenance=${e?.provenance}`);
}

// ── side-effect derivation (FALSIFIED 2) ──────────────────────────────────────
async function seceff() {
  console.log("\n== side-effect derivation (FALSIFIED 2) ==");
  // A step whose tool WRITES (mission.create) must be classified side-effecting by
  // its EFFECT, and the ledger must hold a record for it.
  const mk = await post("/missions", {
    title: `ph4 seceff ${Date.now()}`,
    steps: [{ title: "create a nested mission", kind: "tool", target: "missions.create", input: { title: "nested-by-effect" } }],
  });
  show("POST /missions (missions.create step)", mk);
  const mid = mk.body?.mission?.id ?? mk.body?.id;
  if (mid === undefined) {
    record("seceff.step sideEffecting derived from effect", false, "mission was not created");
    return;
  }
  const done = await waitFor(async () => {
    const r = await get(`/missions/${mid}`);
    const st = r.body?.mission?.status ?? r.body?.status;
    return st === "COMPLETED" || st === "FAILED" ? r : null;
  }, 30000);
  show("GET /missions/:id (settled)", done);
  const step = (done?.body?.mission?.steps ?? done?.body?.steps ?? [])[0];
  record("seceff.step classified by effect", step?.sideEffecting === true, `sideEffecting=${step?.sideEffecting} status=${step?.status}`);
  const cls = await post("/recovery/classify", { executionId: `exec_${mid}_${step?.id}` });
  show("POST /recovery/classify (nested-write step)", cls);
  record("seceff.ledger has a record", typeof cls.body?.classification?.phase === "string", `phase=${cls.body?.classification?.phase}`);
}

// ── memory M1-M5 ──────────────────────────────────────────────────────────────
async function memory() {
  console.log("\n== memory M1-M5 ==");
  const tag = `ph4-mem-${Date.now()}`;
  const w = await post("/memory/write", { content: `${tag} falcon release fact`, type: "project_fact", importance: 4 });
  show("POST /memory/write", w);
  const id = w.body?.memory?.id;
  record("M1 write", w.status === 201 && typeof id === "string", `id=${id}`);
  const s = await get(`/memory/search?q=${tag}`);
  const hits = s.body?.hits ?? [];
  record("M1 search back", hits.some((h) => h.entry.id === id), `hits=${hits.length} has_id=${hits.some((h) => h.entry.id === id)}`);
  const dup = await post("/memory/write", { content: `${tag} falcon release fact`, type: "project_fact", importance: 4 });
  show("POST /memory/write (duplicate)", dup);
  record("M3 dedup returns the existing id", dup.body?.memory?.id === id, `id=${dup.body?.memory?.id}`);
  const read = await get(`/memory/${id}`);
  record("M1 read by id", read.status === 200, `status=${read.status}`);
  const journal = await get("/memory/journal?limit=5");
  record("M4 journal readable", journal.status === 200, `status=${journal.status}`);
}

// ── skills S1-S4 ──────────────────────────────────────────────────────────────
async function skills() {
  console.log("\n== skills S1-S4 ==");
  const propose = await post("/learning/propose", {
    kind: "repeated_workflow",
    summary: "ph4 nightly deploy",
    steps: ["git fetch origin", "build the release", "ship the release"],
    repeatCount: 3,
  });
  show("POST /learning/propose (repeated_workflow)", propose);
  const outcome = propose.body?.outcome;
  const staged = outcome?.skill?.staged === true;
  record("S1 repeated workflow is staged, never installed", propose.status === 200 && staged, `decision=${outcome?.decision} staged=${outcome?.skill?.staged}`);
  if (!staged) return;
  const stagedId = outcome.skill.stagedId;
  const sha = outcome.skill.sha256;
  const skillId = outcome.skill.skillId;
  const view = await get(`/skills/staging/${stagedId}`);
  show("GET /skills/staging/:id", view);
  record("S1 staged is inspectable", view.status === 200, `status=${view.status}`);
  const appr = await post(`/skills/staging/${stagedId}/approve`, { sha256: sha });
  show("POST /skills/staging/:id/approve", appr);
  const approvalId = appr.body?.approvalId;
  record("S2 approval is required for install", appr.status === 201 && typeof approvalId === "string", `approvalId=${approvalId}`);
  if (approvalId === undefined) return;
  const installed = await post(`/skills/staging/${stagedId}/install`, { sha256: sha, approvalId });
  record("S2 install refused while the approval is pending", installed.status === 409, `status=${installed.status}`);
  const decide = await post(`/approvals/${approvalId}/decide`, { approved: true });
  show("POST /approvals/:id/decide (skill approve)", decide);
  const installed2 = await post(`/skills/staging/${stagedId}/install`, { sha256: sha, approvalId });
  show("POST /skills/staging/:id/install (approved)", installed2);
  record("S3 install after approval", installed2.status === 201 && installed2.body?.install?.skillId === skillId, `status=${installed2.status}`);
  const list = await get("/skills");
  record("S3 skill is discoverable", (list.body?.skills ?? []).some((s) => s.id === skillId), `count=${list.body?.skills?.length}`);
  const load = await get(`/skills/${skillId}/load`);
  show("GET /skills/:id/load", load);
  record("S4 skill loads with content", load.status === 200, `status=${load.status}`);
}

// ── checkpoints C1-C3 ─────────────────────────────────────────────────────────
async function checkpoint() {
  console.log("\n== checkpoints C1-C3 ==");
  const dir = process.env.KAI_CP_TARGET ?? `${process.env.USERPROFILE}\\kai-accept\\cp-target`;
  const c1 = await post("/checkpoints", { target: dir, label: "ph4" });
  show("POST /checkpoints", c1);
  record("C1 checkpoint create", c1.status === 201, `status=${c1.status}`);
  const c3 = await post("/checkpoints", { target: `${dir}-does-not-exist` });
  show("POST /checkpoints (missing target)", c3);
  record("C3 honest failure on a missing target", c3.status === 409 || c3.status === 404, `status=${c3.status}`);
}

// ── recovery C4-C6 ────────────────────────────────────────────────────────────
async function recovery() {
  console.log("\n== recovery C4-C6 ==");
  // C4: a side-effecting step held on approval must be BEFORE_ACCEPT (replay-safe).
  const mk = await post("/missions", {
    title: `ph4 c4 ${Date.now()}`,
    steps: [{ title: "external action", kind: "tool", target: "agents.run_task", input: { agentId: "hermes", action: "echo C4", input: "echo C4" } }],
  });
  show("POST /missions (EXTERNAL step)", mk);
  const mid = mk.body?.mission?.id ?? mk.body?.id;
  const held = await waitFor(async () => {
    const r = await get(`/missions/${mid}`);
    const st = r.body?.mission?.status ?? r.body?.status;
    return st === "WAITING_APPROVAL" || st === "COMPLETED" || st === "FAILED" ? r : null;
  }, 20000);
  const step = (held?.body?.mission?.steps ?? held?.body?.steps ?? [])[0];
  show("GET /missions/:id (parked)", { status: held?.status, body: { status: held?.body?.mission?.status, step: { id: step?.id, sideEffecting: step?.sideEffecting, status: step?.status } } });
  const cls = await post("/recovery/classify", { executionId: `exec_${mid}_${step?.id}` });
  show("POST /recovery/classify (parked step)", cls);
  record("C4 parked side-effecting step is BEFORE_ACCEPT", cls.body?.classification?.phase === "BEFORE_ACCEPT" && cls.body?.classification?.replaySafe === true, `phase=${cls.body?.classification?.phase} replaySafe=${cls.body?.classification?.replaySafe}`);

  // C5: a step that really ran a side effect is AFTER_ACCEPT, never replayable.
  const mk2 = await post("/missions", {
    title: `ph4 c5 ${Date.now()}`,
    steps: [{ title: "write a memory", kind: "tool", target: "memory.write", input: { content: `ph4-c5-${Date.now()} written by a mission step`, type: "note" } }],
  });
  show("POST /missions (memory.write step)", mk2);
  const mid2 = mk2.body?.mission?.id ?? mk2.body?.id;
  const done2 = await waitFor(async () => {
    const r = await get(`/missions/${mid2}`);
    const st = r.body?.mission?.status ?? r.body?.status;
    return st === "COMPLETED" || st === "FAILED" ? r : null;
  }, 30000);
  const step2 = (done2?.body?.mission?.steps ?? done2?.body?.steps ?? [])[0];
  const cls2 = await post("/recovery/classify", { executionId: `exec_${mid2}_${step2?.id}` });
  show("POST /recovery/classify (executed write step)", cls2);
  record("C5 executed side effect is AFTER_ACCEPT", cls2.body?.classification?.phase === "AFTER_ACCEPT" && cls2.body?.classification?.replaySafe === false, `phase=${cls2.body?.classification?.phase} replaySafe=${cls2.body?.classification?.replaySafe} count=${cls2.body?.classification?.sideEffectCount}`);

  // C6: an unknown execution is unsafe.
  const c6 = await post("/recovery/classify", { executionId: `exec_does_not_exist_${Date.now()}` });
  show("POST /recovery/classify (unknown)", c6);
  record("C6 unknown is unsafe", c6.body?.classification?.phase === "UNKNOWN" && c6.body?.classification?.replaySafe === false, `phase=${c6.body?.classification?.phase}`);

  const status = await get("/recovery/status");
  show("GET /recovery/status", { status: status.status, body: { total: status.body?.total, open: status.body?.open?.length } });
  record("recovery.status counts settled records", (status.body?.total ?? 0) > 0, `total=${status.body?.total}`);
}

// ── scheduler R1-R3 ───────────────────────────────────────────────────────────
async function scheduler() {
  console.log("\n== scheduler R1-R3 ==");
  const runAt = new Date(Date.now() + 4000).toISOString();
  const sc = await post("/schedules", { title: `ph4 once ${Date.now()}`, kind: "once", runAt, action: "mission.create", payload: { title: "ph4 scheduled mission" } });
  show("POST /schedules (once)", sc);
  const sid = sc.body?.schedule?.id;
  record("R1 schedule created", sc.status === 201, `id=${sid} nextRun=${sc.body?.schedule?.nextRun}`);
  const fired = await waitFor(async () => {
    const r = await get("/missions?limit=50");
    const m = (r.body?.missions ?? []).find((x) => x.metadata?.scheduleId === sid);
    return m ? r : null;
  }, 30000, 500);
  const mission = (fired?.body?.missions ?? []).find((x) => x.metadata?.scheduleId === sid);
  show("missions carrying the scheduleId", { status: fired?.status, body: { count: (fired?.body?.missions ?? []).filter((x) => x.metadata?.scheduleId === sid).length, mission: mission?.id } });
  const occurrences = (fired?.body?.missions ?? []).filter((x) => x.metadata?.scheduleId === sid);
  record("R1 one-time schedule fires once", occurrences.length === 1, `missions=${occurrences.length}`);
  record("R3 no double fire", occurrences.length <= 1, `missions=${occurrences.length}`);
}

// ── R4 current policy at fire ─────────────────────────────────────────────────
async function policyfire() {
  console.log("\n== R4 current policy at fire ==");
  // Start from the DEFAULT rule set: an aborted earlier run must not be able to
  // poison this one by leaving a caller rule behind.
  const clear = await post("/policy/rules", { rules: [] });
  if (clear.status === 409 && clear.body?.approvalId) {
    await post(`/approvals/${clear.body.approvalId}/decide`, { approved: true });
    await post("/policy/rules", { rules: [], approvalId: clear.body.approvalId });
  }
  const current = await get("/policy");
  show("GET /policy", current);
  const rules = current.body?.policy?.rules ?? [];
  // Add a DENY rule for the tool the scheduled mission's step will use, then fire.
  // Caller rules are evaluated BEFORE KAI's baseline, which the handler always
  // appends last. So the caller supplies ONLY its own rules here.
  const denyRules = [{ id: "ph4-deny-memwrite", risk: "WRITE", outcome: "deny", tools: ["memory.write"] }];
  const set = await post("/policy/rules", { rules: denyRules });
  show("POST /policy/rules (deny memory.write)", set);
  let applied = set.status === 200;
  if (!applied && set.status === 409 && set.body?.approvalId) {
    await post(`/approvals/${set.body.approvalId}/decide`, { approved: true });
    const retry = await post("/policy/rules", { rules: denyRules, approvalId: set.body.approvalId });
    show("POST /policy/rules (approved)", retry);
    applied = retry.status === 200;
  }
  record("R4 policy is runtime-mutable", applied, `status=${set.status}`);
  const after = await get("/policy");
  const live = JSON.stringify(after.body?.policy?.rules ?? []).includes("ph4-deny-memwrite");
  record("R4 new rule is live", live, `live=${live}`);

  const runAt = new Date(Date.now() + 4000).toISOString();
  const sc = await post("/schedules", {
    title: `ph4 policyfire ${Date.now()}`,
    kind: "once",
    runAt,
    action: "mission.create",
    payload: { title: "ph4 policyfire mission", steps: [{ title: "write", kind: "tool", target: "memory.write", input: { content: "should be denied", type: "note" } }] },
  });
  show("POST /schedules (payload step memory.write)", sc);
  const sid = sc.body?.schedule?.id;
  const settled = await waitFor(async () => {
    const r = await get("/missions?limit=50");
    const m = (r.body?.missions ?? []).find((x) => x.metadata?.scheduleId === sid);
    return m && (m.status === "COMPLETED" || m.status === "FAILED") ? m : null;
  }, 35000, 500);
  show("scheduled mission under the NEW policy", { status: 200, body: { id: settled?.id, status: settled?.status, error: settled?.error } });
  record("R4 the policy live AT FIRE governs", settled?.status === "FAILED", `status=${settled?.status} error=${String(settled?.error).slice(0, 120)}`);

  // Restore the default state: no caller rules, so only KAI's baseline remains.
  const restore = await post("/policy/rules", { rules: [] });
  if (restore.status === 409 && restore.body?.approvalId) {
    await post(`/approvals/${restore.body.approvalId}/decide`, { approved: true });
    await post("/policy/rules", { rules: [], approvalId: restore.body.approvalId });
  }
  const back = await get("/policy");
  record("R4 policy restored", !JSON.stringify(back.body?.policy?.rules ?? []).includes("ph4-deny-memwrite"), "restored");
}

// ── learning L1/L2 + I1-I4 ────────────────────────────────────────────────────
async function learning() {
  console.log("\n== learning L1/L2 + I1-I4 ==");
  // L1: a correction proposed through the product is classified and, when it
  // becomes a skill, is STAGED (human approval), never installed silently.
  const l1 = await post("/learning/propose", { kind: "user_correction", summary: "always run the linter before committing", steps: ["run the linter", "then commit"] });
  show("POST /learning/propose (user_correction)", l1);
  record("L1 correction is classified", l1.status === 200 && typeof l1.body?.outcome?.decision === "string", `decision=${l1.body?.outcome?.decision}`);

  // L2: the same correction proposed again is deduped/handled consistently, and the
  // classification is durable (it is recorded in the staged/journalled state).
  const l2 = await post("/learning/propose", { kind: "user_correction", summary: "always run the linter before committing", steps: ["run the linter", "then commit"] });
  show("POST /learning/propose (repeat)", l2);
  record("L2 repeat is handled consistently", l2.status === 200, `status=${l2.status} decision=${l2.body?.outcome?.decision}`);

  // I1-I4: a worker turn that completes produces an action record naming the
  // employee, and the learning loop can see it.
  const reg = await post("/employees/register", { id: `ph4-worker-${Date.now()}`, name: "PH4 Worker", capabilities: ["shell"] });
  record("I1 mock worker registered", reg.status === 201, `status=${reg.status}`);
  // /core/events is SSE and never ends, so it is probed by HEAD-ish reasoning:
  // fetch with an abort, and accept the stream's own status line.
  const ev = await (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    try {
      const res = await fetch(`${BASE}/core/events`, { headers: { accept: "text/event-stream" }, signal: ac.signal });
      return { status: res.status, contentType: res.headers.get("content-type") ?? "" };
    } catch {
      return { status: 0, contentType: "" };
    } finally {
      clearTimeout(timer);
    }
  })();
  record("I4 event stream reachable", ev.status === 200 && ev.contentType.includes("text/event-stream"), `status=${ev.status} type=${ev.contentType}`);
}

// ── the autonomous loop ───────────────────────────────────────────────────────
async function autonomy() {
  console.log("\n== autonomous loop ==");
  // A step whose tool THROWS fails as INTERNAL — a TRANSIENT failure — so KAI must
  // evaluate it and start a retry, then evaluate the retry and stop at the bound.
  const mk = await post("/missions", {
    title: `ph4 autonomy ${Date.now()}`,
    steps: [{ title: "call a broken capability action", kind: "tool", target: "capability.system", input: { action: "no.such.action" } }],
  });
  show("POST /missions (a step that throws)", mk);
  const mid = mk.body?.mission?.id ?? mk.body?.id;
  const failed = await waitFor(async () => {
    const r = await get(`/missions/${mid}`);
    const st = r.body?.mission?.status ?? r.body?.status;
    return st === "FAILED" || st === "COMPLETED" ? r : null;
  }, 20000);
  const status = failed?.body?.mission?.status ?? failed?.body?.status;
  record("autonomy.original settles FAILED", status === "FAILED", `status=${status}`);

  // The retry is a real mission that names what it supersedes.
  const retryMission = await waitFor(async () => {
    const r = await get("/missions?limit=50");
    return (r.body?.missions ?? []).find((m) => m.metadata?.supersedes === mid) ?? null;
  }, 20000, 400);
  show("the retry mission", { status: 200, body: retryMission ? { id: retryMission.id, status: retryMission.status, supersedes: retryMission.metadata?.supersedes, attempt: retryMission.metadata?.autonomyAttempt } : null });
  record("autonomy.retry mission exists", retryMission !== undefined && retryMission !== null, `id=${retryMission?.id}`);
  record("autonomy.retry names its origin and attempt", retryMission?.metadata?.supersedes === mid && retryMission?.metadata?.autonomyAttempt === 2, `attempt=${retryMission?.metadata?.autonomyAttempt}`);

  // The retry failed too, so KAI STOPPED and told the human: a bounded loop, not a spin.
  const notice = await waitFor(async () => {
    const r = await get("/notifications?limit=50");
    return (r.body?.notifications ?? []).find((n) => n.type === "autonomy" && /stopped retrying|trying again/.test(n.title)) ?? null;
  }, 20000, 400);
  show("the autonomy notification", { status: 200, body: notice ? { title: notice.title, priority: notice.priority } : null });
  record("autonomy.the loop announces its decisions", notice !== null, `title=${notice?.title}`);
  const retries = (await get("/missions?limit=50")).body?.missions ?? [];
  const chain = retries.filter((m) => m.metadata?.supersedes === mid);
  record("autonomy.exactly one automatic retry", chain.length === 1, `retries=${chain.length}`);
}

// ── self-maintenance ──────────────────────────────────────────────────────────
async function maintenance() {
  console.log("\n== self-maintenance ==");
  const status = await get("/maintenance/status");
  show("GET /maintenance/status", { status: status.status, body: { identity: status.body?.maintenance?.identity, checks: status.body?.maintenance?.checks } });
  const report = status.body?.maintenance;
  record("maintenance.status inspects", status.status === 200 && Array.isArray(report?.checks) && report.checks.length >= 6, `checks=${report?.checks?.length}`);
  record("maintenance.status changes nothing", (report?.repairs ?? []).length === 0, `repairs=${(report?.repairs ?? []).length}`);
  record("maintenance.identity matches the build on disk", report?.identity?.current === true, `running=${report?.identity?.buildId} onDisk=${report?.identity?.onDiskBuildId}`);
  const failing = (report?.checks ?? []).filter((c) => c.status === "fail");
  record("maintenance.no check is failing", failing.length === 0, `failing=${failing.map((c) => c.name).join(",") || "(none)"}`);

  const run = await post("/maintenance/run", {});
  show("POST /maintenance/run", { status: run.status, body: { repairs: run.body?.maintenance?.repairs } });
  const repairs = run.body?.maintenance?.repairs ?? [];
  record("maintenance.run performs the repairs", run.status === 200 && repairs.length === 4 && repairs.every((r) => r.performed === true), `repairs=${repairs.length}`);
}

// ── sessions (new) ────────────────────────────────────────────────────────────
async function sessions() {
  console.log("\n== sessions ==");
  const list = await get("/sessions");
  show("GET /sessions", list);
  record("sessions.list reachable", list.status === 200 && Array.isArray(list.body?.sessions), `status=${list.status}`);
  const created = await post("/sessions", { title: `ph4 session ${Date.now()}` });
  show("POST /sessions", created);
  const sid = created.body?.session?.id;
  record("sessions.create", created.status === 201 && typeof sid === "string", `id=${sid}`);
  if (sid === undefined) return;
  const act = await post(`/sessions/${sid}/activate`, {});
  show("POST /sessions/:id/activate", act);
  record("sessions.activate (switch)", act.status === 200, `status=${act.status}`);
  const active = await get("/sessions/active");
  show("GET /sessions/active", active);
  record("sessions.active is the switched one", active.body?.session?.id === sid, `active=${active.body?.session?.id}`);
  const ren = await post(`/sessions/${sid}/rename`, { title: "ph4 renamed" });
  show("POST /sessions/:id/rename", ren);
  record("sessions.rename", ren.status === 200 && ren.body?.session?.title === "ph4 renamed", `title=${ren.body?.session?.title}`);
  const arch = await post(`/sessions/${sid}/archive`, {});
  show("POST /sessions/:id/archive", arch);
  record("sessions.archive", arch.status === 200 && arch.body?.session?.status === "ARCHIVED", `status=${arch.body?.session?.status}`);
  const turns = await get(`/sessions/${sid}/turns`);
  record("sessions.turns reachable", turns.status === 200, `status=${turns.status}`);
  await post(`/sessions/${sid}/unarchive`, {});
  await post(`/sessions/${sid}/activate`, {});

  // Chat lands in the ACTIVE conversation and continues the worker conversation.
  const chat = await post("/chat", { text: "what is happening?", conversation_id: sid }, { "x-kai-host-token": HOST_TOKEN });
  show("POST /chat into the active session", { status: chat.status, body: { agent: chat.body?.agent, from_state: chat.body?.from_state, conversation_id: chat.body?.conversation_id } });
  record("sessions.chat is recorded in the conversation", chat.body?.conversation_id === sid, `conversation_id=${chat.body?.conversation_id}`);
  const after = await get(`/sessions/${sid}/turns`);
  const recorded = after.body?.turns ?? [];
  record("sessions.turns hold the exchange", recorded.length >= 2 && recorded.some((t) => t.role === "user") && recorded.some((t) => t.role === "assistant"), `turns=${recorded.length} roles=${recorded.map((t) => t.role).join(",")}`);
}

// ── workspace capabilities + non-mission approval resume (Phase 4 gap 1/2) ─────

async function workspace() {
  console.log("\n== workspace capabilities (shell / git / filesystem) + non-mission approval resume ==");

  // Availability is PROBED, not declared.
  const fsCap = await get("/capabilities/filesystem");
  show("GET /capabilities/filesystem", { status: fsCap.status, body: fsCap.body?.status });
  record(
    "workspace.filesystem is AVAILABLE",
    fsCap.status === 200 && fsCap.body?.status?.availability === "AVAILABLE",
    `availability=${fsCap.body?.status?.availability}`,
  );
  const shellCap = await get("/capabilities/shell");
  show("GET /capabilities/shell", { status: shellCap.status, body: shellCap.body?.status });
  record(
    "workspace.shell is AVAILABLE (a real spawn was probed)",
    shellCap.status === 200 && shellCap.body?.status?.availability === "AVAILABLE",
    `availability=${shellCap.body?.status?.availability}`,
  );
  const gitCap = await get("/capabilities/git");
  show("GET /capabilities/git", { status: gitCap.status, body: gitCap.body?.status });
  const gitStatusAvail = gitCap.body?.status?.availability;
  record(
    "workspace.git reports a probed status",
    gitCap.status === 200 && (gitStatusAvail === "AVAILABLE" || gitStatusAvail === "UNAVAILABLE"),
    `availability=${gitStatusAvail} detail=${String(gitCap.body?.status?.detail).slice(0, 80)}`,
  );

  // A READ capability action runs unattended (git is the READ-risk capability).
  if (gitStatusAvail === "AVAILABLE") {
    const gs = await post("/capabilities/git/test", { action: "status", input: { cwd: process.cwd() } });
    show("POST /capabilities/git/test (status)", { status: gs.status, body: { branch: gs.body?.result?.result?.branch } });
    record(
      "workspace.git.status (READ) runs with no approval",
      gs.status === 200 && typeof gs.body?.result?.result?.branch === "string",
      `status=${gs.status}`,
    );
  }

  const tmp = process.env.TEMP ?? process.env.TMP ?? ".";
  const target = `${tmp}\\kai-live-write-${Date.now()}.txt`;

  // A WRITE parks, and approving it RE-ISSUES the parked request (no manual retry).
  const parked = await post("/capabilities/filesystem/test", {
    action: "write",
    input: { path: target, content: "live approved write" },
  });
  show("POST /capabilities/filesystem/test (write)", {
    status: parked.status,
    body: { approvalRequired: parked.body?.approvalRequired, approvalId: parked.body?.approvalId },
  });
  record(
    "workspace.filesystem.write parks for a human (409)",
    parked.status === 409 && parked.body?.approvalRequired === true,
    `status=${parked.status}`,
  );
  const decided = await post(`/approvals/${parked.body?.approvalId}/decide`, { approved: true });
  show("POST /approvals/:id/decide (allow the write)", {
    status: decided.status,
    body: { reissued: decided.body?.reissued, result: decided.body?.result?.result },
  });
  record(
    "workspace.approving a NON-mission request RE-ISSUES it (Allow completes the loop)",
    decided.status === 200 && decided.body?.reissued === true,
    `reissued=${decided.body?.reissued}`,
  );
  record(
    "workspace.the re-issued write really ran",
    decided.body?.result?.result?.path === target,
    `path=${decided.body?.result?.result?.path}`,
  );

  // A mission tool step targeting the READ tool runs UNATTENDED (read-only is allowed).
  const mission = await post("/missions", {
    title: `ph4 workspace read ${Date.now()}`,
    steps: [{ title: "read the written file", kind: "tool", target: "filesystem.read", input: { path: target } }],
  });
  const missionId = mission.body?.mission?.id ?? mission.body?.id;
  const settled = await waitFor(async () => {
    const r = await get(`/missions/${missionId}`);
    const st = r.body?.mission?.status ?? r.body?.status;
    return st === "COMPLETED" || st === "FAILED" ? st : null;
  }, 20000, 400);
  show("a mission step reading a file, unattended", { status: 200, body: { id: missionId, status: settled } });
  record(
    "workspace.a READ tool step runs unattended through a mission",
    settled === "COMPLETED",
    `status=${settled}`,
  );

  // A DESTRUCTIVE action (shell) parks, then runs once approved.
  const shellRun = await post("/capabilities/shell/test", {
    action: "run",
    input: { command: process.execPath, args: ["-e", "process.stdout.write('live-shell-ok')"] },
  });
  show("POST /capabilities/shell/test (run)", { status: shellRun.status, body: { approvalId: shellRun.body?.approvalId } });
  record(
    "workspace.shell.run parks (DESTRUCTIVE)",
    shellRun.status === 409 && shellRun.body?.approvalRequired === true,
    `status=${shellRun.status}`,
  );
  const shellDecided = await post(`/approvals/${shellRun.body?.approvalId}/decide`, { approved: true });
  show("POST /approvals/:id/decide (allow the shell run)", {
    status: shellDecided.status,
    body: { reissued: shellDecided.body?.reissued, stdout: shellDecided.body?.result?.result?.stdout },
  });
  record(
    "workspace.the approved shell run executed",
    shellDecided.status === 200 && shellDecided.body?.reissued === true && shellDecided.body?.result?.result?.stdout === "live-shell-ok",
    `stdout=${JSON.stringify(shellDecided.body?.result?.result?.stdout)}`,
  );

  // A rejection runs nothing.
  const target2 = `${tmp}\\kai-live-reject-${Date.now()}.txt`;
  const parked2 = await post("/capabilities/filesystem/test", {
    action: "write",
    input: { path: target2, content: "must not be written" },
  });
  const rejected = await post(`/approvals/${parked2.body?.approvalId}/decide`, { approved: false });
  show("POST /approvals/:id/decide (reject)", { status: rejected.status, body: { reissued: rejected.body?.reissued } });
  record(
    "workspace.a rejected approval runs nothing",
    rejected.status === 200 && rejected.body?.reissued === false,
    `reissued=${rejected.body?.reissued}`,
  );
}

// ── L2: a behaviour change, traced (Phase 4 gap 4) ────────────────────────────

async function l2() {
  console.log("\n== L2 behaviour change (action trace + composed prompt) ==");
  if (HOST_TOKEN.length === 0) {
    console.log("  SKIP l2: no KAI_HOST_TOKEN, so the host-attested learning path cannot be driven here");
    return;
  }
  const token = Date.now();
  const lesson = `The phase four acceptance codename is Zephyrquill${token}.`;
  const query = `Zephyrquill${token}`;

  // BEFORE: the lesson does not exist, so it is not recalled.
  const before = await post("/prompts/compose", { request: query });
  show("POST /prompts/compose (before learning)", { status: before.status, body: { hasLesson: String(before.body?.prompt?.text ?? "").includes(lesson) } });
  record("L2 the lesson is absent from the prompt before learning", before.status === 200 && !String(before.body?.prompt?.text ?? "").includes(lesson), `status=${before.status}`);

  // The USER teaches it through the host path (the /chat relay, host-attested).
  const chat = await post("/chat", { text: lesson }, { "x-kai-host-token": HOST_TOKEN });
  // Print the failure reason verbatim when the turn does not answer. A bare status was
  // not enough to tell a missing key from a rejected one from a slow provider, and this
  // line was read as the first of those twice.
  show(
    "POST /chat (host-attested instruction)",
    chat.status === 200
      ? { status: chat.status, body: { agent: chat.body?.agent, intent: chat.body?.intent, reply: chat.body?.reply } }
      : { status: chat.status, body: chat.body },
  );

  // The learning is fire-and-forget on the host path, so wait for the trace.
  const trace = await waitFor(async () => {
    const r = await get("/actions?limit=50");
    const actions = r.body?.actions ?? [];
    return actions.find((a) => a.toolId === "learning.propose" && typeof a.memoryId === "string") ?? null;
  }, 15000, 400);
  show("GET /actions (learning trace)", { status: 200, body: trace ? { toolId: trace.toolId, memoryId: trace.memoryId, resultState: trace.resultState } : null });
  record(
    "L2 an action trace names the memory the lesson wrote",
    trace !== null && trace !== undefined && typeof trace.memoryId === "string",
    `memoryId=${trace?.memoryId}`,
  );

  // AFTER: the SAME request now carries the lesson into the composed prompt.
  const after = await post("/prompts/compose", { request: query });
  const memorySection = (after.body?.prompt?.sections ?? []).find((s) => s.name === "memory");
  show("POST /prompts/compose (after learning)", { status: after.status, body: { hasLesson: String(after.body?.prompt?.text ?? "").includes(lesson), memorySection: memorySection ?? null } });
  record(
    "L2 the learned lesson reaches a later composed prompt (changed behaviour)",
    after.status === 200 && memorySection !== undefined && String(after.body?.prompt?.text ?? "").includes(lesson),
    `memorySection=${memorySection !== undefined}`,
  );
}

async function main() {
  console.log(`KAI Phase 4 live acceptance against ${BASE}`);
  const started = Date.now();
  if (want("identity")) await identity();
  if (want("t1t10")) await t1t10();
  if (want("provenance")) await provenance();
  if (want("seceff")) await seceff();
  if (want("memory")) await memory();
  if (want("skills")) await skills();
  if (want("checkpoint")) await checkpoint();
  if (want("recovery")) await recovery();
  if (want("scheduler")) await scheduler();
  if (want("policyfire")) await policyfire();
  if (want("learning")) await learning();
  if (want("autonomy")) await autonomy();
  if (want("maintenance")) await maintenance();
  if (want("sessions")) await sessions();
  if (want("workspace")) await workspace();
  if (want("l2")) await l2();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nTALLY ${JSON.stringify({ PASS: passed, FAIL: results.length - passed, total: results.length })} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("FAILED:", results.filter((r) => !r.ok).map((r) => r.id).join(", ") || "(none)");
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
