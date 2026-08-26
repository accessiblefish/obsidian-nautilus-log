# Nautilus Log — User Guide

[Back to README](../README.md) · [简体中文](./guide.zh-CN.md)

## The Execution Layer

The Execution Layer adds time *tracking* on top of time *planning*. It is
**off by default** — enable it in Settings → Nautilus Log → **Execution layer**.

When enabled, the first nautilus block on today's daily note becomes the
**Primary Plan**, and an execution panel appears above its spiral with three
tabs: **Timing**, **Plan**, **Review**.

```
┌────────────────────────────────────────────┐
│ [Timing] [Plan] [Review]          POMO ▶   │
├────────────────────────────────────────────┤
│ ● Write weekly report        0:12  [Clock out] │
│ Morning run · 0:30                           │
└────────────────────────────────────────────┘
```

---

## CLOCK — record actual time

Clocking in writes an org-mode-compatible entry into your note, under the task:

```markdown
- [ ] Write weekly report 45m
  - LOGBOOK::
    - CLOCK: [2026-08-26 Wed 14:00]
```

Clocking out (or clocking into another task) closes the entry:

```markdown
    - CLOCK: [2026-08-26 Wed 14:00]--[2026-08-26 Wed 14:18] => 0:18
```

Rules:

- **One CLOCK at a time.** Clocking into a task closes the previous CLOCK at
  the same instant.
- **The note is the state.** A running CLOCK is just an open entry in the
  file — reloading Obsidian resumes it automatically.
- **Forgotten timer warning.** If a CLOCK runs longer than the configured
  threshold (default 120 min), the elapsed time turns red. It never stops or
  deletes the CLOCK for you. Set to `0` to disable.
- **Overnight windows.** CLOCK time after midnight still belongs to the daily
  note that owns the window, until the window ends.

Ways to clock in/out:

- **Plan tab** → the Clock in button on any unfinished task
- **Timing tab** → Clock out for the running task
- Command palette → **Clock in/out task on current line** (cursor on the task)
- Command palette → **Clock out current task**

### How CLOCK data changes the spiral

A finished task is drawn on the spiral **where it actually happened**:

- Its duration prefers the total of today's CLOCK sessions over the estimate.
- Its position anchors at the `dHH:MM` completion stamp, or — without one —
  at the end of the last CLOCK session.
- Without either anchor, no history is invented: the task simply doesn't
  appear on the spiral.

## POMO — standalone focus timer

The **POMO** button in the panel header starts a simple count-up timer.

- It writes nothing and does not affect Actual, Planned, Review, or the spiral.
- It survives an Obsidian reload.
- Clocking into a task clears it — a real CLOCK always takes priority.
- Past the Pomodoro threshold (default 45 min) the timer turns red, as a
  gentle "take a break" signal. Nothing is stopped.

## Review — Planned vs Actual

The **Review** tab compares estimates against tracked reality, per task:

| Task | Planned | Actual | ± |
|---|---|---|---|
| Write weekly report | 45m | 40m | -5m |
| Morning run | 30m | — | — |

Per-task states:

| State | Meaning |
|---|---|
| compared | done and has CLOCK data — variance shown |
| not-tracked | done without CLOCK data — nothing to compare |
| live | a CLOCK is running on it right now |
| paused | has CLOCK time, not running, not done |
| not-started | no CLOCK time yet |

The summary row counts every task with tracked time (compared, live and
paused) — comparing a planned estimate against a day you never tracked would
be meaningless. Actual is never capped at Planned: a 30m task that truly
took 2h reports +1h30m.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Execution layer | off | Master switch for panel, CLOCK writer, commands |
| Pomodoro threshold | 45 min | POMO turns red past this |
| Recent retention | 45 min | How long closed CLOCKs stay in Timing's recents; `0` disables |
| Forgotten timer warning | 120 min | Warn about a running CLOCK; `0` disables |

## Commands

- **Clock in/out task on current line** — bind a hotkey for the fastest flow
- **Clock out current task**
- **Locate primary plan** — jump to today's daily note
