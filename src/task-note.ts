import { DeskTask } from "./log";
import { childRange, indentOf, parseClockLine } from "./timing";

/** Produce a portable Obsidian note name without changing task text. */
export function sanitizeTaskFileName(description: string): string {
  const cleaned = description
    .replace(/[\\/:*?"<>|#[\]^]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 80)
    .replace(/[\s.-]+$/g, "")
    .trim();
  return cleaned || "Untitled task";
}

const LOG_LINE_RE = /^\s*(?:[-*+]\s+)LOG:\s*\[/;

function activityLines(lines: string[], task: DeskTask): string[] {
  const [from, to] = childRange(lines, task.line, task.indent);
  const childIndent = task.indent + 2;
  const activity: string[] = [];
  for (let line = from; line < to; line++) {
    if (indentOf(lines[line]) !== childIndent) continue;
    if (LOG_LINE_RE.test(lines[line]) || parseClockLine(lines[line], line)) {
      activity.push(lines[line].slice(childIndent));
    }
  }
  return activity;
}

function managedTaskNote(lines: string[], task: DeskTask): string {
  const activity = activityLines(lines, task);
  return `${activity.length > 0 ? `${activity.join("\n")}\n\n` : ""}---`;
}

/** Initial task-note contents: activity above, free writing below the divider. */
export function buildTaskNoteContent(lines: string[], task: DeskTask): string {
  return `${managedTaskNote(lines, task)}\n\n`;
}

/** Refresh only the managed activity region; preserve everything below `---`. */
export function syncTaskNoteContent(
  existing: string,
  lines: string[],
  task: DeskTask
): string {
  const existingLines = existing.split("\n");
  const divider = existingLines.findIndex((line) => line.trim() === "---");
  if (divider < 0) return buildTaskNoteContent(lines, task) + existing;
  const userContent = existingLines.slice(divider + 1).join("\n");
  return `${managedTaskNote(lines, task)}\n${userContent}`;
}
