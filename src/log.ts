import { TaskLine } from "./parser";
import { childRange, formatClockStamp } from "./timing";

export interface DeskTask extends TaskLine {
  description: string;
  duration: number;
  latestLog?: TaskLogEntry;
}

export interface TaskLogEntry {
  line: number;
  /** Timestamp without the surrounding square brackets. */
  stamp: string;
  text: string;
}

export interface TaskLogEdit {
  lines: string[];
  entry: TaskLogEntry;
}

const LOG_LINE_RE = /^\s*(?:[-*+]\s+)LOG:\s*\[([^\]]+)\]\s*(.*)$/;

/** Resolve a session task again before writing; line numbers are not stable. */
export function resolveDeskTask(
  tasks: TaskLine[],
  expected: TaskLine
): TaskLine | null {
  const atOriginalLine = tasks.find(
    (task) => task.line === expected.line && task.text === expected.text
  );
  if (atOriginalLine) return atOriginalLine;
  const matches = tasks.filter((task) => task.text === expected.text);
  return matches.length === 1 ? matches[0] : null;
}

/** Read timestamped LOG entries without confusing CLOCK or ordinary notes. */
export function readTaskLogs(lines: string[], task: TaskLine): TaskLogEntry[] {
  const [from, to] = childRange(lines, task.line, task.indent);
  const entries: TaskLogEntry[] = [];
  for (let line = from; line < to; line++) {
    const match = LOG_LINE_RE.exec(lines[line]);
    if (match) entries.push({ line, stamp: match[1], text: match[2] });
  }
  return entries;
}

/** Append one LOG child while preserving CLOCK records and other descendants. */
export function appendTaskLog(
  lines: string[],
  task: TaskLine,
  text: string,
  date: Date
): TaskLogEdit {
  const normalized = text.trim().replace(/\s*\n\s*/g, " ");
  if (!normalized) throw new Error("A log entry cannot be empty.");
  const [, insertAt] = childRange(lines, task.line, task.indent);
  const indent = " ".repeat(task.indent + 2);
  const stamp = formatClockStamp(date).slice(1, -1);
  const line = `${indent}- LOG: [${stamp}] ${normalized}`;
  const nextLines = [...lines];
  nextLines.splice(insertAt, 0, line);
  return {
    lines: nextLines,
    entry: { line: insertAt, stamp, text: normalized },
  };
}
