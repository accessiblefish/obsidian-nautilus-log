/**
 * CLOCK / LOGBOOK execution layer — pure logic, ported from the Roam
 * extension's timing-core.js. Org-compatible line format:
 *
 *   - LOGBOOK::
 *     - CLOCK: [2026-08-22 Sat 10:00]--[2026-08-22 Sat 10:18] => 0:18
 */

export interface ClockInterval {
  start: Date;
  end: Date | null;
  running: boolean;
  /** minutes, null while running */
  minutes: number | null;
  /** source line number */
  line: number;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "[2026-08-22 Sat 10:00]" */
export function formatClockStamp(date: Date): string {
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${DAY_NAMES[date.getDay()]} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}]`;
}

export function parseClockStamp(text: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+\S+)?\s+(\d{1,2}):(\d{2})$/.exec(
    text.trim()
  );
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const year = +y;
  const month = +mo;
  const day = +d;
  const hour = +h;
  const minute = +mi;
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
    ? date
    : null;
}

export function formatDurationHMM(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)}:${pad(safe % 60)}`;
}

/** "45m" / "1h" / "1h30m" — compact label used in the panel. */
export function compactMinutes(minutes: number): string {
  const safe = Math.max(0, Math.floor(minutes));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h${m}m` : `${h}h`;
}

export function formatClockLine(start: Date, end: Date | null = null): string {
  if (!end) return `CLOCK: ${formatClockStamp(start)}`;
  const safeEnd = end.getTime() < start.getTime() ? start : end;
  const minutes = Math.floor((safeEnd.getTime() - start.getTime()) / 60000);
  return `CLOCK: ${formatClockStamp(start)}--${formatClockStamp(
    safeEnd
  )} => ${formatDurationHMM(minutes)}`;
}

/**
 * Matches a full markdown line holding a CLOCK entry, with an optional list
 * marker: `    - CLOCK: [start]--[end] => 0:18`
 */
const CLOCK_LINE_RE =
  /^(\s*(?:[-*+]\s+)?):?CLOCK:{1,2}\s*\[([^\]]+)\](?:\s*--\s*\[([^\]]+)\])?(?:\s*=>\s*(\d+:[0-5]\d))?\s*$/i;

/** Matches the LOGBOOK drawer header line. */
const LOGBOOK_LINE_RE = /^\s*(?:[-*+]\s+)?[:]?LOGBOOK:{1,2}\s*$/i;

export function parseClockLine(line: string, lineNo: number): ClockInterval | null {
  const m = CLOCK_LINE_RE.exec(line);
  if (!m) return null;
  const start = parseClockStamp(m[2]);
  const end = m[3] ? parseClockStamp(m[3]) : null;
  if (!start || (m[3] && !end) || (end && end < start)) return null;
  return {
    start,
    end,
    running: !end,
    minutes: end ? Math.floor((end.getTime() - start.getTime()) / 60000) : null,
    line: lineNo,
  };
}

export function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

/**
 * Range of child lines belonging to a task: following lines indented deeper
 * than the task, stopping at a blank line or a same/shallower-indent list
 * item. [start, end) — empty when the task has no children.
 */
export function childRange(
  lines: string[],
  taskLine: number,
  taskIndent: number
): [number, number] {
  let end = taskLine + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") break;
    if (indentOf(line) <= taskIndent) break;
    end++;
  }
  return [taskLine + 1, end];
}

/** All CLOCK entries recorded under a task line. */
export function clockEntriesForTask(
  lines: string[],
  taskLine: number,
  taskIndent: number
): ClockInterval[] {
  const [from, to] = childRange(lines, taskLine, taskIndent);
  const out: ClockInterval[] = [];
  for (let i = from; i < to; i++) {
    const c = parseClockLine(lines[i], i);
    if (c) out.push(c);
  }
  return out;
}

export interface OpenClock {
  clockLine: number;
  /** owning task line (nearest shallower-indent list item above), -1 if none */
  taskLine: number;
  start: Date;
}

/** The single running CLOCK in a file, if any. */
export function findOpenClock(lines: string[]): OpenClock | null {
  for (let i = 0; i < lines.length; i++) {
    const c = parseClockLine(lines[i], i);
    if (c && c.running) {
      let taskLine = -1;
      const clockIndent = indentOf(lines[i]);
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].trim() === "") break;
        if (
          indentOf(lines[j]) < clockIndent &&
          /^\s*[-*+]\s+/.test(lines[j]) &&
          !LOGBOOK_LINE_RE.test(lines[j])
        ) {
          taskLine = j;
          break;
        }
      }
      return { clockLine: i, taskLine, start: c.start };
    }
  }
  return null;
}

/** Close a running CLOCK line in place. No-op if it is already closed. */
export function closeClockLine(lines: string[], clockLine: number, now: Date): boolean {
  const m = CLOCK_LINE_RE.exec(lines[clockLine]);
  if (!m || m[3]) return false;
  const start = parseClockStamp(m[2]);
  if (!start) return false;
  lines[clockLine] = `${m[1]}${formatClockLine(start, now)}`;
  return true;
}

/**
 * Clock in a task: closes any running CLOCK in the file at the same instant,
 * ensures a LOGBOOK:: child under the task and inserts a fresh open CLOCK
 * entry. Mutates `lines` (with insertions) so callers persist in ONE write.
 */
export function clockInTask(
  lines: string[],
  taskLine: number,
  taskIndent: number,
  now: Date
): void {
  const open = findOpenClock(lines);
  if (open) closeClockLine(lines, open.clockLine, now);

  const pad1 = " ".repeat(taskIndent + 2);
  const pad2 = " ".repeat(taskIndent + 4);
  const [from, to] = childRange(lines, taskLine, taskIndent);

  let logbookLine = -1;
  let lastClockLine = -1;
  for (let i = from; i < to; i++) {
    if (LOGBOOK_LINE_RE.test(lines[i])) logbookLine = i;
    if (parseClockLine(lines[i], i)) lastClockLine = i;
  }

  if (logbookLine === -1) {
    lines.splice(
      taskLine + 1,
      0,
      `${pad1}- LOGBOOK::`,
      `${pad2}- ${formatClockLine(now)}`
    );
  } else {
    lines.splice(
      lastClockLine !== -1 ? lastClockLine + 1 : logbookLine + 1,
      0,
      `${pad2}- ${formatClockLine(now)}`
    );
  }
}

/** Actual minutes within the plan window; a running entry counts until now. */
export function actualMinutesInWindow(
  entries: ClockInterval[],
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number
): number {
  let total = 0;
  for (const e of entries) {
    const s = e.start.getTime();
    const en = e.running ? nowMs : e.end!.getTime();
    const cs = Math.max(windowStartMs, s);
    const ce = Math.min(windowEndMs, en);
    if (ce > cs) total += ce - cs;
  }
  return Math.floor(total / 60000);
}

/** Latest closed CLOCK end, or null. */
export function lastClockEndMs(entries: ClockInterval[]): number | null {
  let last: number | null = null;
  for (const e of entries) {
    if (e.end && (last === null || e.end.getTime() > last)) last = e.end.getTime();
  }
  return last;
}

/* ------------------------------------------------------------------ *
 * Daily review — ported from buildDailyReview
 * ------------------------------------------------------------------ */

export type ReviewState = "compared" | "not-tracked" | "live" | "paused" | "not-started";

export interface ReviewTask {
  line: number;
  description: string;
  done: boolean;
  plannedMinutes: number;
}

export interface ReviewRow extends ReviewTask {
  state: ReviewState;
  actualMinutes: number;
  varianceMinutes: number | null;
}

export interface DailyReview {
  rows: ReviewRow[];
  summary: {
    totalCount: number;
    completedCount: number;
    comparedCount: number;
    /** rows with any tracked actual time (summary totals count these) */
    trackedCount: number;
    plannedMinutes: number;
    actualMinutes: number;
    varianceMinutes: number;
  };
}

export function buildDailyReview(
  tasks: ReviewTask[],
  entriesByLine: Map<number, ClockInterval[]>,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number
): DailyReview {
  const rows: ReviewRow[] = tasks.map((task) => {
    const entries = entriesByLine.get(task.line) ?? [];
    const closed = entries.filter((e) => !e.running);
    const closedActual = actualMinutesInWindow(closed, windowStartMs, windowEndMs, nowMs);
    const currentActual = actualMinutesInWindow(entries, windowStartMs, windowEndMs, nowMs);
    const completed = task.done;
    const live = !completed && currentActual > 0 && entries.some((e) => e.running);
    const comparable = completed && closedActual > 0;
    const actual = completed ? closedActual : currentActual;
    const state: ReviewState = comparable
      ? "compared"
      : completed
      ? "not-tracked"
      : live
      ? "live"
      : actual > 0
      ? "paused"
      : "not-started";
    return {
      ...task,
      state,
      actualMinutes: actual,
      // variance is meaningful for any tracked task, not only completed ones
      varianceMinutes: actual > 0 ? actual - task.plannedMinutes : null,
    };
  });

  const compared = rows.filter((r) => r.state === "compared");
  const tracked = rows.filter((r) => r.actualMinutes > 0);
  const planned = tracked.reduce((t, r) => t + r.plannedMinutes, 0);
  const actual = tracked.reduce((t, r) => t + r.actualMinutes, 0);
  return {
    rows,
    summary: {
      totalCount: rows.length,
      completedCount: rows.filter((r) => r.done).length,
      comparedCount: compared.length,
      trackedCount: tracked.length,
      plannedMinutes: planned,
      actualMinutes: actual,
      varianceMinutes: actual - planned,
    },
  };
}
