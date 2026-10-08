---
name: write-issue-templates
description: Writes a project's user issue templates on GitHub, GitLab or Forgejo and brings its labels to the closed house set, or documents the local issue file format when there is no forge, and reports drift. Use when a project's issues are set up for the first time, when its labels or templates drifted, or when a label the skills rely on is missing.
---

Users get the simplest possible entry: Bug and Request. Specs, tickets and bugfixes are never filed from forge templates; the skills that create them carry the only template for each, so no second copy drifts. Labels are a closed set, because skills and triage match them by exact name.

## 1. Check the inputs

Read `forge` and `issues.tracker` from `.claude/64x-lunicorn.yml`.

- The marker, `forge` or `issues.tracker` is missing: stop and point to `setup-project`.
- `issues.tracker` is `local`: do step 4, then step 5. There are no forge templates and no labels.
- `issues.tracker` is `forge`: do steps 2, 3 and 5. The repository is the `origin` remote on the forge's host; without one, skip step 3 and report the labels as a gap, since they apply once the repository is pushed. On GitLab and Forgejo, step 3 reads `GITLAB_TOKEN` or `FORGEJO_TOKEN` from the environment. When it is missing, ask Daniel to export it in his shell, never to paste it into the conversation, and report the labels as a gap if he does not.

Whenever the run stops or skips a step, it still ends with the report in step 5.

**Done when** the path through this skill is chosen, or the run has stopped with the reason named.

## 2. Write the user templates

| Forge | Files | Template |
|---|---|---|
| GitHub | `.github/ISSUE_TEMPLATE/bug.yml`, `request.yml`, `config.yml` | [The issue form templates](references/github-issue-forms.md) |
| Forgejo | `.forgejo/ISSUE_TEMPLATE/bug.yml`, `request.yml`, `config.yml` | The same issue form templates, unchanged |
| GitLab | `.gitlab/issue_templates/Bug.md`, `Request.md` | [The GitLab issue templates](references/gitlab-issue-templates.md) |

Generate each file exactly as its template says. Compare each with what exists, byte for byte including the final newline, and report it as `new`, `unchanged` or `drift`; write it when it is `new` or `drift`. On GitHub and Forgejo, parse the three forms with any YAML parser afterwards; a form that does not parse silently disappears from the issue chooser.

Report every other file in the template directory by name, such as a legacy `bug_report.md`, and remove it only after Daniel confirms; it may carry fields a project needs.

**Done when** the templates are written with their status, the forms parse, and every other template file is reported.

## 3. Bring the labels to the house set

Read the current labels and compare them with [the label set](references/labels.md), using the commands listed there for the forge:

- **Missing:** create.
- **Different color or description:** update. Colors compare without regard to case or a leading `#`, and a missing description counts as empty.
- **Not in the set:** list each with the number of issues and of pull or merge requests carrying it.

Ask Daniel: "Create <n> and update <m> labels in <project>?" Apply with the create and update commands. Then ask separately: "Delete these labels outside the house set: <labels>?" Deleting a label removes it from every issue and pull or merge request that carries it, which is why it is its own question. When anything was applied, read the labels back and compare again.

**Done when** the labels match the set, apart from changes Daniel declined, or step 1 recorded the missing remote or token.

## 4. Document local issues

Generate `issues/README.md` from [the local issue format](references/local-issues.md), compare it byte for byte, report it as `new`, `unchanged` or `drift`, and write it when it is `new` or `drift`. Skills read and write these files by that format, so it has to be written down in the project itself.

**Done when** `issues/README.md` matches the template.

## 5. Report

- **Files:** each with `new`, `unchanged` or `drift`, and other template files found.
- **Labels:** created, updated and deleted; changes Daniel declined, with their current and target values; extras kept.
- **Gaps:** the reason the run stopped, when it did. On GitLab also: blank issues cannot be disabled, so Bug and Request are offered and not enforced, and their labels come from quick actions, which depend on the reporter's permission to label issues.

Leave all file changes uncommitted, so Daniel reviews them before they are committed.

**Done when** the report covers files, labels and gaps.
