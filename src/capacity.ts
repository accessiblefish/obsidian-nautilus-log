import { alignIntervalToWindow } from "./scheduler";
import { NautEvent } from "./types";

export type CapacityBucket = "available" | "events" | null;
export type CapacityTone = "neutral" | "positive" | "warning" | "event";

export interface Capacity {
  availableMinutes: number;
  demandMinutes: number;
  overloadMinutes: number;
  slackMinutes: number;
  unplacedMinutes: number;
  fixedMinutes: number;
  totalAvailableMinutes?: number;
  totalFixedMinutes?: number;
  burningBucket: CapacityBucket;
  scheduledTasks: NautEvent[];
  overflowTasks: NautEvent[];
}

export interface CapacityMetric {
  key: string;
  label: string;
  value: string;
  summaryLabel?: string;
  total?: string;
  tone: CapacityTone;
  burning?: boolean;
  burningLabel?: string;
}

export interface CapacityMetrics {
  planned: CapacityMetric & {
    summaryLabel: string;
    percent: string;
    percentLabel: string;
    percentTone: CapacityTone;
  };
  status: CapacityMetric & { summaryLabel: string };
  available: CapacityMetric;
  events: CapacityMetric;
}

interface CapacityInput {
  startMinutes: number;
  endMinutes: number;
  nowMinutes: number;
  fixedEvents?: NautEvent[];
  allFixedEvents?: NautEvent[];
  pendingTasks?: NautEvent[];
}

type Interval = [number, number];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function normalizedInterval(
  event: NautEvent,
  windowStart: number,
  windowEnd: number,
  clipStart = windowStart,
  includeDone = false
): Interval | null {
  if ((!includeDone && event.done) || !event.meeting) return null;
  const [alignedStart, alignedEnd] = alignIntervalToWindow(
    event.start,
    event.end,
    windowStart,
    windowEnd
  );
  if (!Number.isFinite(alignedStart) || !Number.isFinite(alignedEnd) || alignedEnd <= alignedStart) {
    return null;
  }
  const start = Math.max(clipStart, alignedStart);
  const end = Math.min(windowEnd, alignedEnd);
  return end > start ? [start, end] : null;
}

function mergeIntervals(intervals: (Interval | null)[]): Interval[] {
  const sorted = intervals
    .filter((interval): interval is Interval => interval !== null)
    .map(([start, end]) => [start, end] as Interval)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

const intervalMinutes = (intervals: Interval[]): number =>
  intervals.reduce((total, [start, end]) => total + Math.max(0, end - start), 0);

/** Parsed durations already include progress; never apply progress twice. */
function remainingDuration(task: NautEvent): number {
  if (task.done || !Number.isFinite(task.duration) || task.duration <= 0) return 0;
  return Math.round(task.duration);
}

function burningCapacityBucket(
  startMinutes: number,
  endMinutes: number,
  nowMinutes: number,
  fixedEvents: NautEvent[]
): CapacityBucket {
  if (nowMinutes < startMinutes || nowMinutes >= endMinutes) return null;
  return fixedEvents.some((event) => {
    const interval = normalizedInterval(event, startMinutes, endMinutes);
    return interval && nowMinutes >= interval[0] && nowMinutes < interval[1];
  })
    ? "events"
    : "available";
}

/**
 * Calculate the same remaining/full-day time budgets shown above the original
 * Roam spiral. Fixed events are clipped to the plan window and overlapping
 * events count only once.
 */
export function calculateCapacity({
  startMinutes,
  endMinutes,
  nowMinutes,
  fixedEvents = [],
  allFixedEvents = fixedEvents,
  pendingTasks = [],
}: CapacityInput): Capacity {
  const validWindow = endMinutes > startMinutes;
  const cursor = validWindow
    ? clamp(nowMinutes, startMinutes, endMinutes)
    : startMinutes;
  const futureFixed = validWindow
    ? mergeIntervals(
        fixedEvents.map((event) =>
          normalizedInterval(event, startMinutes, endMinutes, cursor)
        )
      )
    : [];
  const totalFixed = validWindow
    ? mergeIntervals(
        allFixedEvents.map((event) =>
          normalizedInterval(event, startMinutes, endMinutes, startMinutes, true)
        )
      )
    : [];
  const fixedMinutes = intervalMinutes(futureFixed);
  const totalFixedMinutes = intervalMinutes(totalFixed);
  const availableMinutes = Math.max(0, endMinutes - cursor - fixedMinutes);
  const totalAvailableMinutes = Math.max(
    0,
    (validWindow ? endMinutes - startMinutes : 0) - totalFixedMinutes
  );
  const demandMinutes = pendingTasks.reduce(
    (total, task) => total + remainingDuration(task),
    0
  );

  // Greedily place atomic tasks into continuous gaps. Aggregate slack can be
  // positive while a task still has no single slot large enough to fit.
  const scheduledTasks: NautEvent[] = [];
  const overflowTasks: NautEvent[] = [];
  let scheduleCursor = cursor;
  for (const task of pendingTasks) {
    const duration = remainingDuration(task);
    if (!duration) continue;
    let placed = false;
    while (scheduleCursor < endMinutes && !placed) {
      const fixed = futureFixed.find(([, fixedEnd]) => fixedEnd > scheduleCursor);
      if (!fixed) {
        if (scheduleCursor + duration <= endMinutes) {
          scheduledTasks.push({
            ...task,
            duration,
            start: scheduleCursor,
            end: scheduleCursor + duration,
          });
          scheduleCursor += duration;
          placed = true;
        } else {
          scheduleCursor = endMinutes;
        }
        continue;
      }
      const [fixedStart, fixedEnd] = fixed;
      if (fixedStart > scheduleCursor && scheduleCursor + duration <= fixedStart) {
        scheduledTasks.push({
          ...task,
          duration,
          start: scheduleCursor,
          end: scheduleCursor + duration,
        });
        scheduleCursor += duration;
        placed = true;
      } else {
        scheduleCursor = Math.max(scheduleCursor, fixedEnd);
      }
    }
    if (!placed) overflowTasks.push({ ...task, duration });
  }

  const unplacedMinutes = overflowTasks.reduce(
    (total, task) => total + remainingDuration(task),
    0
  );
  return {
    availableMinutes,
    demandMinutes,
    overloadMinutes: Math.max(0, demandMinutes - availableMinutes),
    slackMinutes: Math.max(0, availableMinutes - demandMinutes),
    unplacedMinutes,
    fixedMinutes,
    totalAvailableMinutes,
    totalFixedMinutes,
    burningBucket: validWindow
      ? burningCapacityBucket(startMinutes, endMinutes, nowMinutes, fixedEvents)
      : null,
    scheduledTasks,
    overflowTasks,
  };
}

export function formatCapacityDuration(minutes: number): string {
  const value = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0));
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  if (!hours) return `${remainder}m`;
  if (!remainder) return `${hours}h`;
  return `${hours}h${String(remainder).padStart(2, "0")}m`;
}

