import { NautEvent } from "./types";

/**
 * Tags every todo with the end time of the meeting that precedes it in
 * list order, so it cannot be scheduled before that meeting.
 */
export function addStartAfter(events: NautEvent[]): NautEvent[] {
  let startAfter = 0;
  return events.map((e) => {
    if (e.meeting) {
      startAfter = e.end;
      return e;
    }
    if (e.todo) return { ...e, startAfter };
    return e;
  });
}

/**
 * Place a wall-clock interval on the continuous timeline of a plan window.
 * Early-morning times belong to the next-day portion when that placement
 * overlaps an overnight window. Ported from alignIntervalToWindow.
 */
export function alignIntervalToWindow(
  start: number,
  end: number,
  windowStart: number,
  windowEnd: number
): [number, number] {
  if (end <= start || windowEnd <= windowStart) return [start, end];
  const overlap = (s: number, e: number) =>
    Math.max(0, Math.min(e, windowEnd) - Math.max(s, windowStart));
  const candidates: [number, number][] = [
    [start, end],
    [start + 1440, end + 1440],
  ];
  const best = candidates.sort(
    (a, b) =>
      overlap(b[0], b[1]) - overlap(a[0], a[1]) ||
      Math.abs(a[0] - windowStart) - Math.abs(b[0] - windowStart)
  )[0];
  return overlap(best[0], best[1]) > 0 ? best : [start, end];
}

export interface DayPlan {
  /** meetings + placed todos + freetime gaps, in time order */
  scheduled: NautEvent[];
  /** todos that cannot fit into the workday window */
  overflow: NautEvent[];
}

/**
 * The heart of Nautilus: lay meetings at their fixed times and greedily
 * place flexible todos into the free gaps after `planFromTime`
 * (usually "now"). Meetings are aligned into the window (which may cross
 * midnight) and clamped to its edges; todos that fit nowhere are returned
 * as overflow instead of being silently dropped.
 */
export function fillDay(
  events: NautEvent[],
  workdayStart: number,
  workdayEnd: number,
  planFromTime: number
): DayPlan {
  const meetings = events
    .filter((e) => e.meeting)
    .map((e) => {
      const [s, en] = alignIntervalToWindow(e.start, e.end, workdayStart, workdayEnd);
      return { ...e, start: Math.max(s, workdayStart), end: Math.min(en, workdayEnd) };
    })
    .filter((e) => e.start < e.end)
    .sort((a, b) => a.start - b.start);
  const todos = events.filter((e) => e.todo && !e.done);

  const result: NautEvent[] = [];
  const overflow: NautEvent[] = [];
  const planFrom = Math.min(Math.max(planFromTime, workdayStart), workdayEnd);
  let time = workdayStart;
  let ti = 0;
  let mi = 0;

  const freetime = (start: number, end: number): NautEvent => ({
    description: "",
    progress: 0,
    duration: end - start,
    estimate: end - start,
    line: -1,
    start,
    end,
    done: false,
    bgColor: null,
    doneAt: null,
    meeting: false,
    todo: false,
    freetime: true,
    startAfter: 0,
  });

  for (;;) {
    if (ti >= todos.length && mi >= meetings.length) {
      if (time < workdayEnd) result.push(freetime(time, workdayEnd));
      break;
    }
    if (time < planFrom) {
      const nm = meetings[mi];
      if (nm) {
        if (nm.start > time) {
          result.push(freetime(time, Math.min(planFrom, nm.start)));
          time = Math.min(planFrom, nm.start);
        } else {
          result.push(nm);
          time = nm.end;
          mi++;
        }
      } else {
        result.push(freetime(time, planFrom));
        time = planFrom;
      }
    } else {
      const nt = todos[ti];
      const nm = meetings[mi];
      if (nm) {
        if (nm.start > time) {
          if (nt && time + nt.duration < nm.start && nt.startAfter <= time) {
            result.push({ ...nt, start: time, end: time + nt.duration });
            time += nt.duration;
            ti++;
          } else {
            result.push(freetime(time, nm.start));
            time = nm.start;
          }
        } else {
          result.push(nm);
          time = nm.end;
          mi++;
        }
      } else if (nt) {
        if (time + nt.duration <= workdayEnd) {
          result.push({ ...nt, start: time, end: time + nt.duration });
          time += nt.duration;
        } else {
          overflow.push(nt);
        }
        ti++;
      } else {
        // exhaust both lists; next iteration appends the closing freetime
        ti = todos.length;
        mi = meetings.length;
      }
    }
  }
  return { scheduled: result, overflow };
}
