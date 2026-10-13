# KAI Terminal MVP — isolated prototype

**DEMO DATA ONLY.** Nothing here is connected to a Core, a database, a worker or a
network. Every goal, worker, event, number and piece of evidence is invented in
`src/fixtures.js`, and the UI renders a permanent `DEMO PROTOTYPE` banner so a
screenshot can never be mistaken for a live system.

This directory is deliberately self-contained. Deleting it cannot break the
production app: nothing imports it, it has no install step and it depends on
nothing outside Node.

## Run it

```bash
cd design-previews/kai-terminal-mvp
npm start          # → http://127.0.0.1:5188
```

Node 20+. No `npm install` — there are no dependencies.

```bash
npm test           # the command parser and the state transitions
```

## What it is

A terminal-first *executive workstation*. There are no tabs: the command line is
the navigation, and every command mutates real prototype state that the whole
surface re-renders from.

Try, in order:

```
/help
/goal inspect g-1041      the goal, its approved revision, its task board
/goal plan g-1041         a NEW revision — watch the approval invalidate
/run g-1041               refused: nothing dispatches against an unapproved plan
/goal approve g-1041
/run g-1041               dispatches t2, charging the dispatch allowance
/doer off                 autonomous work stops; GUARD stays ON
/task inspect t4          a blocked task, with its exact reason
/evidence g-1041          what KAI observed vs what a worker merely claimed
/skill promote polling-backoff   refused: it failed evaluation
/skill rollback verification-loop
/doctor                   every degraded state, explained
```

Keyboard: `↑`/`↓` history, `Tab` complete, `Esc` dismiss, `⌘K`/`Ctrl+K` focus.

## What is simulated, and what is real

| | |
|---|---|
| The command parser, the command table and every state transition | **real code**, tested by `npm test` (27 tests) |
| The goal/plan/approval/task/evidence/worker model | **real shapes** mirroring KAI's contracts |
| The data | **invented** — `src/fixtures.js`, labelled |
| Any Core, worker, model or network call | **none** |

A command that is not implemented says so, and suggests the nearest name.

## Command vocabulary

| family | commands |
|---|---|
| Goals | `/help` `/goal new\|list\|inspect\|challenge\|plan\|approve\|reject\|status` |
| Execution | `/run` `/pause` `/resume` `/tasks` `/task inspect` `/events` `/logs` `/evidence` |
| Workers | `/workers` `/worker inspect\|tasks\|logs` |
| Autonomy | `/doer on\|off` `/guard` `/policy` `/approvals` |
| Learning | `/memory search` `/skills` `/skill inspect\|propose\|evaluate\|promote\|rollback` |
| Environment | `/workspace` `/health` `/doctor` `/clear` |

Aliases: `/g` `/t` `/w` `/s` `/cls` `/?`

## Deliberate design decisions

- **Doer and Guard are never the same control.** `/doer off` suspends autonomous
  work and says, in the output, that Guard is unaffected. There is no `/guard off`.
- **A new plan revision invalidates the previous approval**, and `/run` refuses
  until a revision is approved. The header says which revision dispatch is bound to.
- **Evidence carries its source.** `KAI-OBSERVED`, `WORKER-REPORTED` and
  `VERIFIED` are different strengths, and a worker's claim is rendered as
  `UNVERIFIED` with its limitation.
- **A blocked task shows its reason and the next command**, never a spinner.
- **A candidate skill cannot promote itself** — promotion is refused while the
  evaluation has a regression.

## Screenshots

All captured from the running prototype (managed Chromium, reduced from DPR 1.25
to the exact CSS viewport, PNG):

| file | viewport | shows |
|---|---|---|
| `screenshots/desktop-1440x900.png` | 1440x900 | the full surface: architecture flow, task board, supervisor position, workers, activity, terminal |
| `screenshots/desktop-1440x900-dispatch-refused.png` | 1440x900 | `/run` twice — the second is refused because the claim is single-use |
| `screenshots/desktop-1440x900-doer-off.png` | 1440x900 | Doer OFF with Guard still ON, and dispatch refused |
| `screenshots/narrow-1100x760.png` | 1100x760 | stacked columns, page scrolls rather than compressing rows |
| `screenshots/narrow-900x700.png` | 900x700 | single column, command prompt still reachable |

## Limitations

- No production API, adapter or model is called; this is a design preview.
- Not responsive below ~900px: this is a desktop workstation, so narrow widths
  collapse secondary panels rather than reflowing into a phone layout.
- Screenshots in `screenshots/` are of the rendered prototype.
