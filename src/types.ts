export interface NautilusSettings {
  /** minutes from midnight, 480 = 8:00 */
  workdayStart: number;
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
  /**
   * When a checked todo has no `dHH:MM` completion timestamp, append one
   * automatically (replicates Roam's Todo Trigger; without a timestamp a
   * done todo has no position on the spiral and cannot be drawn).
   */
  stampOnCheck: boolean;
}

export const DEFAULT_SETTINGS: NautilusSettings = {
  workdayStart: 480,
  defaultDuration: 15,
  legendLenLimit: 22,
  customColorTag: "",
  customColor: "rgba(255,0,0,0.5)",
  showPlaybackButton: true,
  dailyNoteFormat: "YYYY-MM-DD",
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
  done: boolean;
  bgColor: string | null;
  doneAt: number | null;
  meeting: boolean;
  todo: boolean;
  freetime: boolean;
  startAfter: number;
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
