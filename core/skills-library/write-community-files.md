---
name: write-community-files
description: Writes a project's community files from fixed templates on GitHub, GitLab, Forgejo or without a forge, the pull or merge request template, CODEOWNERS, SECURITY.md, CONTRIBUTING.md and LICENSE, keeps the project's own sections on re-runs and reports drift. Use when a project gets its community files for the first time, when they drifted from the house templates, or when the license, the code owners or the CI checks changed.
---

Contributors find the same files in the same shape in every project: how to report a vulnerability, how to contribute, who owns which path, under which license. Fixed parts come from templates. Project sections are drafted once, confirmed by Daniel and kept word for word, so a re-run with the same inputs gives the same files.

## 1. Check the inputs

Read `forge`, `default_branch`, `issues` and `ci` from `.claude/64x-lunicorn.yml`. The caller passes the license key, the copyright year and holder, and on GitHub and Forgejo the code owner and the critical paths.

Stop and name the gap when:

- The marker or one of these keys is missing. Point to `setup-project`.
- The license key is not in [the license templates](references/licenses.md).

A critical path that matches nothing in the repository goes to Daniel: CODEOWNERS silently ignores it, so either the path is wrong or the file does not exist yet.

**Done when** every input is valid or the run has stopped with the gap named.

## 2. Collect the project sections

For each `<<keep:…>>` placeholder in the templates for the forge, [GitHub](references/github.md), [GitLab](references/gitlab.md), [Forgejo](references/forgejo.md) or [no forge](references/no-forge.md):

- **Existing file in the template's shape:** take the content between the fixed parts around the placeholder, unchanged.
- **Existing file in another shape:** map its content to the matching sections and put everything else into `project_sections`, in its original order. Drop nothing.
- **No content yet:** draft it from what the repository shows, as the template's section table says.

Show every drafted or remapped section together and wait for Daniel's confirmation or edits.

**Done when** every project section has confirmed content or is confirmed as empty.

## 3. Generate and compare

- **GitHub:** `.github/pull_request_template.md`, `.github/CODEOWNERS`, `SECURITY.md` and `CONTRIBUTING.md`.
- **GitLab:** `.gitlab/merge_request_templates/Default.md`, `SECURITY.md` and `CONTRIBUTING.md`. No CODEOWNERS: code owners need GitLab Premium, and a file that does nothing suggests a review nobody gets.
- **Forgejo:** `.forgejo/pull_request_template.md`, `.forgejo/CODEOWNERS`, `SECURITY.md` and `CONTRIBUTING.md`.
- **No forge:** `SECURITY.md` and `CONTRIBUTING.md`. A request template and CODEOWNERS have nothing to act on without a forge.
- **All:** the license file, as the license templates say. An existing license file with another license is reported and left untouched: changing a project's license is a legal decision.

Compare each generated file with what exists, byte for byte including the final newline, and report it as `new`, `unchanged` or `drift`. Show the diff of every `drift` file before writing it, then write every file that is `new` or `drift`.

Report every other file that does the same job by name, such as a CODEOWNERS at the root or in `docs/`, or a second request template, and remove it only after Daniel confirms. A forge uses one CODEOWNERS file, so a second one silently decides nothing or everything.

**Done when** every file is generated with its status and every duplicate is reported.

## 4. Check the result

- Every relative link points to an existing file. A missing `CLAUDE.md`, `docs/ci-cd.md` or `issues/README.md` is a gap of the skill that writes it, not a defect here.
- Every non-comment line of CODEOWNERS is a rule followed by the owner. On Forgejo each rule is a regular expression that compiles.

A failure in a fixed part is a defect in the template: stop and report it instead of patching the output. A failure in a project section goes to Daniel with its line.

**Done when** every check passes or each failure is reported.

## 5. Private vulnerability reporting

GitHub only. `SECURITY.md` sends reporters to the private advisory form, which exists only while private vulnerability reporting is enabled. The repository is the `origin` remote on `github.com`; without one, report the setting as a gap. GitLab needs nothing here, because confidential issues are available on every tier; Forgejo has no private reporting at all.

Read it with `gh api repos/<owner>/<repo>/private-vulnerability-reporting --jq .enabled`. When it is `false`, ask Daniel: "Enable private vulnerability reporting for <owner>/<repo>?" Only a yes counts. Apply with `gh api -X PUT repos/<owner>/<repo>/private-vulnerability-reporting`, then read it back.

**Done when** the setting reads `true`, or Daniel declined, or the missing remote is recorded as a gap, or the forge is not GitHub.

## 6. Report

- **Files:** each with `new`, `unchanged` or `drift`, a license file left untouched with its license, and duplicates found.
- **Project sections:** kept, drafted or remapped, per file.
- **Checks:** passed, or each failure with its line.
- **Remote settings:** private vulnerability reporting enabled, already on, declined or not applied for lack of a remote.
- **Gaps:** links to files other skills have not written yet, the reason the run stopped, when it did, and per forge: on GitLab, no CODEOWNERS; on Forgejo, no private vulnerability reporting.

Leave all file changes uncommitted, so Daniel reviews them before they are committed.

**Done when** the report covers files, project sections, checks, remote settings and gaps.
