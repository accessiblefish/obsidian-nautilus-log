import { NautilusSettings } from "./types";
import {
  ClockInterval,
  DailyReview,
  OpenClock,
  ReviewTask,
  compactMinutes,
  formatDurationHMM,
} from "./timing";

export type PanelTab = "timing" | "plan" | "review";

export interface PanelProps {
  settings: NautilusSettings;
  tab: PanelTab;
  /** currently running CLOCK, with its task description */
  openClock: (OpenClock & { description: string }) | null;
  /** unfinished tasks of the primary plan */
  planTasks: ReviewTask[];
  /** CLOCK entries per task line */
  entriesByLine: Map<number, ClockInterval[]>;
  review: DailyReview;
  pomoStartMs: number | null;
  nowMs: number;
  onTab: (tab: PanelTab) => void;
  onClockIn: (line: number) => void;
  onClockOut: () => void;
  onPomoToggle: () => void;
}

function el(
  tag: string,
  cls: string | null,
  text?: string,
  parent?: HTMLElement
): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function liveElapsed(
  parent: HTMLElement,
  startMs: number,
  nowMs: number,
  warn: boolean
): HTMLElement {
  const e = el(
    "span",
    "nautilus-exec-elapsed" + (warn ? " nautilus-exec-warn" : ""),
    formatDurationHMM((nowMs - startMs) / 60000),
    parent
  );
  e.dataset.startMs = String(startMs);
  return e;
}

export function renderExecPanel(container: HTMLElement, p: PanelProps): void {
  const root = el("div", "nautilus-exec", undefined, container);

  // header: tabs + pomo stopwatch
  const header = el("div", "nautilus-exec-header", undefined, root);
  const tabs = el("div", "nautilus-exec-tabs", undefined, header);
  for (const t of ["timing", "plan", "review"] as PanelTab[]) {
    const label = t === "timing" ? "Timing" : t === "plan" ? "Plan" : "Review";
    const b = el(
      "button",
      "nautilus-exec-tab" + (p.tab === t ? " is-active" : ""),
      label,
      tabs
    );
    b.addEventListener("click", () => p.onTab(t));
  }

  // POMO: standalone count-up; hidden while a task CLOCK runs (CLOCK wins)
  const pomoWrap = el("div", "nautilus-exec-pomo", undefined, header);
  if (!p.openClock) {
    const btn = el(
      "button",
      "nautilus-exec-btn",
      p.pomoStartMs ? "Stop POMO" : "POMO",
      pomoWrap
    );
    btn.addEventListener("click", () => p.onPomoToggle());
    if (p.pomoStartMs) {
      const over =
        p.settings.pomodoroThreshold > 0 &&
        p.nowMs - p.pomoStartMs >= p.settings.pomodoroThreshold * 60000;
      liveElapsed(pomoWrap, p.pomoStartMs, p.nowMs, over);
    }
  }

  const body = el("div", "nautilus-exec-body", undefined, root);

  if (p.tab === "timing") {
    if (p.openClock) {
      const row = el("div", "nautilus-exec-row is-live", undefined, body);
      el("span", "nautilus-exec-dot", "●", row);
      el("span", "nautilus-exec-desc", p.openClock.description, row);
      const forgotten =
        p.settings.forgottenTimerWarning > 0 &&
        p.nowMs - p.openClock.start.getTime() >=
          p.settings.forgottenTimerWarning * 60000;
      liveElapsed(row, p.openClock.start.getTime(), p.nowMs, forgotten);
      const stop = el("button", "nautilus-exec-btn", "Clock out", row);
      stop.addEventListener("click", () => p.onClockOut());
    } else {
      el("div", "nautilus-exec-empty", "No active clock.", body);
    }
    // recently closed
    if (p.settings.recentRetention > 0) {
      const cutoff = p.nowMs - p.settings.recentRetention * 60000;
      const recent: { desc: string; minutes: number }[] = [];
      for (const task of p.planTasks.concat()) {
        for (const e of p.entriesByLine.get(task.line) ?? []) {
          if (!e.running && e.end && e.end.getTime() >= cutoff) {
            recent.push({ desc: task.description, minutes: e.minutes ?? 0 });
          }
        }
      }
      // include closed entries of done tasks as well
      for (const row of p.review.rows) {
        if (recent.some((r) => r.desc === row.description)) continue;
        for (const e of p.entriesByLine.get(row.line) ?? []) {
          if (!e.running && e.end && e.end.getTime() >= cutoff) {
            recent.push({ desc: row.description, minutes: e.minutes ?? 0 });
          }
        }
      }
      recent.sort((a, b) => a.minutes - b.minutes);
      for (const r of recent) {
        const row = el("div", "nautilus-exec-row", undefined, body);
        el("span", "nautilus-exec-desc", r.desc, row);
        el("span", "nautilus-exec-time", compactMinutes(r.minutes), row);
      }
    }
  } else if (p.tab === "plan") {
    if (p.planTasks.length === 0) {
      el("div", "nautilus-exec-empty", "All tasks done.", body);
    }
    for (const task of p.planTasks) {
      const row = el("div", "nautilus-exec-row", undefined, body);
      el("span", "nautilus-exec-desc", task.description, row);
      el("span", "nautilus-exec-time", compactMinutes(task.plannedMinutes), row);
      const btn = el(
        "button",
        "nautilus-exec-btn",
        p.openClock && p.openClock.taskLine === task.line ? "Clock out" : "Clock in",
        row
      );
      btn.addEventListener("click", () =>
        p.openClock && p.openClock.taskLine === task.line
          ? p.onClockOut()
          : p.onClockIn(task.line)
      );
    }
  } else {
    const table = el("table", "nautilus-exec-table", undefined, body);
    const thead = el("thead", null, undefined, table);
    const head = el("tr", null, undefined, thead);
    for (const h of ["Task", "Planned", "Actual", "±"]) el("th", null, h, head);
    const tbody = el("tbody", null, undefined, table);
    for (const row of p.review.rows) {
      const tr = el("tr", `is-${row.state}`, undefined, tbody);
      el("td", "nautilus-exec-desc", row.description, tr);
      el("td", null, compactMinutes(row.plannedMinutes), tr);
      el(
        "td",
        null,
        row.actualMinutes > 0 ? compactMinutes(row.actualMinutes) : "—",
        tr
      );
      const v = row.varianceMinutes;
      el(
        "td",
        v != null ? (v > 0 ? "is-over" : "is-under") : null,
        v != null ? (v > 0 ? `+${compactMinutes(v)}` : `-${compactMinutes(-v)}`) : "—",
        tr
      );
    }
    const s = p.review.summary;
    if (s.trackedCount > 0) {
      const foot = el("div", "nautilus-exec-summary", undefined, body);
      const v = s.varianceMinutes;
      foot.textContent = `Tracked ${s.trackedCount}/${s.totalCount} · Planned ${compactMinutes(
        s.plannedMinutes
      )} · Actual ${compactMinutes(s.actualMinutes)} · ${
        v > 0 ? "+" : v < 0 ? "-" : "±"
      }${compactMinutes(Math.abs(v))}`;
    }
  }
}

/** Update only the ticking elapsed labels without re-rendering the panel. */
export function tickElapsedLabels(root: ParentNode, nowMs: number): void {
  root
    .querySelectorAll<HTMLElement>(".nautilus-exec-elapsed")
    .forEach((e) => {
      const start = Number(e.dataset.startMs);
      if (Number.isFinite(start)) {
        e.textContent = formatDurationHMM((nowMs - start) / 60000);
      }
    });
}
