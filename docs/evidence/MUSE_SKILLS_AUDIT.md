# MuseAI-Skills audit — KAI adaptation review

> Source: https://github.com/win4r/MuseAI-Skills (unofficial Muse/Hatch snapshot). Method: `git clone --filter=blob:none --no-checkout`, sparse-checkout `opt/hatch/skills + home/hatch/docs + home/hatch/config` (+ `opt/hatch/runtime-cell` confs for permissions). Binaries avoided (`opt/hatch/bin`, `opt/hatch-image` never checked out; working tree ~2.2 MB / 249 files). KAI tree NOT modified; `C:\Users\DELL\Desktop\kai\core\skills-library` read-only listing only (256 entries = 255 skills + SOURCES.md). No skill file copied into kai.

## 0. Provenance / license warning (read first)
- Repo has **NO single clear license**: no root LICENSE/NOTICE, no per-skill LICENSE; frontmatter carries `name/description/metadata/icon` only (no `license/author`). Only license-ish file in skills scope: `booking/assets/airline-logos/NOTICE.md` (third-party logo attribution). README.en.md explicitly says snapshot is *partial, unofficial, provenance/product claims unverified*.
- Consequence: **do NOT byte-copy any SKILL.md into KAI**. KAI SOURCES.md only accepts MIT/Apache-2.0 redistributable content and already excludes no-license content. All Muse license/provenance below = **UNCLEAR** except where noted. Adaptation = clean-room reimplementation of *ideas*, never import of bytes.
- Symlink note: Windows checkout materialises symlinks as text files; targets resolved via file content + `git ls-tree -r` mode 120000 (see §1).

