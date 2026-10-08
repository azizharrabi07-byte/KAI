# Wiring skills + learning into KAI Core

This is the note the Core lead needs. Everything here is **additive**: two new
directories (`core/src/skills/**`, `core/src/learning/**`) and two test files
(`core/tests/skills.test.ts`, `core/tests/learning.test.ts`). Nothing under
`runtime.ts`, `api/routes.ts`, `server.ts`, `memory/**`, `prompts/**` or `app/**`
was touched — the lead owns those as single writer.

## The one-sentence contract

A skill is a directory-per-skill `SKILL.md`; the catalogue exposes **metadata
only**, the body loads on demand; and a learned skill can be **installed only
after a human approves the exact bytes**, which are bound by SHA-256 so the bytes
approved are the bytes installed.

## Files

| file | what it owns |
| --- | --- |
| `src/skills/validate.ts` | C1: the strict SKILL.md validator (pure, no I/O) |
| `src/skills/frontmatter.ts` | the YAML-subset frontmatter parser |
| `src/skills/render.ts` | draft → SKILL.md |
| `src/skills/hash.ts` | SHA-256 of the exact bytes |
| `src/skills/paths.ts` | containment (traversal + symlink/junction) and atomic writes |
| `src/skills/store.ts` | the filesystem store (immutable revisions, staging area, index) |
| `src/skills/registry.ts` | C2/C3: progressive disclosure + lifecycle |
| `src/skills/staging.ts` | C4: the staged → approved → installed pipeline |
| `src/skills/tools.ts` | optional READ-only tools (`skills.list/relevant/load`) |
| `src/learning/classify.ts` | C5/D: MEMORY \| SKILL \| NONE |
| `src/learning/pipeline.ts` | `proposeFromTurn` + `submit` + `learnFromTurn` |

## Wiring it (composition root)

```ts
import { createSkillStore, createSkillRegistry, createSkillStaging } from "./skills/index.ts";
import { createLearningPipeline } from "./learning/index.ts";

// 1. A root the Core owns (user data dir, not the repo). The store creates
//    `installed/`, `staging/` and `registry.json` beneath it.
const skillStore = createSkillStore({ root: join(userDataDir, "skills") });
const skills = createSkillRegistry({ store: skillStore });

// 2. Staging is where an install is prepared and bound to a hash. It MUST be
//    given the approval service: with none wired, installs fail closed.
const skillStaging = createSkillStaging({
  store: skillStore,
  approvals,              // the existing createApprovalService(...) instance
  // faults is a test-only crash-injection seam; omit in production.
});

// 3. Optional: expose the read-only surface to agents on the existing registry.
for (const tool of createSkillToolDefinitions(skills)) tools.register(tool);

// 4. The learning loop. memoryWriter closes over the existing memory service.
const learning = createLearningPipeline({
  staging: skillStaging,
  memoryWriter: (candidate) => memory.remember({ type: candidate.type, content: candidate.content }),
  // now / idFactory optional
});
```

## The exact-byte approval flow (C4) — the only way a learned skill installs

```ts
// a) A completed turn becomes a lesson; skills are STAGED, never installed.
const outcome = learning.learnFromTurn(event);
// outcome.decision === "skill"
//   outcome.skill = { staged: true, stagedId, sha256, skillId }

// b) Ask the human to approve THOSE bytes. The sha256 is written into the
//    approval reason and onto the staging record.
const requested = skillStaging.requestInstallApproval(outcome.skill.stagedId, outcome.skill.sha256);
// requested.value = { stagedId, sha256, approvalId }

// c) The human answers through the normal UI route (approvals.decide /
//    runtime.decideApproval). The UI should show `skillStaging.inspectStaged(stagedId)`,
//    which returns the full review (name/description/body) plus the hash.

// d) Install. Refused unless the staged bytes STILL hash to the approved sha256
//    AND the approval is APPROVED and bound to this staged skill and this tool id.
const installed = skillStaging.installApproved({
  stagedId: outcome.skill.stagedId,
  sha256:    outcome.skill.sha256,
  approvalId: requested.value.approvalId,
});
// installed.value = { skillId, revision, sha256, installedAt, approvedBy }
```

If the staged bytes were edited after approval, `installApproved` returns
`{ ok:false, error.detail: "HASH_MISMATCH" }` and installs nothing. If the
staging record expired (`DEFAULT_STAGE_TTL_MS`, 15 min) it returns
`"STALE_STAGE"`. With no approval service it returns `"NO_APPROVER"`.

## Why there is no `skills.install` tool

The tool registry's approval record is bound to a **toolId**, not to the bytes
it was granted for — `execute(input, ctx)` never receives the approval id. An
install exposed as a generic tool would therefore authorise *"some skill
install"*, not *"this revision"*. The install is exposed instead as the two
functions above, where the approval is bound to the SHA-256. This is a
deliberate weakening of the tool surface, not an omission.

## Reading skills (C2)

```ts
skills.list();                       // metadata only — never reads a body
skills.relevant("deploy the app");   // metadata for the skills worth loading
skills.load("deploy-app");           // the ONLY call that reads a body
skills.inspect("deploy-app");        // metadata + revision history
skills.disable("deploy-app");        // load refuses; relevant excludes it
skills.delete("deploy-app");
```

`register()` is create-only and refuses a duplicate id (matching the tool and
capability registries). Updates go through the approved pipeline, which appends
an **immutable** revision; `skillStaging.rollback(id)` moves the pointer back.

## What the lead must not do

- Do not install a skill from `proposeFromTurn` output directly. The only install
  path is `requestInstallApproval` → human approval → `installApproved`.
- Do not call `installApproved` without the `approvalId` the approval service
  issued for that staging.
- Do not wire `startup` to auto-approve anything.

## Refusal semantics (all as values, never throws)

`SkillResult<T>` is `{ok:true,value}` or `{ok:false,error,issues?}`. Rejections
report `VALIDATION_FAILED` with `issues[]` (codes: `PATH_TRAVERSAL`,
`INVALID_ID`, `OVERSIZED`, `ENCODED_PAYLOAD`, `INVISIBLE_UNICODE`,
`DOWNLOAD_EXEC`, `FRONTMATTER_*`, `MISSING_*`, `INVALID_NAME`, `INVALID_KEY`,
`EMPTY_BODY`, `TOO_MANY_TAGS`). Security refusals — symlink escape, integrity
mismatch, hash mismatch, stale stage, disabled skill — report `POLICY_DENIED`
with an exact `error.detail`. Approval problems report `APPROVAL_REQUIRED`.