/** Project raw time budgets into the original two-row header model. */
export function capacityMetrics(capacity: Capacity): CapacityMetrics {
  const availableMinutes = Math.max(0, capacity.availableMinutes || 0);
  const demandMinutes = Math.max(0, capacity.demandMinutes || 0);
  const freeMinutes = Math.max(0, availableMinutes - demandMinutes);
  const fullDayAvailable =
    capacity.totalAvailableMinutes != null && capacity.totalAvailableMinutes > 0
      ? capacity.totalAvailableMinutes
      : availableMinutes;
  const roundedPercent =
    fullDayAvailable > 0 ? Math.round((freeMinutes / fullDayAvailable) * 100) : 0;
  const percentValue = Math.min(
    100,
    freeMinutes > 0 ? Math.max(1, roundedPercent) : 0
  );
  const warning = capacity.overloadMinutes > 0 || capacity.unplacedMinutes > 0;
  const percentTone: CapacityTone = warning
    ? "warning"
    : freeMinutes > 0
    ? "positive"
    : "neutral";

  const available: CapacityMetric = {
    key: "available",
    label: "Available",
    value: formatCapacityDuration(availableMinutes),
    tone: "neutral",
    ...(capacity.totalAvailableMinutes != null
      ? { total: formatCapacityDuration(capacity.totalAvailableMinutes) }
      : {}),
    ...(capacity.burningBucket === "available"
      ? { burning: true, burningLabel: "Flexible time is elapsing" }
      : {}),
  };
  const events: CapacityMetric = {
    key: "events",
    label: "Events",
    value: formatCapacityDuration(capacity.fixedMinutes),
    tone: "event",
    ...(capacity.totalFixedMinutes != null
      ? { total: formatCapacityDuration(capacity.totalFixedMinutes) }
      : {}),
    ...(capacity.burningBucket === "events"
      ? { burning: true, burningLabel: "Event time is elapsing" }
      : {}),
  };
  const planned: CapacityMetrics["planned"] = {
    key: "demand",
    label: "Planned",
    value: formatCapacityDuration(demandMinutes),
    summaryLabel: "planned",
    percent: `${percentValue}%`,
    percentLabel: "left",
    percentTone,
    tone: "neutral",
  };
  let status: CapacityMetrics["status"];
  if (capacity.overloadMinutes > 0) {
    status = {
      key: "overload",
      label: "Overload",
      value: formatCapacityDuration(capacity.overloadMinutes),
      summaryLabel: "over",
      tone: "warning",
    };
  } else if (capacity.unplacedMinutes > 0) {
    status = {
      key: "fragmented",
      label: "No fitting slot",
      value: formatCapacityDuration(capacity.unplacedMinutes),
      summaryLabel: "no slot",
      tone: "warning",
    };
  } else {
    status = {
      key: "remaining",
      label: "Remaining",
      value: formatCapacityDuration(freeMinutes),
      summaryLabel: "free",
      tone: freeMinutes > 0 ? "positive" : "neutral",
    };
  }
  return { planned, status, available, events };
}