## 1. Exact counts
| Item | Count | Detail |
|---|---|---|
| SKILL.md paths (total) | 72 | `git ls-tree -r --name-only HEAD` filtered `opt/hatch/skills*SKILL.md` |
| Distinct real skill files | 68 | 72 − 4 symlink aliases |
| SKILL symlink aliases | 4 | `facebook/SKILL.md → ../facebook-cli/SKILL.md`; `meta-threads/SKILL.md → ../threads/SKILL.md`; `podcast/SKILL.md → ../generate_podcast/SKILL.md`; `voice-calls/SKILL.md → ../voice-selector/SKILL.md` |
| Manifest symlinks (extra) | 2 | `facebook/manifest.yaml → ../facebook-cli/manifest.yaml`; `meta-threads/manifest.yaml → ../threads/manifest.yaml` (total symlinks in skills scope = 6) |
| Top-level skill dirs | 68 | `opt/hatch/skills/*`; `spaces/` has NO SKILL.md (templates only); `artifacts/` holds 6 SKILL.md |
| manifest.yaml paths | 40 | 38 distinct real files + 2 aliases (37 skills with top-level manifest + 1 nested `generate_podcast/save-to-spotify/manifest.yaml`) |
| Skills with top-level manifest | 37 / 68 | connector/permission-gated skills (see §4) |
| eval files | 13 | 12 `eval/scenarios.yaml` (+`tracked-flight-scenarios.yaml` counts as duffel's one) + 1 `flightaware/eval/findings.md`; 12 eval dirs: booking, duffel, flightaware, gmail, google-calendar, google-contacts, google-drive, google-tasks, opentable, places-search, plaid, travel-planning |
| LICENSE/NOTICE in skills scope | 1 | `booking/assets/airline-logos/NOTICE.md` only; 0 per-skill LICENSE; 0 frontmatter license/author |
| KAI library | 255 skills + SOURCES.md (256 entries) | read-only listing 2026-10-07 |

## 2. Overlap verdict counts (68 distinct)
| Verdict | Count | Meaning |
|---|---|---|
| NEW | 50 | No KAI equivalent; adaptation-worthy idea |
| NONE | 7 | No overlap and no KAI value (Hatch-internal / static / empty) |
| OVERLAP-KEEP-KAI | 3 | Overlap; keep KAI version |
| OVERLAP-UPGRADE-KAI | 8 | Overlap; Muse idea upgrades KAI |

## 3. KAI-compatibility verdict counts (68 distinct)
- COMPATIBLE: 7
- NEEDS-ADAPTATION: 17
- REQUIRES-EXTERNAL: 36
- REJECT: 8

NONE list (7): device-data, muse-early-access, muse-feedback, muse_db, subscription-status, voice-selector, wearables-comms.
OVERLAP-KEEP-KAI (3): artifacts/markdown, granola, self-awareness + (see table; KAI keeps: write-readme/meeting-insights-analyzer/superself).
OVERLAP-UPGRADE-KAI (8): wide-research, skill-creator, artifacts/document, artifacts/pdf, artifacts/presentation, artifacts/spreadsheet, artifacts/testing, image-search.
REJECT (8): device-data (PII cache delete), muse-early-access + muse-feedback (Hatch-internal), muse_db (internal DB inspection), subscription-status (billing internals), plaid (banking credentials — UNCLEAR provenance, high risk), voice-selector (static catalog, no workflow) / wearables-comms (empty description, dynamic device code). REJECT = do not port even as idea without redesign; all other UNCLEAR-license skills = reimplement ideas only, never copy bytes.

## 4. Top 12 adaptation candidates (one line each)
1. `wide-research` — manager/worker JSON contract + coverage/failure reporting ports directly to KAI parallel research (upgrade perplexity-research/lead-research-assistant).
2. `skill-creator` — trim-to-core + references/-split + validation checklist upgrades KAI write-skill (drop scaffold-connector binary).
3. `artifacts/testing` — render-fresh visual gate + placeholder scan upgrades KAI artifacts-builder verification.
4. `artifacts/presentation` — per-slide HTML + theme plan + assembly pipeline for decks KAI lacks.
5. `artifacts/pdf` — workflow.md + render_audit + geometry validation pattern for fixed-layout PDFs.
6. `artifacts/spreadsheet` — formula-recalc + workbook-validation pattern for xlsx/csv.
7. `artifacts/document` — OOXML tracked-changes + LibreOffice render-back check for docx.
8. `goals` — creation/ vs guides/ split (never rerun intake) as KAI goal-workflow template (replace user_goal.* tools).
9. `forget` — plan→confirm→verify + artifact-inventory checklist as KAI memory-cleanup design (redesign rm + staged-claims bits).
10. `travel-planning` — planning-vs-booking ownership split + smallest-useful-brief intake as KAI trip-planning template.
11. `booking` (+places-search) — live-availability router + provider-handoff pattern; needs KAI tool replacements, no OAuth copy.
12. `gmail/manifest.yaml` (connector exemplar) — method-level permissions + quota + connect/scope-add flows as template for ANY future KAI connector (never copy credential mechanics).

## 5. Priority deep-dives
### 5.1 wide-research (COMPATIBLE / OVERLAP-UPGRADE-KAI)
- Dir: `opt/hatch/skills/wide-research/`; frontmatter name `wide_research`; no manifest/eval/refs (single 44-line file).
- Purpose: fan-out identical research task over many independent inputs with shared output schema.
- Triggers: 'wide/parallel research', high-volume lookup/screening; NOT single-item or dependent subtasks.
- Inputs: operation_brief (1 sentence), inputs[] (independent items), output_schema (minimal, typed), worker_prompt_template, completion_format (exact JSON). Outputs: {total, success_count, failure_count, results[], failures[], notes} + user-facing coverage report.
- Tools/deps: exactly one manager subagent → one worker per input; no binary/connector/MCP. Permissions: none.
- KAI: upgrade `perplexity-research`/`lead-research-assistant` with this contract; add dedupe-first, one-manager-only, retry-failed-once, reply-immediately rules.
### 5.2 skill-creator (COMPATIBLE / OVERLAP-UPGRADE-KAI)
- Dir `opt/hatch/skills/skill-creator/` + `references/authoring_guide.md`; name `skill_creator`; no manifest/eval.
- Purpose: author narrow, triggerable skills with operational core in SKILL.md and bulk in references/.
- Triggers: create/update workspace skill at `~/workspace/skills/<name>/`. Inputs: capability + trigger phrases + target path. Outputs: SKILL.md (frontmatter name+description; body Purpose/Tooling/Auth or Workflow/Output-Contract) + refs/assets/bin as needed.
- Tools: `scaffold-connector-skill --provider` (Hatch-only, DO NOT PORT), `python3 -m py_compile bin/*.py`. Permissions: none in skill; connector credentials via `credentials.request_api_access` sequence (external dep).
- KAI: port trim heuristics + Auth-its-own-section + preserve-working-commands rules to `write-skill`; ignore Hatch paths/auth flows.
### 5.3 artifacts/testing + family (COMPATIBLE/NEEDS-ADAPTATION / UPGRADE)
- Files: `artifacts/{document,markdown,pdf,presentation,spreadsheet,testing}/SKILL.md` + references/ (design-system, formulas, visual, workflow, editing, authoring). No manifests/evals (verification is tool-gated, not OAuth).
- testing purpose: gate every deliverable by *looking at fresh render*, never trusting generator; 3-strikes-then-ask rule. Gates: pdf `render_audit.mjs`+`validate_pdf.sh`; presentation `assemble_deck.mjs`+`render_audit.mjs`; docx LibreOffice→PDF→raster; xlsx `validate_xlsx.py`; csv/md parse-back; web `web_artifacts.build/audit`. Then eyes: overflow/collision/spacing/contrast/decoration + TODO/lorem/placeholder scan.
- Triggers: any build about to return a link / validation/QA/visual-check request. Inputs: artifact kind + path; outputs: pass/fail + PNG evidence + specific failure.
- Deps: `/opt/hatch/skills/artifacts/scripts/*`, LibreOffice, pdftoppm, muse.exec yield_ms — ALL Hatch-specific, replace with KAI equivalents. KAI: port the *doctrine* (render-fresh + placeholder scan + 3-attempt cap) into artifacts-builder/web-artifacts-builder; reimplement gates.
### 5.4 goals (COMPATIBLE / NEW)
- Dir `opt/hatch/skills/goals/` + `creation/<7 domains>.md` + `guides/<7>/scaffold.md`; name `goals`; no manifest/eval.
- Purpose: separate goal *intake* (creation/) from *ongoing support* (guides/). Triggers: create goal with no injected contract, or help with existing goal. Goals-tab turns carry injected contract — do NOT reread files.
- Inputs: category (career/health/interests/money/productivity/relationships/something_else) + user commitments; tools `user_goal.create/get/update` (Hatch-only). Outputs: goal record + progress/reflection discipline.
- KAI: port the split + 'never rerun creation choreography on existing goal' rule; replace user_goal.* with KAI memory/task tools.
### 5.5 forget (NEEDS-ADAPTATION / NEW)
- Dir `opt/hatch/skills/forget/` + `references/artifact-inventory.md`; name `forget`; no manifest/eval.
- Purpose: erase a fact/preference/relationship/topic/event from active memory AND stop copies/automations resurrecting it. Triggers: explicit 'forget that / don't remember / remove from memory' (NOT 'forget it' = cancel).
- Flow: `forget.plan {}` (read-only planner subagent, discreet handoff) → show scope+irreversible+limits → explicit confirmation only → `forget.confirm {}` executor (revalidate, stop owning work first, preserve unrelated, refresh derived, verify fresh). Writes `~/workspace/memory/forget/pending.json` {claims,citations} (ids/locators only). `rm -- <exact-path>` for exact files only (never rm -r/glob); report 'forgotten' only on fresh-verification clean.
- KAI: valuable checklist (copies, derived state, scheduled work, shared/published limits) but Hatch tools/paths + destructive rm + claim-retraction runtime are NOT portable; redesign with KAI-safe deletion + approval gates. Verdict NEEDS-ADAPTATION (not COMPATIBLE) for safety.
### 5.6 travel-planning (+booking) (COMPATIBLE/NEEDS-ADAPTATION / NEW)
- travel-planning: 342-line mandate + 5 refs + eval/scenarios.yaml; name `travel_planning`; no manifest. booking: SKILL + 6 refs + eval + airline-logo NOTICE; name `booking`; no manifest (routes to provider companions).
- Ownership split: Planning = structure/research/feasibility/logistics/checklist; Booking = live availability/prices/terms/transactions. Never select proposal via research; never treat price check as booking intent; honour 'finish planning first'. Modes: quick-booking (concrete item → load booking+provider, skip intake) vs travel-planning (open choice → intake). Side-chat offer via `chat.create` when available.
- Inputs: anchors, travelers/constraints, bases/dates/flex, budget semantics, pace/interests/exclusions, cabin/connection/stay/transport prefs + calendar/mail evidence (no private mining in shared chats). Outputs: decision-ready plan; booking handoff for live checks.
- KAI: port split + smallest-useful-brief + planning-kickoff + fact-verification refs; replace chat.*/booking provider CLIs with KAI tools. booking eval scenarios useful as test design.
### 5.7 magic-moment (NEEDS-ADAPTATION / NEW)
- Dir `opt/hatch/skills/magic-moment/` + guide/* (6) + reference/* + design-system HTML kit + INSTALL.md; name `magic-moment`; no manifest/eval.
- Purpose: turn talking-head footage into vertical shareable Muse-story clip (narration preserved; artifacts/exchanges synced; bubbles/typing/emoji/widgets/message-sounds/lockup finisher). Triggers: 'make a magic moment / turn this video of me into… / add chat over my video'.
- Pipeline: story_and_canon (transcribe+fact-sheet) → conversation_shape → visuals → screenplay+timeline → screenplay_review GATE → render. Tools: `./mm transcribe|validate|preview|render|inspect|publish|webshots|snap|avatar|example` (Hatch-only) + kit HTML as markup source-of-truth. Inputs: source clip + real VM work; outputs: vertical video + review sign-off.
- KAI: port guide-order + review-gate + component-index idea; replace mm/browser-capture/renderer with KAI media chain (see remotion-video). Heavy adaptation.
### 5.8 gmail + connector skills as a class (REQUIRES-EXTERNAL / NEW)
- Exemplar gmail: SKILL (122 lines) + manifest.yaml (282 lines: connector=gmail, quota 6000 u/min, method_units per Gmail method, workers hatch-gws-cli-fully-isolated) + eval/scenarios.yaml. Pattern: `hatch_gws_cli gmail <cmd>` (+shortcuts +raw dotted-method + --params/--json), status/connect_url/add_account_url/disconnect flows, scope-add flow (`status --for-command`), sequential-only rate discipline + cost guide, plain-English replies (no cmds/ids/JSON to user), send-needs-exact-text approval.
- Class: 37 skills carry manifest.yaml with `connector, display_name, request_quota(workers=*-cli), actions{read:allow/write:ask + methods + approval_phrase}, consent_screen`. Workers map to `/opt/hatch/bin/*` CLIs (hatch_gws_cli, notion-cli, granola-cli, instagram-cli, threads-cli, plaid, withings, tessie-api, etc.) or MCP (notion, granola). Docs: `home/hatch/docs/connectors.md`, `privacy-and-credentials.md`, `channel-availability.md`; config `home/hatch/config/skills.yaml` (available flags); gates `runtime-cell/skill-scopes.conf`, `bin-scopes.conf` (channel reveal, fail-closed).
- KAI: NO OAuth connectors/MCP equivalents — every connector skill = REQUIRES-EXTERNAL. Do not copy credential mechanics, connect URLs, quota bypasses, or raw bulk scopes. Reusable: manifest *shape* (method-level permissions + approval phrases + quota) as design template; eval scenarios.yaml as test-design pattern; plain-English reply discipline.
- Sensitive subclass (handle with extra care): plaid (banking), function-health/healthex (labs/meds), apple-healthkit/google-health-connect/withings (PII health), device-data (cached contacts/calendar + local delete), messenger/instagram-messages/threads-messages (DMs), tailscale (VPN/tunnel), tessie (vehicle commands), philips-hue (home control). All UNCLEAR provenance → REJECT byte-copy; ideas only with KAI auth + HITL redesign.

## 6. Full per-skill table (68 distinct; aliases in §7)
| # | Directory | Frontmatter name | Purpose (1 line) | Trigger | Inputs → Outputs | Tools referenced | Permissions (manifest) | Deps (connector/MCP/binary) | Refs / bundled | Manifest | Eval | License | KAI | Overlap |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `opt/hatch/skills/apple-healthkit` | `apple_healthkit` | The user's synced Apple Health (HealthKit) data: daily metrics (steps, distance, calories, heart rate, HRV, VO… | health metrics question | account → readings | healthkit-cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 2 | `opt/hatch/skills/artifacts/document` | `artifact_document` | Create, read, edit, or manipulate Word documents (.docx) and Word templates (.dotx). Use whenever a build task… | build kind=document/docx request | brief → .docx | soffice/pdftoppm scripts | — | — | 2 files | — | — | UNCLEAR | NEEDS-ADAPTATION | OVERLAP-UPGRADE-KAI |
| 3 | `opt/hatch/skills/artifacts/markdown` | `artifact_markdown` | Build or revise a plain markdown file (md) deliverable such as notes, a README, meeting minutes, documentation… | md/README/notes request | brief → .md | none | — | — | — | — | — | UNCLEAR | COMPATIBLE | OVERLAP-KEEP-KAI |
| 4 | `opt/hatch/skills/artifacts/pdf` | `artifact_pdf` | Build, revise, or manipulate a fixed-layout PDF (report, guide, one-pager, printable document). Use whenever a… | kind=pdf / fixed-layout request | brief → .pdf | render_audit/validate_pdf | — | — | 3 files | — | — | UNCLEAR | NEEDS-ADAPTATION | OVERLAP-UPGRADE-KAI |
| 5 | `opt/hatch/skills/artifacts/presentation` | `artifact_presentation` | Build or revise a slide deck (pptx by default; pdf or html on request). Use whenever a build task's artifact k… | deck/slides request | outline → .pptx | assemble_deck/render_audit | — | — | 7 files | — | — | UNCLEAR | NEEDS-ADAPTATION | OVERLAP-UPGRADE-KAI |
| 6 | `opt/hatch/skills/artifacts/spreadsheet` | `artifact_spreadsheet` | Create, read, edit, fix, or clean spreadsheet files (.xlsx, .xlsm, .csv, .tsv). Use whenever a build task's ar… | xlsx/csv task | data → workbook | validate_xlsx.py | — | — | 2 files | — | — | UNCLEAR | NEEDS-ADAPTATION | OVERLAP-UPGRADE-KAI |
| 7 | `opt/hatch/skills/artifacts/testing` | `artifact_testing` | Verify an artifact before delivering it - file deliverables (pdf, pptx, docx, xlsx, csv) and web artifacts ali… | pre-delivery validation/QA | artifact → pass/fail+PNG | render_audit/gates | — | — | — | — | — | UNCLEAR | COMPATIBLE | OVERLAP-UPGRADE-KAI |
| 8 | `opt/hatch/skills/booking` | `booking` | Primary entry point for direct flight, hotel, restaurant, or event-ticket transactions and for bounded live av… | bounded availability/booking | item+bounds → options/booking | provider companions/browser | — | — | 8 files | — | scenarios.yaml | UNCLEAR (NOTICE.md covers logos only) | NEEDS-ADAPTATION | NEW |
| 9 | `opt/hatch/skills/calendly` | `calendly` | View Calendly events and event types, and manage scheduling data using the Calendly CLI. | calendly scheduling q | — → events/types | calendly CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 10 | `opt/hatch/skills/device-data` | `device_data` | Read cached contacts and calendar events from Muse storage. Delete Muse's local copy of either source without … | cached contacts/calendar read | request → cached rows | Muse storage | — | Hatch-internal | — | — | — | UNCLEAR | REJECT | NONE |
| 11 | `opt/hatch/skills/duffel` | `duffel` | Use Duffel to search, book, pay for, or manage flights. Use Duffel to monitor an already booked flight's fare … | flight search/book/manage | route/dates → offer/order | duffel CLI | manifest allow/ask | connector/CLI | — | Y | tracked-flight-scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 12 | `opt/hatch/skills/facebook-cli` | `facebook_cli` | Use when the user provides a Facebook URL or asks to read personal posts, comments, reactions, friends, timeli… | FB URL / read/Marketplace | url/query → posts/context | facebook-cli | manifest allow/ask | connector/CLI | 12 files | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 13 | `opt/hatch/skills/flightaware` | `flightaware` | Use for questions about a specific flight’s departure or arrival time, including “when’s my flight?” and confi… | specific flight time/status | flight+date → schedule/status | flightaware CLI | manifest allow/ask | connector/CLI | — | Y | findings.md,scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 14 | `opt/hatch/skills/forget` | `forget` | Remove a personal fact, preference, relationship detail, topic, or prior event from Muse's active memory and s… | explicit 'forget that' | subject → verified cleanup | forget.plan/confirm | — | Hatch-internal | 1 files | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 15 | `opt/hatch/skills/function-health` | `function_health` | Retrieve lab biomarker results and clinician notes from Function Health. | lab/biomarker q | — → labs/notes | function-health CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 16 | `opt/hatch/skills/generate_podcast` | `generate_podcast` | Compose and deliver audio content: a podcast episode, briefing, or narrated summary, with one or more voices, … | podcast/briefing audio | script → .mp3 | tts/save-to-spotify | — | — | 3 files | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 17 | `opt/hatch/skills/gmail` | `gmail` | Work with the user's Gmail: search, read threads, draft, send, reply, forward, unsubscribe from mailing lists,… | gmail triage/read/send | query/id → mail/action | hatch_gws_cli gmail | manifest allow/ask | connector/CLI | — | Y | scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 18 | `opt/hatch/skills/goals` | `goals` | Guidance for helping users create and accomplish goals. Read it before you create a goal for the user when no … | create/help goal | category → record/progress | user_goal.* | — | Hatch-internal | 14 files | — | — | UNCLEAR | COMPATIBLE | NEW |
| 19 | `opt/hatch/skills/google-calendar` | `google_calendar` | Work with the user's Google Calendar: agenda views, event details, and scheduling changes. | gcal agenda/change | — → events | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 20 | `opt/hatch/skills/google-contacts` | `google_contacts` | Search, view, create, update, and delete the user's Google Contacts. | gcontacts CRUD | query → contacts | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 21 | `opt/hatch/skills/google-docs` | `google_docs` | Read, create, and edit the user's Google Docs. | gdocs read/edit | id → doc | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 22 | `opt/hatch/skills/google-drive` | `google_drive` | Work with the user's Google Drive: files, folders, uploads, downloads, and sharing. | gdrive files/share | path → files | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 23 | `opt/hatch/skills/google-forms` | `google_forms` | Read, create, and update the user's Google Forms, and read responses. | forms/responses | id → form | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 24 | `opt/hatch/skills/google-health-connect` | `google_health_connect` | The user's synced Google Health Connect data from their Android device: daily metrics (steps, distance, calori… | android health q | — → metrics | health CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 25 | `opt/hatch/skills/google-sheets` | `google_sheets` | Read, write, and manage the user's Google Sheets. | sheets read/write | range → values | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 26 | `opt/hatch/skills/google-slides` | `google_slides` | Read, create, and edit the user's Google Slides presentations. | slides read/edit | id → deck | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 27 | `opt/hatch/skills/google-tasks` | `google_tasks` | Manage the user's Google Tasks: lists, task details, creation, updates, and completion. | tasks manage | list → tasks | hatch_gws_cli | manifest allow/ask | connector/CLI | — | Y | scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 28 | `opt/hatch/skills/granola` | `granola` | Search and read Granola meeting notes and transcripts through Granola's OAuth-backed MCP server. | meeting notes q | query → notes | granola-cli/MCP | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | OVERLAP-KEEP-KAI |
| 29 | `opt/hatch/skills/healthex` | `healthex` | Use to connect HealthEx and ask questions about your medications, lab results, and other health records. | meds/labs q | — → records | healthex CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 30 | `opt/hatch/skills/image-search` | `image_search` | Search the web by text query for image URLs and source pages for feeds, artifacts, and visual references. Does… | need image URLs | query → urls+pages | image-search bin | — | — | — | — | — | UNCLEAR | NEEDS-ADAPTATION | OVERLAP-UPGRADE-KAI |
| 31 | `opt/hatch/skills/instagram` | `instagram` | Answer questions about Instagram posts and reels, including links the user shares, using post context, media d… | IG posts/profiles | url → context | instagram-cli | manifest allow/ask | connector/CLI | 1 files | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 32 | `opt/hatch/skills/instagram-messages` | `instagram_messages` | Use this to interact with the user's Instagram messages. Read inboxes, threads, top recipients, filtered inbox… | IG DMs | inbox → messages | instagram-messages-cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 33 | `opt/hatch/skills/magic-moment` | `magic-moment` | Make a "magic moment" video — turn a creator's talking-head recording into a vertical video preserving the sou… | talking-head → clip | clip → vertical video | ./mm + kit | — | — | 13 files | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 34 | `opt/hatch/skills/media-library` | `media_library` | Search and inspect the user's photo library, including connected device galleries. Use for photo requests and … | photo request | query → photos | media-library bin | — | — | — | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 35 | `opt/hatch/skills/messenger` | `messenger_read` | Work with the user's Messenger account: read call history; read and search contacts; read, search, and summari… | messenger read/send | — → threads | messenger CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 36 | `opt/hatch/skills/muse-early-access` | `muse_early_access` | Use for questions about Muse's general early access program, requests to join it, checking or withdrawing a jo… | early-access q | — → status | internal | — | Hatch-internal | — | — | — | UNCLEAR | REJECT | NONE |
| 37 | `opt/hatch/skills/muse-feedback` | `muse-feedback` | Use for feedback and feature requests to the Muse team. Whenever your response tells the user you can't do a s… | feedback/feature req | report → ticket | internal | — | — | — | — | — | UNCLEAR | REJECT | NONE |
| 38 | `opt/hatch/skills/muse-mail` | `muse_mail` | Manage Muse Mail. Use this skill for Muse Mail, mail forwarded to the mailbox, or the main agent's name plus m… | Muse Mail ops | mailbox → action | muse-mail bin | — | — | 1 files | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 39 | `opt/hatch/skills/muse_db` | `muse_db` | Inspect database-backed Muse records for diagnosis and cross-table tracing when purpose-built product tools do… | diagnose records | question → rows | muse_db RO queries | — | Hatch-internal | 1 files | — | — | UNCLEAR | REJECT | NONE |
| 40 | `opt/hatch/skills/notion` | `notion` | Search, read, create, and update Notion pages via the Notion MCP. | notion CRUD | query → pages | notion-cli/MCP | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 41 | `opt/hatch/skills/opentable` | `opentable` | Find restaurants on OpenTable, check availability, and make, change, or cancel reservations. Use for restauran… | restaurant booking | party/time → reservation | opentable CLI | manifest allow/ask | connector/CLI | — | Y | scenarios.yaml | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 42 | `opt/hatch/skills/outlook-calendar` | `outlook_calendar` | View, create, update, and delete events in the user's Outlook Calendar. | outlook events | — → events | outlook-* CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 43 | `opt/hatch/skills/outlook-contacts` | `outlook_contacts` | List, search, create, update, and delete contacts in the user's Outlook account. | outlook contacts | query → contacts | outlook-* CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 44 | `opt/hatch/skills/outlook-mail` | `outlook_mail` | Read, search, send, reply to, and delete messages in the user's Outlook Mail. | outlook mail | query → mail | outlook-* CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 45 | `opt/hatch/skills/peloton` | `peloton` | Connect to Peloton to browse fitness classes, check schedules, and book workouts. | classes/schedule | — → classes | peloton CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 46 | `opt/hatch/skills/philips-hue` | `philips_hue` | Control Philips Hue smart lights, rooms, scenes, and devices via the Hue Remote API v2. | lights/scenes | room → state | philips-hue CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 47 | `opt/hatch/skills/places-search` | `places_search` | Find, compare, and share details on physical places near the user or in a specified area, including restaurant… | places near X | area → venues | places/local-search | — | — | — | — | scenarios.yaml | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 48 | `opt/hatch/skills/plaid` | `plaid` | Use to connect Plaid and read linked financial accounts: metadata, balances, transactions, recurring transacti… | bank accounts/txns | — → accounts | plaid CLI | manifest allow/ask | connector/CLI | — | Y | scenarios.yaml | UNCLEAR | REJECT | NEW |
| 49 | `opt/hatch/skills/printify` | `printify` | Use Printify to browse catalog data, manage shops and products, and review or create orders. | catalog/products/orders | query → items | printify CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 50 | `opt/hatch/skills/self-awareness` | `self_awareness` | Ground self-referential answers in the agent's actual filesystem. Use when the user asks who the agent is, wha… | who/what can you do | question → grounded answer | filesystem refs | — | — | 2 files | — | — | UNCLEAR | COMPATIBLE | OVERLAP-KEEP-KAI |
| 51 | `opt/hatch/skills/share-ideas` | `share_ideas` | Publish a reusable native Muse Idea with idea.share when the user explicitly asks to share or publish an Idea … | explicit share Idea | idea → link | idea.share | — | — | — | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 52 | `opt/hatch/skills/shopping` | `shopping` | Use for any product or shopping question: find, reverse image search, shopping Instagram/Marketplace links, bu… | product/shopping q | query → products/prices | shop backends/browser | — | — | 3 files | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 53 | `opt/hatch/skills/skill-creator` | `skill_creator` | Create or update a workspace skill: its description, structure, instructions, and supporting files. | create/update skill | capability → SKILL.md | scaffold-connector/py_compile | — | — | 1 files | — | — | UNCLEAR | COMPATIBLE | OVERLAP-UPGRADE-KAI |
| 54 | `opt/hatch/skills/spotify` | `spotify` | Discover, search, and manage Spotify music, podcasts, and playlists, including deleting shows or episodes you … | music/playlists | query → tracks | spotify-api/save-to-spotify | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 55 | `opt/hatch/skills/subscription-status` | `subscription_status` | Answer questions about the user's Muse subscription, account or plan, current tier, usage, credits, remaining … | plan/usage/billing q | — → status | internal | — | Hatch-internal | — | — | — | UNCLEAR | REJECT | NONE |
| 56 | `opt/hatch/skills/tailscale` | `tailscale` | Set up Muse's built-in Tailscale connector, join a tailnet or Headscale network, check status, and reach priva… | tailnet/VPN/private host | network → tunnel | tailscale bin | — | — | — | — | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 57 | `opt/hatch/skills/tessie` | `tessie` | Monitor a Tesla vehicle, inspect live state, and run explicit Tessie command endpoints. | tesla state/command | vin → state/action | tessie-api | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 58 | `opt/hatch/skills/threads` | `threads` | Read and manage the user's Threads account: profile, posts, feed, saved posts, activity, insights, social grap… | threads posts/feed | url → posts | threads-cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 59 | `opt/hatch/skills/threads-messages` | `threads_messages` | Use this to interact with the user's Threads messages: read inboxes and message threads, and send messages thr… | threads DMs | inbox → messages | threads-messages-cli | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 60 | `opt/hatch/skills/ticketmaster` | `ticketmaster` | Search Ticketmaster events and seats with pricing. Returns Buy-now links to Ticketmaster checkout; it cannot c… | events/seats/prices | query → links | ticketmaster CLI | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |
| 61 | `opt/hatch/skills/travel-planning` | `travel_planning` | Use this skill when an active or proposed trip needs planning, logistics, feasibility, entry or transit checks… | trip planning/logistics | idea → plan | booking handoff/refs | — | — | 5 files | — | scenarios.yaml | UNCLEAR | COMPATIBLE | NEW |
| 62 | `opt/hatch/skills/tts` | `tts` | Turn supplied text into spoken audio, single or multi-speaker. For composed audio content (a podcast, briefing… | read text aloud | text → audio | tts bin | manifest allow/ask | connector/CLI | — | Y | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 63 | `opt/hatch/skills/voice-design` | `voice_design` | Choose or design a new speaking voice when the user asks for a new, different, custom, invented, or generated … | new/custom voice | brief → voice | voice tools | — | — | — | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 64 | `opt/hatch/skills/voice-selector` | `voice_selector` | Provides the static system voice catalog used by Jarvis. It does not define a user-facing workflow. | voice catalog | — → catalog | static | — | — | — | — | — | UNCLEAR | REJECT | NONE |
| 65 | `opt/hatch/skills/wearable-device-skills` | `wearable_device_skills` | Use when the user asks to discover, inspect, or invoke an agentic capability dynamically published by a paired… | invoke wearable skill | request → action | paired device | — | — | — | — | — | UNCLEAR | NEEDS-ADAPTATION | NEW |
| 66 | `opt/hatch/skills/wearables-comms` | `wearables_comms` | >- | (empty desc) | — | native comms | — | — | — | — | — | UNCLEAR | REJECT | NONE |
| 67 | `opt/hatch/skills/wide-research` | `wide_research` | Use when the user needs broad parallel research across many independent inputs with a shared output schema. | broad parallel research | inputs+schema → results | manager subagent | — | — | — | — | — | UNCLEAR | COMPATIBLE | OVERLAP-UPGRADE-KAI |
| 68 | `opt/hatch/skills/withings` | `withings` | Use when linking Withings or reading Withings body measurements, activity, sleep, workout, heart, and intraday… | withings link/read | — → body/sleep/heart | withings CLI | manifest allow/ask | connector/CLI | 1 files | Y | — | UNCLEAR | REQUIRES-EXTERNAL | NEW |

## 7. Aliases (4 SKILL + 2 manifest)
| Alias path | Target | Notes |
|---|---|---|
| `opt/hatch/skills/facebook/SKILL.md` | `../facebook-cli/SKILL.md` | same frontmatter `facebook_cli`; manifest alias too |
| `opt/hatch/skills/facebook/manifest.yaml` | `../facebook-cli/manifest.yaml` | connector perms identical |
| `opt/hatch/skills/meta-threads/SKILL.md` | `../threads/SKILL.md` | frontmatter `threads` |
| `opt/hatch/skills/meta-threads/manifest.yaml` | `../threads/manifest.yaml` | identical |
| `opt/hatch/skills/podcast/SKILL.md` | `../generate_podcast/SKILL.md` | frontmatter `generate_podcast` |
| `opt/hatch/skills/voice-calls/SKILL.md` | `../voice-selector/SKILL.md` | frontmatter `voice_selector` (static catalog) |

## 8. Manifests / evals / licenses inventory
- 40 manifest.yaml paths (§1). Shape: `version/connector/display_name/request_quota(workers, units/queries per min)/actions{read/write.methods+approval_phrase}/consent_screen`. Workers = extension CLIs carved by `runtime-cell/bin-scopes.conf` per channel (fail-closed). Skills axis gated by `skill-scopes.conf` + `home/hatch/config/skills.yaml` (available flags).
- 13 eval files / 12 dirs (§1): `scenarios.yaml` per skill + flightaware `findings.md`. Pattern worth reusing: bounded scenarios with expected tool + scope; travel/booking/places/plaid/gmail/gcal/gcontacts/gdrive/gtasks/opentable suites are test-design exemplars.
- Licenses: no repo LICENSE; no per-skill LICENSE; no frontmatter license/author; single `booking/assets/airline-logos/NOTICE.md`. PROJECT_ANALYSIS/SHA256SUMS/README do not grant rights. Mark every skill UNCLEAR.
- Docs read: `home/hatch/docs/{artifacts,connectors,goals,privacy-and-credentials,channel-availability,muse}.md` + `PROACTIVE_PREFERENCES.md` + `config/skills.yaml` + `runtime-cell/{skill,bin}-scopes.conf` (permissions model).

## 9. KAI overlap notes (why these verdicts)
- KAI is dev-centric (255 curated MIT/Apache skills); Muse is consumer-connector-centric (OAuth/MCP/CLIs). Hence 49 NEW + 7 NONE = 56 skills with no useful KAI counterpart.
- KEEP-KAI (4): `artifacts/markdown` (KAI write-readme/write-like-me cover it), `granola` (KAI meeting-insights-analyzer is provider-neutral), `self-awareness` (KAI superself covers identity grounding), plus markdown-adjacent doc flows — keep KAI, borrow nothing byte-wise.
- UPGRADE-KAI (8): listed in §3; each adds a portable *doctrine* (contracts, gates, trim rules, visual-search) missing from the KAI counterpart.
- Connector class: KAI has `mcp-integration/mcp-builder/protect-mcp-setup` (generic) but zero provider connectors; Muse manifests are the first method-level permission+quota reference — adopt the *shape*, never the bytes/credentials.

## 10. Safety / adaptation rules
1. Never `cp` SKILL.md/manifest/eval into kai; never add Muse bytes to `core/skills-library` (would violate KAI SOURCES licensing gate).
2. Reimplement ideas clean-room with KAI tool names/paths; replace `/opt/hatch/*`, `~/workspace/*`, `hatch_*_cli`, `user_goal.*`, `forget.*`, `muse.*`, `./mm`, `chat.create` with KAI equivalents or omit.
3. Destructive/sensitive patterns (forget rm, device-data delete, muse_db RO→? , plaid/health reads, tailscale tunnel, tessie commands, hue control) require KAI HITL + scoped-permission redesign + explicit approval phrases; default-deny otherwise.
4. If a future KAI connector is built, copy the *manifest discipline* (per-method allow/ask + quota + consent bullets + plain-English replies + send-needs-exact-text) — not endpoints or OAuth flows.

## 11. Suggested KAI work order
1. wide-research contract → lead-research-assistant/perplexity-research upgrade. 2. skill-creator trim rules → write-skill upgrade. 3. artifacts/testing doctrine → artifacts-builder/web-artifacts-builder upgrade. 4-6. presentation/pdf/spreadsheet/document gates (new KAI recipes). 7. goals split (new workflow). 8. forget checklist (redesigned). 9. travel/booking split (new). 10. gmail-manifest shape (future-connector template). 11. magic-moment pipeline (only if KAI media chain exists). 12. Leave all REQUIRES-EXTERNAL connectors + REJECT internals alone until KAI has auth/MCP story.

---
Method evidence: clone `38bbb45` (main), `git ls-tree` counts, `skills-extract.json` (auto parse of 72 frontmatters + manifests + eval/refs), sampled full reads (wide-research, skill-creator, artifacts/testing, goals, forget, travel-planning 1-100, gmail 1-120 + manifest heads, magic-moment 1-80, README.en.md 1-120, SOURCES.md). KAI listing read-only; kai tree unmodified; no skill file copied into kai.
