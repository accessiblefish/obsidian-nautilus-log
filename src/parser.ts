import { NautEvent, NautilusSettings } from "./types";

/* ------------------------------------------------------------------ *
 * Text parsers — faithful port of the original Roam Nautilus parsers.
 * ------------------------------------------------------------------ */

/** "9pm" / "21:30" / "9" -> [minutesFromMidnight, amPmSuffixOrNull] */
function toMinutes(timeStr: string, h12: string | null): [number, string | null] {
  const pmMatch = timeStr.match(/(?:pm|PM)/);
  const amMatch = timeStr.match(/(?:am|AM)/);
  const cleaned = timeStr.replace(/(?:am|AM|pm|PM)/g, "").trim();
  let hours: number;
  let mins: number;
  if (cleaned.includes(":")) {
    const [h, m] = cleaned.split(":");
    hours = parseInt(h, 10) || 0;
    mins = parseInt(m, 10) || 0;
  } else {
    hours = parseInt(cleaned, 10) || 0;
    mins = 0;
  }
  const pm = pmMatch !== null;
  const am = amMatch !== null;
  let newHours: number;
  if (!am && (pm || (h12 !== null && h12.toLowerCase() === "pm"))) {
    newHours = hours === 12 ? 12 : hours + 12;
  } else if (am) {
    newHours = hours === 12 ? 0 : hours;
  } else {
    newHours = hours;
  }
  const h = ((newHours % 24) + 24) % 24;
  const m = ((mins % 60) + 60) % 60;
  return [m + 60 * h, pmMatch ? pmMatch[0] : amMatch ? amMatch[0] : null];
}

const RANGE_RE =
  /(?:\d{1,2}(?::\d{1,2})?(?:\s*(?:\s?AM|\s?PM|\s?am|\s?pm))?)\s*(?:-|–|—|~|až|to)\s*(?:\d{1,2}(?::\d{1,2})?(?:\s*(?:\s?AM|\s?PM|\s?am|\s?pm))?)/;
const RANGE_SPLIT_RE = /(.*)(?:-|–|—|~|až|to)(.*)/;

export function parseTimeRange(s: string): { range: [number, number] | null; cleaned: string } {
  const m = s.match(RANGE_RE);
  if (!m) return { range: null, cleaned: s };
  const rangeStr = m[0];
  const parts = rangeStr.match(RANGE_SPLIT_RE);
  if (!parts) return { range: null, cleaned: s };
  // guard against false positives like "读 2-3 章": at least one side must
  // look like a real time (contains a colon or an am/pm suffix)
  if (!/:|am|pm/i.test(parts[1]) && !/:|am|pm/i.test(parts[2])) {
    return { range: null, cleaned: s };
  }
  const cleaned = s.replace(rangeStr, "").replace(/\s\s/, " ");
  const [toMin, h12] = toMinutes(parts[2], null);
  const [fromMin] = toMinutes(parts[1], h12);
  return {
    range: toMin > fromMin ? [fromMin, toMin] : [fromMin, fromMin],
    cleaned,
  };
}

/**
 * Duration token: `45m`, `30min`, `1h`, or compound `1h30m` / `1h30min`.
 * Bounded by whitespace/start/end so it cannot match inside words.
 * Ported from the Roam extension's DURATION_TOKEN_RE.
 */
const DURATION_TOKEN_RE = /(?:^|\s)(\d+h(?:\d+(?:min|m))?|\d+(?:min|m))(?=\s|$)/i;

export function parseDuration(s: string, settings: NautilusSettings): { duration: number; cleaned: string } {
  const m = DURATION_TOKEN_RE.exec(s);
  if (m) {
    const token = m[1];
    const hours = /(\d+)h/i.exec(token);
    const minutes = /(\d+)(?:min|m)/i.exec(token);
    const duration =
      (hours ? parseInt(hours[1], 10) : 0) * 60 +
      (minutes ? parseInt(minutes[1], 10) : 0);
    if (duration > 0) return { duration, cleaned: s.replace(m[0], "") };
  }
  return { duration: settings.defaultDuration, cleaned: s };
}

