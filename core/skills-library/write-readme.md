---
name: write-readme
description: Writes a project's README.md in the house skeleton with centered header, banner, pitch, How it works, Quickstart, Documentation, Contributing and License sections, keeps the project's own sections on re-runs and reports drift. Use when a project gets its first README, when an existing README is brought to the house style, or when the README drifted after the license, the docs or the CI command changed.
---

Every project README has the same shape, so a reader who knows one knows where everything is in all of them. The fixed parts come from a template. The project's own content lives in project sections: drafted once, confirmed by Daniel, and kept word for word on every later run. That is what lets a re-run with the same inputs produce the same file.

## 1. Check the inputs

Read `forge`, `default_branch` and `ci.command` from `.claude/64x-lunicorn.yml`. The caller may pass the tagline, the pitch (headline, paragraph and bold one-liner), the license key, the copyright year and the holder.

Stop and name the gap when:

- The marker, `forge`, `default_branch` or `ci.command` is missing. Point to `setup-project`.
- The license is not `mit` or `gpl-3.0`, or none was passed and no `LICENSE` or `COPYING` matches either. The license badge and section exist only for these two.

The name is the repository name from the `origin` remote, on GitLab the last segment of the project path, otherwise the name of the project directory. What the caller did not pass comes from the existing README; when there is none, it is drafted in step 2 like a project section.

**Done when** every input is known or the run has stopped with the gap named.

## 2. Collect the project sections

Follow [the README template](references/readme-template.md). For each `<<keep:…>>` placeholder:

- **Existing README in the skeleton:** take the content between the fixed parts around the placeholder, unchanged.
- **Existing README in another shape:** map its content to the matching sections and put everything else into `project_sections`, in its original order. Drop nothing; a paragraph lost in a restyle is lost silently.
- **No content yet:** draft it from what the repository shows: manifest, existing docs, entry points, commands that exist. A README claim the repository does not back is a claim a reader acts on.

Show every drafted or remapped section together and wait for Daniel's confirmation or edits. Content already in skeleton form is not shown again.

**Done when** every project section has confirmed content or is confirmed as empty.

## 3. Generate and compare

Fill the template exactly as its fill rules say. When `docs/assets/<name>-banner.svg` does not exist, also generate it from [the banner placeholder](references/banner-placeholder.md): the banner is required, and a README pointing to a missing image shows a broken one.

Compare each generated file with what exists, byte for byte including the final newline, and report it as `new`, `unchanged` or `drift`. Show the diff of every `drift` file before writing it, then write every file that is `new` or `drift`.

**Done when** the README and, when it was missing, the banner are written with their status.

## 4. Check the result

- Every relative link points to an existing file, and every `#anchor` matches a heading by GitHub's heading slugs.
- No heading contains an emoji, and there is no HTML outside the header `div`.
- Every badge URL carries `style=flat-square`.
- Every code block in Quickstart holds one command.

A failure in a fixed part is a defect in the template: stop and report it instead of patching the output. A failure in a project section goes to Daniel with its line, since only he knows whether the link or the step is what is wrong.

**Done when** every check passes or each failure is reported.

## 5. Report

- **Files:** `README.md` and the banner, each with `new`, `unchanged` or `drift`.
- **Project sections:** kept, drafted or remapped, per section.
- **Checks:** passed, or each failure with its line.
- **Gaps:** the banner while it is still the placeholder, a link to a file another setup skill has not written yet, and the reason the run stopped, when it did.

Leave all file changes uncommitted, so Daniel reviews them before they are committed.

**Done when** the report covers files, project sections, checks and gaps.
