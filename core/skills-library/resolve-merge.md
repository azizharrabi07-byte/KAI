---
name: resolve-merge
description: Brings the default branch into the current branch by merging, resolves each merge conflict keeping the intent of both sides and inventing no behaviour, stops on incompatible intents with both sides' sources quoted, and records the merge only after the project's checks passed, never pushing. Use when a branch that belongs to no ticket is to be brought up to date with the default branch or main, or when its merge conflicts are to be resolved. A ticket's branch or pull request that is behind or has merge conflicts goes through `implement-ticket <n> update` instead.
---

Input: the intent of this side, what the current branch set out to achieve, as text from the caller, such as its ticket, Spec and scenarios. Output: `merged`, `stopped: incompatible intents` or `stopped: checks failed`, as in step 6.

Trace every line of the result to one of the two sides; resolving by taste loses one side's work or adds behaviour nobody asked for, and both slip past review because a merge commit looks like bookkeeping. Where both sides cannot stand, Daniel decides.

Never push, never `git merge --abort`, never rebase, never edit issues: pushing belongs to the caller, an abort throws away the state Daniel needs to decide on, a rebase rewrites commits a review already saw.

## 1. Read the marker and the intent of this side

Read `.claude/64x-lunicorn.yml` for `default_branch`, `ci.command`, `forge` and the tracker. Take the intent of this side from the caller's text and the sources it names, never from the branch name, which is a guess.

**Done when** the default branch, `ci.command` and the intent of this side are known.

## 2. Start the merge

With a remote, `git fetch origin` and `git merge --no-ff --no-commit origin/<default_branch>`; without one, `git merge --no-ff --no-commit <default_branch>`. Both flags together hold the merge open in every case, so step 5 runs before anything is recorded; `--no-commit` alone cannot stop a fast-forward.

Already up to date: return `merged` with no resolved files and stop here.

**Done when** `.git/MERGE_HEAD` exists and `git diff --name-only --diff-filter=U` lists the conflicting files, possibly none, or git reported already up to date.

## 3. Read the intent of the default branch

For each conflicting file, read what the default branch set out to achieve, from its primary sources:

- `git log <merge-base>..MERGE_HEAD -- <file>`, with `<merge-base>` from `git merge-base HEAD MERGE_HEAD`, and each commit's message and diff for that file.
- A squash subject ends in `(#<pr>)`; with `forge: github`, `gh pr view <pr> --json title,body` gives its `Closes #<ticket>`. Without a pull request, take every issue a commit message references.
- Read those tickets and the Spec they name. With `issues.tracker: forge`, `gh issue view <n> --comments`; with `local`, issue `<n>` is the file in `issues.path` whose name starts with the number, zero-padded to four digits.

Both sides of the file: `git show :2:<file>` is this side, `:3:` the default branch, `:1:` the merge-base.

**Done when** each conflicting file has both intents, each with the passage it comes from.

## 4. Resolve or stop

For each conflicting file, decide whether one result can keep both intents:

- **Both can be kept:** write the result from the lines of the two sides, each line from this side, from the default branch, or combining a change of each. Add nothing else: no new condition, option, fallback, comment or test that neither side wrote. Stage the file. Needing a line neither side wrote beyond joining their changes means both intents cannot be kept.
- **Both cannot be kept:** the intents contradict, for example one side makes a case succeed and the other makes the same case fail; choosing either decides the product for Daniel. Leave the merge open with the file unresolved and go to step 6 with `stopped: incompatible intents`.

A file with merge conflict markers left counts as unresolved. Files git merged without a conflict stay as git merged them.

**Done when** every conflicting file is resolved and staged with no marker left, or the run stops.

## 5. Run the project's checks

Run `ci.command` on the merged tree while the merge is still open; a merge commit that breaks the build is harder to take back than an open merge.

On failure, leave the merge open, record nothing, and go to step 6 with `stopped: checks failed`. Fixing the failure is new behaviour, which a merge does not add.

**Done when** `ci.command` passed, or the run stops.

## 6. Record the merge and report

After the checks passed, draft the message with `write-commit-message` from the staged merge: `chore: merge <default_branch> into <branch>`, and a body naming each resolved file with the intent kept from each side. The merge is one change, so `write-commit-message`'s rule to split unrelated changes does not apply. Commit with that message, never with git's default text, which hides what was resolved. Do not push.

Then return exactly one of:

- **`merged`**: the merge commit, and per resolved file what was kept from each side; or no merge commit when step 2 found nothing to merge.
- **`stopped: incompatible intents`**: per file the intent of each side with its source quoted verbatim, and that the merge is left open for Daniel. This is not a review finding and gets no class.
- **`stopped: checks failed`**: the failing output of `ci.command`, and that the merge is left open.

**Done when** one of the three outcomes is returned, with the merge committed or left open as that outcome says.
