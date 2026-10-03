export interface NautilusSettings {
  /** minutes from midnight (whole hours), 480 = 8:00 */
  workdayStart: number;
  /** minutes from midnight; > 1440 when the window crosses midnight */
  workdayEnd: number;
  /** default flexible-todo duration in minutes */
  defaultDuration: number;
  /** max legend text length (chars) */
  legendLenLimit: number;
  /** tag that triggers custom color, e.g. "#focus"; empty disables */
  customColorTag: string;
  /** rgba(...) color used for tasks carrying customColorTag */
  customColor: string;
  /** show the hyper-lapse playback button on charts */
  showPlaybackButton: boolean;
  /** moment.js format matching daily note filenames, e.g. "YYYY-MM-DD" */
  dailyNoteFormat: string;
  /** folder containing daily notes; empty = vault root */
  dailyNotesFolder: string;
  /** Execution Layer: CLOCK tracking, POMO and daily review (default off) */
  executionLayer: boolean;
  /** POMO live signal threshold in minutes */
  pomodoroThreshold: number;
  /** minutes a closed task stays in the Timing recents list; 0 disables */
  recentRetention: number;
  /** warn when a CLOCK runs longer than this; 0 disables */
  forgottenTimerWarning: number;
  /**
   * When a checked todo has no `dHH:MM` completion timestamp, append one
   * automatically (replicates Roam's Todo Trigger; without a timestamp a
   * done todo has no position on the spiral and cannot be drawn).
   */
  stampOnCheck: boolean;
}

export const DEFAULT_SETTINGS: NautilusSettings = {
  workdayStart: 420,
  workdayEnd: 1320,
  defaultDuration: 30,
  legendLenLimit: 22,
  customColorTag: "",
  customColor: "rgba(255,0,0,0.5)",
  showPlaybackButton: true,
  dailyNoteFormat: "YYYY-MM-DD",
  dailyNotesFolder: "",
  executionLayer: false,
  pomodoroThreshold: 25,
  recentRetention: 45,
  forgottenTimerWarning: 30,
  stampOnCheck: true,
};

export interface NautEvent {
  description: string;
  /** 0-100 */
  progress: number;
  /** remaining minutes (scaled by progress) */
  duration: number;
  /** source line number in the markdown file */
  line: number;
  /** minutes from midnight */
  start: number;
  end: number;
  /** original estimate before progress scaling */
  estimate: number;
  done: boolean;
  bgColor: string | null;
  doneAt: number | null;
  meeting: boolean;
  todo: boolean;
  freetime: boolean;
  startAfter: number;
  /** arc drawn from a real CLOCK interval (dot pattern, actual position) */
  actual?: boolean;
  /** suppress the legend entry (all but the first arc of a task) */
  noLegend?: boolean;
}

/**
 * Normalize the [workdayStart, workdayEnd] window: an end at or before the
 * start means the window continues past midnight into the next day.
 */
export function workdayWindow(s: NautilusSettings): [number, number] {
  const ws = s.workdayStart;
  let we = s.workdayEnd;
  if (we <= ws) we += 1440;
  return [ws, we];
}

export interface Rect {
  w: number;
  h: number;
  x: number;
  y: number;
  radians: number;
  realRadians: number;
  text?: string;
}

export interface Center {
  cx: number;
  cy: number;
}
