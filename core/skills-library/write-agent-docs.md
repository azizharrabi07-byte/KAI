---
name: write-agent-docs
description: Writes a project's agent docs from fixed templates, CLAUDE.md with the project's conventions, CONTEXT.md for domain terms and docs/adr/ with the decision format and a generated index, keeps recorded conventions, terms and decisions on re-runs and reports drift. Use when a project gets its agent docs for the first time, when CLAUDE.md or the ADR index drifted, or when docs from an older agent setup such as AGENTS.md or docs/agents/ are replaced.
---

Agents read `CLAUDE.md` first, look terms up in `CONTEXT.md` and find the reasons behind the code in `docs/adr/`. Other skills rely on these places: `design-spec` and `review-change` match terms against `CONTEXT.md`, and `review-architecture` reads the ADRs. So every project has them in the same place and shape. Conventions, terms and decisions belong to the project and are never invented: a convention nobody decided is a rule agents follow for no reason.

## 1. Check the inputs

Read `forge`, `default_branch`, `research`, `issues` and `ci.command` from `.claude/64x-lunicorn.yml`.

Stop and point to `setup-project` when the marker or one of these keys is missing.

**Done when** every input is valid or the run has stopped with the gap named.

## 2. Collect the project sections

For each `<<keep:…>>` placeholder in [the agent doc templates](references/templates.md):

- **Existing file in the template's shape:** take the content between the fixed parts around the placeholder, unchanged.
- **Existing file in another shape:** map its content to the matching sections and put everything else into `project_sections`, in its original order. Drop nothing.
- **Docs from an older agent setup**, `AGENTS.md` or `docs/agents/`: map what they record that is still true into the sections, and list each file for removal.
- **No content yet:** draft only `summary`, from what the repository shows. `conventions` and `terms` start as the template says and hold only what Daniel states or a document already records.

Show every drafted or remapped section, and the files listed for removal, together, and wait for Daniel's confirmation or edits.

**Done when** every project section has confirmed content or is confirmed as empty, and Daniel decided on every file listed for removal.

## 3. Generate and compare

Generate `CLAUDE.md`, `CONTEXT.md` and `docs/adr/README.md`, the last with its index built from the ADR files as the template says. ADR files themselves are never changed: a decision record is history, and a superseded one stays. An ADR file that does not match the format still gets its index row, with what can be read, and is reported.

Compare each generated file with what exists, byte for byte including the final newline, and report it as `new`, `unchanged` or `drift`. Show the diff of every `drift` file before writing it, then write every file that is `new` or `drift`. Remove the files Daniel confirmed for removal.

**Done when** every file is generated with its status, and every confirmed removal is done.

## 4. Check the result

Every relative link points to an existing file. A missing `docs/ci-cd.md` or `issues/README.md` is a gap of the skill that writes it, not a defect here. A failure in a fixed part is a defect in the template: stop and report it instead of patching the output.

**Done when** every link resolves or each failure is reported.

## 5. Report

- **Files:** each with `new`, `unchanged` or `drift`, and every removed file.
- **Project sections:** kept, drafted or remapped, per file.
- **ADRs:** the number indexed, and every file that does not match the format.
- **Gaps:** links to files other skills have not written yet, older agent docs Daniel kept, and the reason the run stopped, when it did.

Leave all file changes uncommitted, so Daniel reviews them before they are committed.

**Done when** the report covers files, project sections, ADRs and gaps.