const PROGRESS_RE = /(\sd)(\d{1,3})(\%)/;

export function parseProgress(s: string): { progress: number; cleaned: string } {
  const m = s.match(PROGRESS_RE);
  if (m) {
    const p = Math.min(100, parseInt(m[2], 10));
    return { progress: p, cleaned: s.replace(m[0], "") };
  }
  return { progress: 0, cleaned: s };
}

/*
 * Completion stamps use a strict `dH:MM` / `dHH:MM` form with a valid hour
 * (0–23) and minute (00–59), delimited by whitespace/end. This avoids false
 * positives like the "d2" in "读 d2 章" (which the original Roam regex
 * `d(\d{1,2}(:\d{1,2})?)` would happily match).
 */
const HOUR = "(?:[01]?\\d|2[0-3])";
const DONE_TIME_RE = new RegExp(`(?:^|\\s)d(${HOUR}):([0-5]\\d)(?=$|\\s)`);

/** Matches a completion stamp at the very end of a line (where we append it). */
const TRAILING_DONE_TIME_RE = new RegExp(`\\s+d${HOUR}:[0-5]\\d\\s*$`);

/** Matches a stamp anywhere (used when rewriting a line we fully control). */
const INLINE_DONE_TIME_RE = new RegExp(`\\s?d${HOUR}:[0-5]\\d`);

/** True if the (marker-stripped) task text carries a dHH:MM completion stamp. */
export function hasDoneTime(text: string): boolean {
  return DONE_TIME_RE.test(text);
}

/** True if the task text ends with a completion stamp. */
export function hasTrailingDoneTime(text: string): boolean {
  return TRAILING_DONE_TIME_RE.test(text);
}

/** Remove a trailing completion stamp from a full task line. */
export function stripTrailingDoneTime(line: string): string {
  return line.replace(TRAILING_DONE_TIME_RE, "");
}

export function parseDoneTime(s: string): { doneAt: number | null; cleaned: string } {
  const m = s.match(DONE_TIME_RE);
  if (m) {
    const doneAt = parseInt(m[2], 10) + 60 * (parseInt(m[1], 10) || 0);
    return { doneAt, cleaned: s.replace(m[0], m[0].startsWith("d") ? "" : " ") };
  }
  return { doneAt: null, cleaned: s };
}

const ROAM_DONE_RE = /\{\{\[\[DONE\]\]\}\}/;

