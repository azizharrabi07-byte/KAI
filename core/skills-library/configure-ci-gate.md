---
name: configure-ci-gate
description: Configures a project's CI gate from the checks in .claude/64x-lunicorn.yml on GitHub, GitLab or Forgejo, generating the pipeline with Secret scan, Workflow lint where the forge supports it and the single required CI gate, the branch protection, merge settings and repo metadata, or local git hooks without a forge, and reports drift. Use when a project's gate is set up for the first time, re-run after its checks changed, or brought back in line after it drifted.
---

Brings one project to the house gate: one list of checks, one local command, one required check named `CI gate`. The same marker must always produce the same files, so everything comes from fixed templates with placeholders, and nothing is written from memory. Each forge gets every rule it can enforce, and every rule it cannot is named as a gap.

## 1. Check the inputs

Read `.claude/64x-lunicorn.yml`. The caller may also pass a repo description and topics.

Stop and name the gap when:

- `default_branch`, `ci.command` or `ci.checks` is missing, a check has no `name` or `run`, or its `required` is not `true` or `false`. Every template depends on them.
- `ci.checks` has duplicate names, uses a reserved name (`Secret scan`, `Workflow lint`, `CI gate`), or a name or `run` contains `|` or a backtick, which would break the check table in `docs/ci-cd.md`. A complex command belongs in a script the check calls.
- A check's optional `secrets` is not a list, names a secret that does not match `[A-Z_][A-Z0-9_]*`, or names one twice. The names are rendered unquoted into the workflow, where anything else is invalid or ambiguous.
- `forge` is `gitlab` or `forgejo` and a check names `secrets`. Only the GitHub rendering is verified; GitLab hands CI/CD variables to every job on its own, and Forgejo was never tested.
- `ci.runtime.stack` has no entry for the forge in [the runtime templates](references/runtimes.md). A new stack gets its template when a project needs it, not a guess now.
- `forge` is `gitlab` and `ci.runner` is not a list, or a check is named like a GitLab keyword such as `default`, `stages`, `workflow`, `variables` or `image`, which GitLab would read as configuration instead of a job.
- `forge` is `forgejo` and `ci.runner` is not a runner label, or no check has `required: true`: the required matrix would be empty, and Forgejo rejects a job with an empty matrix.

**Done when** every input is valid or the run has stopped with the gap named.

## 2. Generate the files

Fill the templates exactly as their fill rules say: same key order, same quoting, no other change. A template edited by hand is how the house gate drifts apart again.

- **GitHub:** `.github/workflows/ci.yml` and `.github/dependabot.yml` from [the GitHub CI templates](references/github-ci.md), with the stack's setup steps from the runtime templates.
- **GitLab:** `.gitlab-ci.yml` and `renovate.json` from [the GitLab CI templates](references/gitlab-ci.md).
- **Forgejo:** `.forgejo/workflows/ci.yml`, `.forgejo/actionlint.yaml` and `renovate.json` from [the Forgejo CI templates](references/forgejo-ci.md).
- **No forge:** `.githooks/pre-commit` and `.githooks/pre-push` from [the no-forge templates](references/no-forge.md), both executable.
- **All:** `docs/ci-cd.md` from [the CI/CD document template](references/ci-cd-doc.md). On Forgejo, its signed-commit lines depend on the instance signing key described in the Forgejo settings templates.

Compare every generated file with what exists, byte for byte, including the final newline and, for hooks, the executable bit. Report it as `new`, `unchanged` or `drift`, and write it when it is `new` or `drift`. Show the diff of every `drift` file before writing it: an edit made by hand in an untracked file is gone once overwritten. Leave every other file, such as release or CodeQL workflows, untouched.

**Done when** every file is generated and has its status.

## 3. Lint what was generated

- **GitHub:** run actionlint without arguments from the project root, as the Workflow lint job does, and zizmor with `--persona=regular --min-severity=low` on `.github`. Use the versions pinned in the Workflow lint job: actionlint as an installed binary of that version or a checksum-verified download, zizmor as that exact version from PyPI through `pipx` or `uvx`. Without a token zizmor runs offline; that result counts, as it does in CI.
- **Forgejo:** actionlint at the pinned version, exactly as the Workflow lint job runs it: `actionlint -config-file .forgejo/actionlint.yaml .forgejo/workflows/*.yml`.
- **GitLab:** send the generated `.gitlab-ci.yml` as `content` to `POST /projects/<project>/ci/lint`, with access as [the GitLab settings templates](references/gitlab-settings.md) describe; the answer must have `valid: true`. Without a remote or a token, record the lint as a gap: GitLab validates the file again when it creates the first pipeline.
- **GitLab and Forgejo:** `renovate.json` parses as JSON.
- **No forge:** `sh -n` on both hooks, and `shellcheck` when it is installed.

A finding in a generated file is a defect in the template: stop and report it instead of patching the output.

**Done when** every linter that applies exits with 0 or reports valid, or the GitLab lint is recorded as a gap.

## 4. Plan the remote settings

The repository is the `origin` remote on the forge's host. Without one, skip steps 4 and 5 and report the remote settings as a gap: they apply once the repository is pushed.

- **GitHub:** read the current state and compare it with [the GitHub settings templates](references/github-settings.md): the ruleset named like the default branch, the merge settings, and description, topics, wiki and discussions. Also list every other ruleset that requires a status check, and every workflow job a ruleset requires under a name other than `CI gate`; each of them undoes the single required check.
- **GitLab:** the protected branch, the merge request settings and the metadata from the GitLab settings templates.
- **Forgejo:** the branch protection, the merge settings and the metadata from [the Forgejo settings templates](references/forgejo-settings.md), including whether the instance publishes a signing key.
- **No forge:** the only setting is `core.hooksPath` in the local git config.

List every difference as current value and target value.

**Done when** every setting is listed as matching or with its current and target value, or the missing remote or token is recorded as a gap.

## 5. Apply

- **GitHub, GitLab and Forgejo:** show the plan and ask Daniel: "Apply these settings to <project>?" Only a yes to this question counts; branch rules and repo settings affect everyone working in the repository. Apply each change with the command from the forge's settings template, then read the state back and compare it with the target again.
- **No forge:** set `git config core.hooksPath .githooks` without asking, since it changes only this clone, and read it back.

**Done when** the read-back state matches the target, or Daniel declined and the plan is kept for the report, or step 4 recorded a gap.

## 6. Report

- **Files:** each with `new`, `unchanged` or `drift`.
- **Lint:** the exit code or result per linter.
- **Remote settings:** applied, matching, declined with the open differences, or not applied for lack of a remote or token, including a description and topics the caller passed.
- **Gaps:** every gap the CI/CD document names for this forge, and the missing remote or token when there is none.

Leave all file changes uncommitted, so Daniel reviews them before they are committed.

**Done when** the report covers files, lint, remote settings and gaps.
