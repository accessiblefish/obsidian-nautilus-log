import { NautEvent } from "./types";
import { WORKDAY_END } from "./geometry";

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
 * The heart of Nautilus: lay meetings at their fixed times and greedily
 * place flexible todos into the free gaps after `planFromTime`
 * (usually "now"). Faithful port of fill-day.
 */
export function fillDay(
  events: NautEvent[],
  workdayStart: number,
  planFromTime: number
): NautEvent[] {
  const sorted = [...events].sort((a, b) => {
    const ka = a.meeting ? a.start : 0;
    const kb = b.meeting ? b.start : 0;
    return ka - kb;
  });
  const todos = sorted.filter((e) => e.todo && !e.done);
  const meetings = sorted.filter((e) => e.meeting);

  const result: NautEvent[] = [];
  let time = workdayStart;
  let ti = 0;
  let mi = 0;

  const freetime = (start: number, end: number): NautEvent => ({
    description: "",
    progress: 0,
    duration: end - start,
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
      result.push(freetime(time, WORKDAY_END));
      break;
    }
    if (time < planFromTime) {
      time = Math.max(time, workdayStart);
      const nm = meetings[mi];
      if (nm) {
        if (nm.start > time) {
          result.push(freetime(time, Math.min(planFromTime, nm.start)));
          time = Math.min(planFromTime, nm.start);
        } else {
          result.push(nm);
          time = nm.end;
          mi++;
        }
      } else {
        result.push(freetime(time, planFromTime));
        time = planFromTime;
      }
    } else {
      time = Math.max(time, workdayStart);
      const nt = todos[ti];
      const nm = meetings[mi];
      if (nm) {
        if (nm.start > time) {
          if (
            nt &&
            time + nt.duration < nm.start &&
            nt.startAfter <= time
          ) {
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
        result.push({ ...nt, start: time, end: time + nt.duration });
        time += nt.duration;
        ti++;
      } else {
        // exhaust both lists; next iteration appends the closing freetime
        ti = todos.length;
        mi = meetings.length;
      }
    }
  }
  return result;
}
