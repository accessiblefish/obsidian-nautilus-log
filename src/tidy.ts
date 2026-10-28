import { parseRowParams, TaskLine } from "./parser";
import { alignIntervalToWindow } from "./scheduler";
import { NautilusSettings, workdayWindow } from "./types";

export interface TidyEdit {
  /** Full file contents after the direct-child blocks have been reordered. */
  lines: string[];
  /** Complete direct-child blocks, including descendants, before Tidy. */
  originalOrder: string[];
  /** Complete direct-child blocks after Tidy; used to guard Undo. */
  targetOrder: string[];
  /** Number of settled blocks whose position changed. */
  count: number;
}

interface DirectBlock {
  text: string;
  settled: boolean;
  originalIndex: number;
}

/**
 * Return each direct list item as one complete block. Indented CLOCK entries,
 * subtasks, and other child content travel with their parent unchanged.
 */
export function directBlockTexts(lines: string[], tasks: TaskLine[]): string[] {
  if (tasks.length === 0) return [];
  const baseIndent = tasks[0].indent;
  return tasks.map((task, index) => {
    let end = tasks[index + 1]?.line ?? lines.length;
    if (index === tasks.length - 1) {
      end = lines.length;
      for (let i = task.line + 1; i < lines.length; i++) {
        if (lines[i].trim() === "") {
          end = i;
          break;
        }
        const indent = /^\s*/.exec(lines[i])![0].length;
        if (indent <= baseIndent) {
          end = i;
          break;
        }
      }
    }
    return lines.slice(task.line, end).join("\n");
  });
}

/**
 * Completed tasks plus fixed events whose end has passed. Overnight events
 * and the current time are aligned to the same continuous plan window.
 */
export function settledTaskLines(
  tasks: TaskLine[],
  settings: NautilusSettings,
  nowMin: number
): Set<number> {
  const settled = new Set<number>();
  const [windowStart, windowEnd] = workdayWindow(settings);
  const effectiveNow =
    windowEnd > 1440 && nowMin < windowStart ? nowMin + 1440 : nowMin;
  for (const task of tasks) {
    const event = parseRowParams(
      task.text,
      task.checked === true,
      task.line,
      settings
    );
    if (!event) continue;
    if (event.done) {
      settled.add(task.line);
      continue;
    }
    if (event.meeting) {
      const [start, end] = alignIntervalToWindow(
        event.start,
        event.end,
        windowStart,
        windowEnd
      );
      const insideWindow = end > windowStart && start < windowEnd;
      // Events outside the chart window still follow ordinary wall-clock
      // elapsed semantics; only aligned in-window events use overnight time.
      if (end <= (insideWindow ? effectiveNow : nowMin)) {
        settled.add(task.line);
      }
    }
  }
  return settled;
}

/**
 * Stable-partition settled items to the front. Active items keep their exact
 * relative priority, and a running task is never moved even if its checkbox
 * was just completed and its CLOCK has not yet been reconciled.
 */
export function createTidyEdit(
  lines: string[],
  tasks: TaskLine[],
  settledLines: Set<number>,
  runningTaskLine: number | null = null
): TidyEdit {
  const originalOrder = directBlockTexts(lines, tasks);
  if (tasks.length === 0) {
    return { lines, originalOrder, targetOrder: [], count: 0 };
  }

  const blocks: DirectBlock[] = tasks.map((task, index) => ({
    text: originalOrder[index],
    settled: settledLines.has(task.line) && task.line !== runningTaskLine,
    originalIndex: index,
  }));
  const target = blocks
    .filter((block) => block.settled)
    .concat(blocks.filter((block) => !block.settled));
  const targetOrder = target.map((block) => block.text);
  const count = target.filter(
    (block, index) => block.settled && block.originalIndex !== index
  ).length;

  if (count === 0) {
    return { lines, originalOrder, targetOrder: originalOrder, count: 0 };
  }

  const firstLine = tasks[0].line;
  const lastBlock = originalOrder[originalOrder.length - 1];
  const lastTask = tasks[tasks.length - 1];
  const lastHeight = lastBlock === "" ? 0 : lastBlock.split("\n").length;
  const endLine = lastTask.line + lastHeight;
  const nextLines = lines
    .slice(0, firstLine)
    .concat(
      targetOrder.reduce<string[]>(
        (expanded, block) => expanded.concat(block === "" ? [] : block.split("\n")),
        []
      )
    )
    .concat(lines.slice(endLine));
  return { lines: nextLines, originalOrder, targetOrder, count };
}

/**
 * Restore a previous order only while the plan still exactly matches the
 * Tidy result. Edits elsewhere in the note are preserved; edits inside the
 * plan invalidate Undo rather than being overwritten.
 */
export function restoreTidyEdit(
  lines: string[],
  tasks: TaskLine[],
  originalOrder: string[],
  targetOrder: string[]
): string[] | null {
  const currentOrder = directBlockTexts(lines, tasks);
  if (
    currentOrder.length !== targetOrder.length ||
    currentOrder.some((block, index) => block !== targetOrder[index]) ||
    originalOrder.length !== currentOrder.length
  ) {
    return null;
  }
  if (tasks.length === 0) return lines;

  const firstLine = tasks[0].line;
  const lastTask = tasks[tasks.length - 1];
  const lastBlock = currentOrder[currentOrder.length - 1];
  const endLine = lastTask.line + (lastBlock === "" ? 0 : lastBlock.split("\n").length);
  return lines
    .slice(0, firstLine)
    .concat(
      originalOrder.reduce<string[]>(
        (expanded, block) => expanded.concat(block === "" ? [] : block.split("\n")),
        []
      )
    )
    .concat(lines.slice(endLine));
}
