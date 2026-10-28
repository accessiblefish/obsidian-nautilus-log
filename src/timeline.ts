import { NautEvent } from "./types";

export interface TimeSegment {
  start: number;
  end: number;
}

export interface AvailableSlot extends TimeSegment {
  key: string;
  duration: number;
  availableNow: boolean;
  segments: TimeSegment[];
}

type Interval = [number, number];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function mergeIntervals(intervals: (Interval | null)[]): Interval[] {
  const sorted = intervals
    .filter((interval): interval is Interval => interval !== null)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }
  return merged;
}

/** Split elapsed time into the same sectors as the spiral's hourly grid. */
export function pastTimelineSegments(
  startMinutes: number,
  endMinutes: number,
  nowMinutes: number
): TimeSegment[] {
  if (endMinutes <= startMinutes || nowMinutes <= startMinutes) return [];
  const elapsedEnd = Math.min(endMinutes, nowMinutes);
  const segments: TimeSegment[] = [];
  for (let start = startMinutes; start < elapsedEnd; start += 60) {
    segments.push({ start, end: Math.min(start + 60, elapsedEnd) });
  }
  return segments;
}

/** Elapsed intervals with no recorded task, event, or Actual CLOCK arc. */
export function pastUnplannedSegments({
  startMinutes,
  endMinutes,
  nowMinutes,
  occupiedEvents = [],
}: {
  startMinutes: number;
  endMinutes: number;
  nowMinutes: number;
  occupiedEvents?: NautEvent[];
}): TimeSegment[] {
  if (endMinutes <= startMinutes || nowMinutes <= startMinutes) return [];
  const elapsedEnd = Math.min(endMinutes, nowMinutes);
  const occupied = mergeIntervals(
    occupiedEvents
      .filter((event) => !event.freetime)
      .map((event) => {
        if (event.end <= event.start) return null;
        const start = clamp(event.start, startMinutes, elapsedEnd);
        const end = clamp(event.end, startMinutes, elapsedEnd);
        return end > start ? [start, end] : null;
      })
  );
  const gaps: Interval[] = [];
  let cursor = startMinutes;
  for (const [start, end] of occupied) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < elapsedEnd) gaps.push([cursor, elapsedEnd]);

  const cells = pastTimelineSegments(startMinutes, endMinutes, elapsedEnd);
  return gaps.reduce<TimeSegment[]>(
    (segments, [gapStart, gapEnd]) =>
      segments.concat(
        cells
          .map((cell) => ({
            start: Math.max(gapStart, cell.start),
            end: Math.min(gapEnd, cell.end),
          }))
          .filter((segment) => segment.end > segment.start)
      ),
    []
  );
}

function splitAtHourBoundaries(start: number, end: number): TimeSegment[] {
  const segments: TimeSegment[] = [];
  let cursor = start;
  while (cursor < end) {
    const nextHour = (Math.floor(cursor / 60) + 1) * 60;
    const segmentEnd = Math.min(end, nextHour);
    segments.push({ start: cursor, end: segmentEnd });
    cursor = segmentEnd;
  }
  return segments;
}

/** Convert scheduler free-time rows into logical, focusable hover targets. */
export function availableSlotGroups({
  events = [],
  startMinutes,
  endMinutes,
  nowMinutes,
  clampToNow = false,
}: {
  events?: NautEvent[];
  startMinutes: number;
  endMinutes: number;
  nowMinutes: number;
  clampToNow?: boolean;
}): AvailableSlot[] {
  if (endMinutes <= startMinutes) return [];
  const cursor = clampToNow
    ? clamp(nowMinutes, startMinutes, endMinutes)
    : startMinutes;
  const freeIntervals = mergeIntervals(
    events
      .filter((event) => event.freetime)
      .map((event) => {
        if (event.end <= event.start) return null;
        const start = clamp(event.start, startMinutes, endMinutes);
        const end = clamp(event.end, startMinutes, endMinutes);
        return end > start ? [start, end] : null;
      })
  );
  return freeIntervals.reduce<AvailableSlot[]>((slots, [slotStart, slotEnd]) => {
    const visibleStart = clampToNow ? Math.max(slotStart, cursor) : slotStart;
    if (slotEnd <= visibleStart) return slots;
    slots.push({
      key: `slot:${visibleStart}:${slotEnd}`,
      start: visibleStart,
      end: slotEnd,
      duration: slotEnd - visibleStart,
      availableNow:
        clampToNow && nowMinutes >= slotStart && nowMinutes < slotEnd,
      segments: splitAtHourBoundaries(visibleStart, slotEnd),
    });
    return slots;
  }, []);
}