export function parseDone(s: string, checkboxDone: boolean): { done: boolean; cleaned: string } {
  const roamDone = ROAM_DONE_RE.test(s);
  if (roamDone) {
    return {
      done: true,
      cleaned: s.replace(ROAM_DONE_RE, "").replace(/\s\%\d{1,3}/, ""),
    };
  }
  return { done: checkboxDone, cleaned: s };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseCustomColor(
  s: string,
  settings: NautilusSettings
): { customColor: string | null; cleaned: string } {
  if (!settings.customColorTag) return { customColor: null, cleaned: s };
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(settings.customColorTag)}(?=$|\\s)`);
  if (re.test(s)) return { customColor: settings.customColor, cleaned: s };
  return { customColor: null, cleaned: s };
}

/** "[text](url)" -> "text" (URLs may contain other markers, so run first) */
export function parseURLs(s: string): string {
  return s.replace(/\[([^\]]*?)\]\((.*?)\)/g, "$1");
}

export function parseRest(s: string): string {
  return s
    .replace(/\{\{\[\[TODO\]\]\}\}/g, "")
    .replace(/\{\{\[\[DONE\]\]\}\}/g, "")
    .replace(/\[\[(.*?)\]\]/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\_\_(.*?)\_\_/g, "$1")
    .replace(/\^\^(.*?)\^\^/g, "$1")
    .replace(/\=\=(.*?)\=\=/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\{\{(\[\[)?embed(\]\])?\:/g, "")
    .replace(/\}\}/g, "")
    .replace(/---/g, "")
    .replace(/\s\s/g, " ")
    .trim();
}

/**
 * Parse one task line into an event.
 * `checkboxDone` is the `- [x]` state of the list item (false for non-checkboxes).
 */
export function parseRowParams(
  raw: string,
  checkboxDone: boolean,
  line: number,
  settings: NautilusSettings
): NautEvent | null {
  let s = parseURLs(raw);
  const cc = parseCustomColor(s, settings);
  s = cc.cleaned;
  const tr = parseTimeRange(s);
  s = tr.cleaned;
  const du = parseDuration(s, settings);
  s = du.cleaned;
  const pr = parseProgress(s);
  s = pr.cleaned;
  const dt = parseDoneTime(s);
  s = dt.cleaned;
  const dn = parseDone(s, checkboxDone);
  s = dn.cleaned;
  const description = parseRest(s);
  if (description === "") return null;
  const isMeeting = tr.range !== null;
  return {
    description,
    progress: pr.progress,
    duration: Math.round(((100 - pr.progress) / 100) * du.duration),
    estimate: du.duration,
    line,
    start: dt.doneAt !== null ? dt.doneAt - du.duration : tr.range ? tr.range[0] : 0,
    end: dt.doneAt !== null ? dt.doneAt : tr.range ? tr.range[1] : 0,
    done: dn.done,
    bgColor: cc.customColor,
    doneAt: dn.done ? dt.doneAt : null,
    meeting: isMeeting,
    todo: !isMeeting,
    freetime: false,
    startAfter: 0,
  };
}

/* ------------------------------------------------------------------ *
 * Timestamp fixing — shared by the render path and the vault listener.
 * ------------------------------------------------------------------ */

export interface TaskLine {
  line: number;
  text: string;
  checked: boolean | null;
  /** indentation of the list marker, for child-line ownership */
  indent: number;
}

/**
 * Fix completion stamps in-place:
 *  - freshly checked todo (no stamp yet) -> append `dHH:MM`
 *  - unchecked item with a stale trailing stamp -> remove it, so a later
 *    re-check gets a fresh timestamp
 *
 * Everything happens in one mutation pass so callers can persist with a
 * single vault write. Returns true if any line changed.
 */
export function fixTaskLines(
  lines: string[],
  tasks: TaskLine[],
  settings: NautilusSettings,
  nowMin: number
): boolean {
  let dirty = false;
  for (const t of tasks) {
    if (t.checked === false && hasTrailingDoneTime(t.text)) {
      lines[t.line] = stripTrailingDoneTime(lines[t.line]);
      dirty = true;
    } else if (
      settings.stampOnCheck &&
      t.checked === true &&
      !hasDoneTime(t.text)
    ) {
      const ev = parseRowParams(t.text, true, t.line, settings);
      if (ev && ev.todo) {
        lines[t.line] = lines[t.line] + ` d${minutesToTime(nowMin)}`;
        dirty = true;
      }
    }
  }
  return dirty;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h < 10 ? "0" + h : h}:${m < 10 ? "0" + m : m}`;
}

function checkBox(line: string): string {
  return line.replace(/^(\s*[-*+]\s+)\[ \]/, "$1[x]");
}

function uncheckBox(line: string): string {
  return line.replace(/^(\s*[-*+]\s+)\[[xX]\]/, "$1[ ]");
}

/**
 * Increment the `dXX%` progress marker of a task line.
 * At exactly 100% the task is checked off and gets a `dHH:MM` timestamp.
 */
export function bumpProgressInLine(line: string, increment: number, nowMin: number): string {
  const m = line.match(PROGRESS_RE);
  if (m) {
    const p = parseInt(m[2], 10) + increment;
    if (p === 100) {
      return checkBox(line.replace(m[0], "")) + ` d${minutesToTime(nowMin)}`;
    }
    if (p > 100) {
      return line.replace(m[0], "");
    }
    return line.replace(m[0], ` d${p}%`);
  }
  // no progress yet: start at `increment`%, un-check, drop any done-time stamp
  return uncheckBox(line + ` d${increment}%`)
    .replace(INLINE_DONE_TIME_RE, "")
    .replace(/\s{2,}/g, " ");
}
