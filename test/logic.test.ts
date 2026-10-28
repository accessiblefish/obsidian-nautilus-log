import { DEFAULT_SETTINGS, NautEvent, workdayWindow } from "../src/types";
import { parseRowParams, bumpProgressInLine, hasDoneTime, hasTrailingDoneTime, stripTrailingDoneTime, fixTaskLines, TaskLine } from "../src/parser";
import { addStartAfter, alignIntervalToWindow, fillDay } from "../src/scheduler";
import {
  actualMinutesInWindow,
  buildDailyReview,
  clockEntriesForTask,
  clockInTask,
  closeClockIfOwnerDone,
  closeClockLine,
  fixClockDurations,
  fixClockLineDuration,
  findOpenClock,
  formatClockLine,
  lastClockEndMs,
  parseClockLine,
} from "../src/timing";
import { minToAngle, posSweepAngle, angleToRad, iterateRectPlace, spiralProfileIndex, spiralCellInnerIndex } from "../src/geometry";
import { formatDate, parseDateStrict } from "../src/datefmt";
import { createTidyEdit, restoreTidyEdit, settledTaskLines } from "../src/tidy";
import { calculateCapacity, capacityMetrics } from "../src/capacity";
import { availableSlotGroups, pastTimelineSegments, pastUnplannedSegments } from "../src/timeline";
import { appendTaskLog, readTaskLogs, resolveDeskTask } from "../src/log";
import { buildTaskNoteContent, sanitizeTaskFileName, syncTaskNoteContent } from "../src/task-note";

let failures = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const S = { ...DEFAULT_SETTINGS };

// ---- parsers ----
const e1 = parseRowParams("12:30-14:00 Lunch meeting", false, 0, S)!;
eq("meeting range", [e1.start, e1.end, e1.meeting, e1.description], [750, 840, true, "Lunch meeting"]);

const e2 = parseRowParams("Read a book 30m", false, 1, S)!;
eq("todo duration", [e2.todo, e2.duration, e2.description], [true, 30, "Read a book"]);

const e3 = parseRowParams("Write report", false, 2, S)!;
eq("default duration", e3.duration, 30);

const e4 = parseRowParams("9-11am Standup", false, 3, S)!;
eq("am range", [e4.start, e4.end], [540, 660]);

const e5 = parseRowParams("1-3pm Review", false, 4, S)!;
eq("pm propagation to from-side", [e5.start, e5.end], [780, 900]);

const e6 = parseRowParams("Call 45m d50%", false, 5, S)!;
eq("progress scales duration", [e6.progress, e6.duration], [50, 23]);

const e7 = parseRowParams("Done thing d13:20", true, 6, S)!;
eq("done todo with timestamp", [e7.done, e7.doneAt, e7.start, e7.end], [true, 800, 770, 800]);

const e8 = parseRowParams("Workout 1h", false, 7, S)!;
eq("hour duration", e8.duration, 60);

const e8b = parseRowParams("Deep work 1h30m", false, 7, S)!;
eq("compound duration 1h30m", [e8b.duration, e8b.description], [90, "Deep work"]);

const e8c = parseRowParams("Deep work 1h30min", false, 7, S)!;
eq("compound duration 1h30min", e8c.duration, 90);

const e8d = parseRowParams("Reading 30min", false, 7, S)!;
eq("min suffix duration", [e8d.duration, e8d.description], [30, "Reading"]);

const e8e = parseRowParams("Focus 2h", false, 7, S)!;
eq("2h duration", e8e.duration, 120);

const e9 = parseRowParams("Ship it [[Project X]] **today**", false, 8, S)!;
eq("wiki/bold strip", e9.description, "Ship it Project X today");

eq("empty desc skipped", parseRowParams("30m", false, 9, S), null);
const overnightRange = parseRowParams("22:00-02:00 Night", false, 9, S)!;
eq("overnight range stays continuous", [overnightRange.start, overnightRange.end, overnightRange.warning], [1320, 1560, "Continues into the next day"]);
const sameTimeRange = parseRowParams("10:00-10:00 Invalid", false, 9, S)!;
eq("same-time range carries warning", [sameTimeRange.start, sameTimeRange.end, sameTimeRange.warning], [600, 600, "Start and end times cannot be the same"]);

// ---- bumpProgressInLine ----
eq("start progress", bumpProgressInLine("- [ ] Task", 10, 600), "- [ ] Task d10%");
eq("inc progress", bumpProgressInLine("- [ ] Task d10%", 10, 600), "- [ ] Task d20%");
eq("complete at 100", bumpProgressInLine("- [ ] Task d90%", 10, 600), "- [x] Task d10:00");
eq("undo starts progress", bumpProgressInLine("- [x] Task d09:30", 10, 600), "- [ ] Task d10%");

// ---- done-time stamp helpers ----
eq("hasDoneTime mid-text", hasDoneTime("Task d13:20"), true);
eq("hasDoneTime absent", hasDoneTime("Task"), false);
eq("trailing stamp detected", hasTrailingDoneTime("Task d09:30"), true);
eq("mid-text stamp not trailing", hasTrailingDoneTime("Task d09:30 notes"), false);
eq("strip trailing stamp", stripTrailingDoneTime("- [ ] Task d09:30"), "- [ ] Task");

// ---- false-positive guards ----
eq("d2 章 is not a stamp", hasDoneTime("读完 d2 章"), false);
eq("bare d7 is not a stamp", hasDoneTime("Task d7"), false);
eq("d25:00 invalid hour", hasDoneTime("Task d25:00"), false);
eq("d13:99 invalid minute", hasDoneTime("Task d13:99"), false);
const fp = parseRowParams("读 2-3 章 30m", false, 0, S)!;
eq("2-3 章 is not a meeting", [fp.meeting, fp.todo, fp.duration, fp.description], [false, true, 30, "读 2-3 章"]);
const fp2 = parseRowParams("9-11am Standup", false, 1, S)!;
eq("am range still works", [fp2.meeting, fp2.start, fp2.end], [true, 540, 660]);
const fp3 = parseRowParams("12:30-14:00 Lunch", false, 2, S)!;
eq("colon range still works", [fp3.meeting, fp3.start, fp3.end], [true, 750, 840]);

// ---- geometry ----
eq("9:00 -> 0deg", minToAngle(540), 0);
eq("21:00 -> 0deg", minToAngle(1260), 0);
eq("15:00 -> 180deg", minToAngle(900), 180);
eq("sweep", posSweepAngle(angleToRad(0), angleToRad(30)).toFixed(4), (Math.PI / 6).toFixed(4));

// legend placement never collides trivially
const r = iterateRectPlace({ w: 100, h: 16, x: 0, y: 0, radians: 0, realRadians: 0 }, [], 0.5, 180, { cx: 300, cy: 210 });
eq("legend placed", typeof r.x, "number");

// ---- scheduler ----
const mk = (over: Partial<NautEvent>): NautEvent => ({
  description: "x", progress: 0, duration: 15, estimate: 15, line: 0, start: 0, end: 0,
  done: false, bgColor: null, doneAt: null, meeting: false, todo: true,
  freetime: false, startAfter: 0, ...over,
});

// meetings anchor, todos flow after now
const day = fillDay(
  addStartAfter([
    mk({ description: "todoA", duration: 30 }),
    mk({ description: "mtg", meeting: true, todo: false, start: 780, end: 840 }),
    mk({ description: "todoB", duration: 20 }),
  ]),
  480,
  1320,
  600 // "now" = 10:00
).scheduled;
const slim = day.map((d) => [d.description || "free", d.start, d.end]);
eq(
  "fill-day pushes todos after now",
  slim,
  [
    ["free", 480, 600],
    ["todoA", 600, 630],
    ["free", 630, 780],
    ["mtg", 780, 840],
    ["todoB", 840, 860],
    ["free", 860, 1320],
  ]
);

const exactFit = fillDay(
  addStartAfter([
    mk({ description: "exact", duration: 60 }),
    mk({ description: "mtg", meeting: true, todo: false, start: 660, end: 720 }),
  ]),
  600,
  1200,
  600
);
eq("task exactly filling a gap is schedulable", exactFit.overflow, []);
eq("exact-fit task uses the whole gap", [
  exactFit.scheduled[0].description,
  exactFit.scheduled[0].start,
  exactFit.scheduled[0].end,
], ["exact", 600, 660]);

// todoB would fit before the meeting only if startAfter allows
const day2 = fillDay(
  addStartAfter([
    mk({ description: "mtg", meeting: true, todo: false, start: 780, end: 840 }),
    mk({ description: "todoAfter", duration: 20 }),
  ]),
  480,
  1320,
  600
).scheduled;
const slim2 = day2.map((d) => [d.description || "free", d.start, d.end]);
eq(
  "todo after meeting cannot jump before it",
  slim2,
  [
    ["free", 480, 600],
    ["free", 600, 780],
    ["mtg", 780, 840],
    ["todoAfter", 840, 860],
    ["free", 860, 1320],
  ]
);

// actual CLOCK arcs block planned placement (playback lays the plan out
// from the workday start; pending todos must not land on tracked time)
const blockers = [
  mk({ description: "arcA", meeting: true, todo: false, actual: true, noLegend: true, start: 590, end: 640 }),
];
const replay = fillDay(
  [
    mk({ description: "todoA", duration: 60 }),
    mk({ description: "todoB", duration: 120 }),
    ...blockers,
  ],
  420,
  1320,
  0 // playback: plan from the workday start
).scheduled;
const slimReplay = replay.map((d) => [d.description || "free", d.start, d.end]);
eq(
  "playback plan flows around actual arcs",
  slimReplay,
  [
    ["todoA", 420, 480],
    ["free", 480, 590],
    ["arcA", 590, 640],
    ["todoB", 640, 760],
    ["free", 760, 1320],
  ]
);
eq(
  "blockers filtered back out of the schedule",
  replay.filter((e) => !e.actual).map((d) => d.description || "free"),
  ["todoA", "free", "todoB", "free"]
);

// ---- overnight window ----
eq("window end after start", workdayWindow({ ...S, workdayStart: 480, workdayEnd: 1320 }), [480, 1320]);
eq("window crosses midnight", workdayWindow({ ...S, workdayStart: 1200, workdayEnd: 120 }), [1200, 1560]);
eq("midnight end stays", workdayWindow({ ...S, workdayStart: 1200, workdayEnd: 1440 }), [1200, 1440]);

// early-morning meeting aligns into an overnight window
eq("align 01:00-02:00 into 20:00-26:00", alignIntervalToWindow(60, 120, 1200, 1560), [1500, 1560]);
eq("align lunch stays same-day", alignIntervalToWindow(750, 840, 480, 1320), [750, 840]);

// overnight fillDay: meetings past 24:00 anchor, todos fill after, tail caps at window end
const night = fillDay(
  addStartAfter([
    mk({ description: "late mtg", meeting: true, todo: false, start: 60, end: 120 }), // 01:00-02:00
    mk({ description: "night todo", duration: 30 }),
  ]),
  1200,
  1560,
  1260 // 21:00
);
const slimNight = night.scheduled.map((d) => [d.description || "free", d.start, d.end]);
eq("overnight fill-day", slimNight, [
  ["free", 1200, 1260],
  ["night todo", 1260, 1290],
  ["free", 1290, 1500],
  ["late mtg", 1500, 1560],
]);

// overflow: a todo that cannot fit before the window end is reported
const packed = fillDay(
  addStartAfter([mk({ description: "huge", duration: 600 })]),
  480,
  1320,
  1260 // 21:00, only 60 min left
);
eq("overflow reported", packed.overflow.map((e) => e.description), ["huge"]);
eq("no tail freetime past end", packed.scheduled[packed.scheduled.length - 1].end, 1320);

// ---- spiral profile (anchored to workday start) ----
eq("profile at start", spiralProfileIndex(480, 480), 5);
eq("profile 3h in", spiralProfileIndex(660, 480), 8);
eq("profile before start clamps", spiralProfileIndex(100, 480), 5);
eq("profile far future clamps", spiralProfileIndex(480 + 40 * 60, 480), 28);
eq("cell pair inside window", spiralCellInnerIndex(480, 1320, 480), 17);
eq("cell pair beyond window", spiralCellInnerIndex(720, 1320, 480), null);

// ---- fixTaskLines: stamp + move-to-bottom ----
const tl = (line: number, text: string, checked: boolean | null): TaskLine => ({ line, text, checked, indent: 0 });
{
  // NB: in the real flow Obsidian has already flipped the checkbox when we
  // run; lines contain `- [x]` and we only append the stamp
  const lines = ["```nautilus", "```", "", "- 09:00-10:00 mtg", "- [x] a 30m", "- [ ] b 30m", "- [ ] c 30m"];
  const tasks = [tl(3, "09:00-10:00 mtg", null), tl(4, "a 30m", true), tl(5, "b 30m", false), tl(6, "c 30m", false)];
  const dirty = fixTaskLines(lines, tasks, S, 600);
  eq("fresh check is dirty", dirty, true);
  eq("checked task stamped in place", lines, [
    "```nautilus", "```", "", "- 09:00-10:00 mtg", "- [x] a 30m d10:00", "- [ ] b 30m", "- [ ] c 30m",
  ]);
  // second pass: already done with stamp -> no further churn
  const tasks2 = [tl(3, "09:00-10:00 mtg", null), tl(4, "a 30m d10:00", true), tl(5, "b 30m", false), tl(6, "c 30m", false)];
  eq("already-done stays put", fixTaskLines(lines, tasks2, S, 601), false);
  eq("already-done lines unchanged", lines[4], "- [x] a 30m d10:00");
}
{
  // unchecking removes the stamp in place
  const lines = ["- [ ] b 30m", "- [ ] c 30m", "- [ ] a 30m d10:00"];
  const tasks = [tl(0, "b 30m", false), tl(1, "c 30m", false), tl(2, "a 30m d10:00", false)];
  eq("uncheck strips stamp", fixTaskLines(lines, tasks, S, 700), true);
  eq("unstamped in place", lines, ["- [ ] b 30m", "- [ ] c 30m", "- [ ] a 30m"]);
}

// ---- timing: CLOCK lines ----
const D = (h: number, m: number) => new Date(2026, 7, 26, h, m, 0, 0);
{
  const open = formatClockLine(D(10, 0));
  eq("open clock format", open, "CLOCK: [2026-08-26 Wed 10:00]");
  const closed = formatClockLine(D(10, 0), D(10, 18));
  eq("closed clock format", closed, "CLOCK: [2026-08-26 Wed 10:00]--[2026-08-26 Wed 10:18] => 0:18");
  const parsed = parseClockLine(`    - ${closed}`, 5)!;
  eq("parse closed clock", [parsed.running, parsed.minutes, parsed.line], [false, 18, 5]);
  eq("parse open clock running", parseClockLine(`  - ${open}`, 3)!.running, true);
}
{
  // clock-in: inserts an open CLOCK as a direct child (no LOGBOOK, ADR-0001);
  // switching closes the previous
  const lines = ["- [ ] Task A 30m", "- [ ] Task B 45m"];
  clockInTask(lines, 0, 0, D(10, 0));
  eq("clock-in inserts direct child clock", lines, [
    "- [ ] Task A 30m",
    "  - CLOCK: [2026-08-26 Wed 10:00]",
    "- [ ] Task B 45m",
  ]);
  clockInTask(lines, 2, 0, D(10, 30));
  eq("switch closes previous clock", lines[1], "  - CLOCK: [2026-08-26 Wed 10:00]--[2026-08-26 Wed 10:30] => 0:30");
  eq("new open clock under B", lines[3], "  - CLOCK: [2026-08-26 Wed 10:30]");
  const open = findOpenClock(lines)!;
  eq("open clock located", [open.clockLine, open.taskLine], [3, 2]);
  closeClockLine(lines, open.clockLine, D(11, 0));
  eq("clock out", lines[3], "  - CLOCK: [2026-08-26 Wed 10:30]--[2026-08-26 Wed 11:00] => 0:30");
  eq("no open clock left", findOpenClock(lines), null);
  const entries = clockEntriesForTask(lines, 0, 0);
  eq("entries of A", entries.length, 1);
  const day0 = new Date(2026, 7, 26, 0, 0, 0, 0).getTime();
  eq("actual minutes in window", actualMinutesInWindow(entries, day0, day0 + 1440 * 60000, D(12, 0).getTime()), 30);
  eq("last clock end", lastClockEndMs(entries), D(10, 30).getTime());
}
{
  // stale `=> h:mm` after a manual end-time edit gets repaired from the stamps
  const lines = [
    "- [ ] Task A 30m",
    "  - CLOCK: [2026-08-26 Wed 09:50]--[2026-08-26 Wed 10:40] => 1:01",
    "  - CLOCK: [2026-08-26 Wed 11:00]",
    "  - CLOCK: [2026-08-26 Wed 12:00]--[2026-08-26 Wed 12:20]",
  ];
  eq("fix stale clock duration", fixClockLineDuration(lines, 1), true);
  eq("stale duration repaired", lines[1], "  - CLOCK: [2026-08-26 Wed 09:50]--[2026-08-26 Wed 10:40] => 0:50");
  eq("correct duration untouched", fixClockLineDuration(lines, 1), false);
  eq("open clock untouched", fixClockLineDuration(lines, 2), false);
  eq("missing duration left alone", fixClockLineDuration(lines, 3), false);
  const file = [...lines, "    - CLOCK: [2026-08-26 Wed 13:00]--[2026-08-26 Wed 13:30] => 1:30"];
  eq("fixClockDurations scans whole file", fixClockDurations(file), true);
  eq("indented clock repaired", file[4], "    - CLOCK: [2026-08-26 Wed 13:00]--[2026-08-26 Wed 13:30] => 0:30");
  eq("nothing left to fix", fixClockDurations(file), false);
}
{
  // legacy LOGBOOK-wrapped entries still parse (read compatibility)
  const lines = [
    "- [x] Legacy 30m",
    "  - LOGBOOK::",
    "    - CLOCK: [2026-08-26 Wed 09:00]--[2026-08-26 Wed 09:40] => 0:40",
  ];
  const entries = clockEntriesForTask(lines, 0, 0);
  eq("legacy logbook entries parsed", entries.map((e) => e.minutes), [40]);
  // second clock-in appends after existing CLOCKs, without a drawer
  clockInTask(lines, 0, 0, D(10, 0));
  eq("clock-in after legacy entries", lines, [
    "- [x] Legacy 30m",
    "  - LOGBOOK::",
    "    - CLOCK: [2026-08-26 Wed 09:00]--[2026-08-26 Wed 09:40] => 0:40",
    "  - CLOCK: [2026-08-26 Wed 10:00]",
  ]);
  const open = findOpenClock(lines)!;
  eq("open clock owned by legacy task", open.taskLine, 0);
  // checking the owner task closes the running clock
  eq("close on check", closeClockIfOwnerDone(lines, new Set([0]), D(10, 25)), true);
  eq("clock closed at check time", lines[3], "  - CLOCK: [2026-08-26 Wed 10:00]--[2026-08-26 Wed 10:25] => 0:25");
  eq("no open clock after check", findOpenClock(lines), null);
  eq("no-op when owner not done", closeClockIfOwnerDone(lines, new Set(), D(10, 30)), false);
}
{
  // review states
  const day0 = new Date(2026, 7, 26, 0, 0, 0, 0).getTime();
  const win: [number, number] = [day0, day0 + 1440 * 60000];
  const lines = [
    "- [x] Done tracked 30m",
    "  - LOGBOOK::",
    "    - CLOCK: [2026-08-26 Wed 09:00]--[2026-08-26 Wed 09:40] => 0:40",
    "- [x] Done untracked 20m",
    "- [ ] Pending 15m",
  ];
  const review = buildDailyReview(
    [
      { line: 0, description: "Done tracked", done: true, plannedMinutes: 30 },
      { line: 3, description: "Done untracked", done: true, plannedMinutes: 20 },
      { line: 4, description: "Pending", done: false, plannedMinutes: 15 },
    ],
    new Map([[0, clockEntriesForTask(lines, 0, 0)]]),
    win[0],
    win[1],
    D(12, 0).getTime()
  );
  eq("review states", review.rows.map((r) => r.state), ["compared", "not-tracked", "not-started"]);
  eq("variance", review.rows[0].varianceMinutes, 10);
  eq("summary", [review.summary.plannedMinutes, review.summary.actualMinutes, review.summary.varianceMinutes], [30, 40, 10]);
}
{
  // a pending task with CLOCK time (paused) also gets a variance
  const day0 = new Date(2026, 7, 26, 0, 0, 0, 0).getTime();
  const lines = [
    "- [ ] Paused task 30m",
    "  - LOGBOOK::",
    "    - CLOCK: [2026-08-26 Wed 08:00]--[2026-08-26 Wed 08:50] => 0:50",
  ];
  const review = buildDailyReview(
    [{ line: 0, description: "Paused task", done: false, plannedMinutes: 30 }],
    new Map([[0, clockEntriesForTask(lines, 0, 0)]]),
    day0,
    day0 + 1440 * 60000,
    D(12, 0).getTime()
  );
  eq("paused task state", review.rows[0].state, "paused");
  eq("paused task variance", review.rows[0].varianceMinutes, 20);
}

// ---- Desk task notes ----
eq("task note filename removes reserved characters", sanitizeTaskFileName("A/B: Test?"), "A-B- Test");
eq("task note filename has a fallback", sanitizeTaskFileName("???"), "Untitled task");
{
  const task = { ...tl(0, "Write report 45m", false), description: "Write report", duration: 45 };
  const lines = [
    "- [ ] Write report 45m",
    "  - LOG: [2026-08-26 Wed 10:05] Completed outline",
    "  - CLOCK: [2026-08-26 Wed 09:00]",
  ];
  eq("task note lists only LOG and CLOCK above a writing divider", buildTaskNoteContent(lines, task), [
    "- LOG: [2026-08-26 Wed 10:05] Completed outline",
    "- CLOCK: [2026-08-26 Wed 09:00]",
    "",
    "---",
    "",
    "",
  ].join("\n"));
  eq("task note sync preserves user content below the divider", syncTaskNoteContent(
    "- LOG: [old] Old entry\n\n---\n\nMy detailed notes\n- keep this\n",
    [...lines, "  - LOG: [2026-08-26 Wed 10:06] New entry"],
    task
  ), [
    "- LOG: [2026-08-26 Wed 10:05] Completed outline",
    "- CLOCK: [2026-08-26 Wed 09:00]",
    "- LOG: [2026-08-26 Wed 10:06] New entry",
    "",
    "---",
    "\nMy detailed notes\n- keep this\n",
  ].join("\n"));
}

// ---- Desk MVP: task-bound LOG entries and safe task resolution ----
{
  const task = tl(0, "Write report 45m", false);
  const lines = [
    "- [ ] Write report 45m",
    "  - CLOCK: [2026-08-26 Wed 09:00]--[2026-08-26 Wed 09:20] => 0:20",
    "- [ ] Next task 30m",
  ];
  const edit = appendTaskLog(lines, task, "Completed outline", D(10, 5));
  eq("Desk log appends after existing task children", edit.lines, [
    "- [ ] Write report 45m",
    "  - CLOCK: [2026-08-26 Wed 09:00]--[2026-08-26 Wed 09:20] => 0:20",
    "  - LOG: [2026-08-26 Wed 10:05] Completed outline",
    "- [ ] Next task 30m",
  ]);
  eq("Desk log can be read back", readTaskLogs(edit.lines, task).map((entry) => entry.text), ["Completed outline"]);
  const next = tl(3, "Next task 30m", false);
  eq("Desk log inserts under a childless task", appendTaskLog(edit.lines, next, "Started", D(10, 6)).lines[4], "  - LOG: [2026-08-26 Wed 10:06] Started");
  eq("Desk resolves a moved task by its content", resolveDeskTask(
    [tl(0, "Another task", false), tl(1, "Write report 45m", false)],
    task
  )?.line, 1);
  eq("Desk rejects ambiguous duplicate tasks", resolveDeskTask(
    [tl(0, "Write report 45m", false), tl(1, "Write report 45m", false)],
    tl(5, "Write report 45m", false)
  ), null);
}

// ---- timeline overlays and available-slot projections ----
eq("past timeline follows hourly cells", pastTimelineSegments(300, 600, 450), [
  { start: 300, end: 360 },
  { start: 360, end: 420 },
  { start: 420, end: 450 },
]);
eq("past timeline is empty before start", pastTimelineSegments(300, 600, 300), []);
eq("past unplanned gaps exclude occupied intervals", pastUnplannedSegments({
  startMinutes: 300,
  endMinutes: 600,
  nowMinutes: 450,
  occupiedEvents: [mk({ start: 330, end: 390 })],
}), [
  { start: 300, end: 330 },
  { start: 390, end: 420 },
  { start: 420, end: 450 },
]);
const slots = availableSlotGroups({
  events: [
    mk({ freetime: true, todo: false, start: 300, end: 420 }),
    mk({ freetime: true, todo: false, start: 480, end: 600 }),
  ],
  startMinutes: 300,
  endMinutes: 600,
  nowMinutes: 360,
  clampToNow: true,
});
eq("available slots clamp to now", slots.map((slot) => [slot.start, slot.end, slot.availableNow]), [
  [360, 420, true],
  [480, 600, false],
]);
eq("available slots split at hour boundaries", slots[0].segments, [
  { start: 360, end: 420 },
]);

// ---- capacity header: remaining time, full-day ratios, and semantic tones ----
{
  const result = calculateCapacity({
    startMinutes: 300,
    endMinutes: 1440,
    nowMinutes: 600,
    fixedEvents: [
      mk({ meeting: true, todo: false, start: 660, end: 720 }),
      mk({ meeting: true, todo: false, start: 700, end: 750 }),
      mk({ meeting: true, todo: false, start: 500, end: 630 }),
    ],
    allFixedEvents: [
      mk({ meeting: true, todo: false, done: true, start: 360, end: 420 }),
      mk({ meeting: true, todo: false, start: 660, end: 720 }),
      mk({ meeting: true, todo: false, start: 700, end: 750 }),
      mk({ meeting: true, todo: false, start: 500, end: 630 }),
    ],
    pendingTasks: [
      mk({ duration: 120 }),
      mk({ duration: 60 }),
    ],
  });
  eq("capacity subtracts merged future events", [result.availableMinutes, result.fixedMinutes], [720, 120]);
  eq("capacity sums remaining task demand", result.demandMinutes, 180);
  eq("capacity keeps full-day totals", [result.totalAvailableMinutes, result.totalFixedMinutes], [860, 280]);

  const screenshotCapacity = {
    availableMinutes: 660,
    totalAvailableMinutes: 660,
    fixedMinutes: 300,
    totalFixedMinutes: 300,
    demandMinutes: 195,
    overloadMinutes: 0,
    slackMinutes: 465,
    unplacedMinutes: 0,
    scheduledTasks: [],
    overflowTasks: [],
    burningBucket: null,
  };
  const screenshot = capacityMetrics(screenshotCapacity);
  eq("screenshot planned / free / left", [
    screenshot.planned.value,
    screenshot.planned.summaryLabel,
    screenshot.status.value,
    screenshot.status.summaryLabel,
    screenshot.planned.percent,
    screenshot.planned.percentLabel,
  ], ["3h15m", "planned", "7h45m", "free", "70%", "left"]);
  eq("screenshot available and event totals", [
    screenshot.available.value,
    screenshot.available.total,
    screenshot.events.value,
    screenshot.events.total,
  ], ["11h", "11h", "5h", "5h"]);
  eq("positive free and left use semantic color", [screenshot.status.tone, screenshot.planned.percentTone], ["positive", "positive"]);

  const overloaded = capacityMetrics({
    ...screenshotCapacity,
    availableMinutes: 90,
    demandMinutes: 105,
    overloadMinutes: 15,
    slackMinutes: 0,
  });
  eq("overload uses warning tone", [overloaded.status.tone, overloaded.planned.percentTone], ["warning", "warning"]);
  const tiny = capacityMetrics({
    ...screenshotCapacity,
    availableMinutes: 2,
    totalAvailableMinutes: 660,
    demandMinutes: 0,
    slackMinutes: 2,
  });
  eq("tiny positive capacity never rounds to zero", tiny.planned.percent, "1%");
}
{
  const fragmented = calculateCapacity({
    startMinutes: 300,
    endMinutes: 420,
    nowMinutes: 300,
    fixedEvents: [
      mk({ meeting: true, todo: false, start: 330, end: 360 }),
      mk({ meeting: true, todo: false, start: 390, end: 420 }),
    ],
    pendingTasks: [mk({ duration: 45 })],
  });
  eq("atomic task reports fragmented capacity", [fragmented.overloadMinutes, fragmented.unplacedMinutes], [0, 45]);
}

// ---- Tidy: stable ordering, complete blocks, and conflict-safe Undo ----
{
  const lines = [
    "- [ ] Active A 30m",
    "  - CLOCK: [2026-08-26 Wed 08:00]--[2026-08-26 Wed 08:10] => 0:10",
    "- [x] Done A 30m d09:00",
    "- 08:00-09:00 Past event",
    "- ---",
    "- [ ] Active B 30m",
    "- 20:00-21:00 Future event",
  ];
  const tasks = [
    tl(0, "Active A 30m", false),
    tl(2, "Done A 30m d09:00", true),
    tl(3, "08:00-09:00 Past event", null),
    tl(4, "---", null),
    tl(5, "Active B 30m", false),
    tl(6, "20:00-21:00 Future event", null),
  ];
  const edit = createTidyEdit(lines, tasks, new Set([2, 3]));
  eq("Tidy moves two settled items", edit.count, 2);
  eq("Tidy is stable and keeps descendants attached", edit.lines, [
    "- [x] Done A 30m d09:00",
    "- 08:00-09:00 Past event",
    "- [ ] Active A 30m",
    "  - CLOCK: [2026-08-26 Wed 08:00]--[2026-08-26 Wed 08:10] => 0:10",
    "- ---",
    "- [ ] Active B 30m",
    "- 20:00-21:00 Future event",
  ]);
  const tidiedTasks = [
    tl(0, "Done A 30m d09:00", true),
    tl(1, "08:00-09:00 Past event", null),
    tl(2, "Active A 30m", false),
    tl(4, "---", null),
    tl(5, "Active B 30m", false),
    tl(6, "20:00-21:00 Future event", null),
  ];
  eq("Tidy is idempotent", createTidyEdit(edit.lines, tidiedTasks, new Set([0, 1])).count, 0);
  eq("Undo restores the original complete blocks", restoreTidyEdit(
    edit.lines,
    tidiedTasks,
    edit.originalOrder,
    edit.targetOrder
  ), lines);
  const changed = [...edit.lines];
  changed[5] = "- [ ] Active B edited 30m";
  eq("Undo refuses to overwrite a later plan edit", restoreTidyEdit(
    changed,
    tidiedTasks,
    edit.originalOrder,
    edit.targetOrder
  ), null);

  const running = createTidyEdit(lines, tasks, new Set([2, 3]), 2);
  eq("Tidy never moves the running task", running.lines, [
    "- 08:00-09:00 Past event",
    "- [ ] Active A 30m",
    "  - CLOCK: [2026-08-26 Wed 08:00]--[2026-08-26 Wed 08:10] => 0:10",
    "- [x] Done A 30m d09:00",
    "- ---",
    "- [ ] Active B 30m",
    "- 20:00-21:00 Future event",
  ]);
}
{
  const nightSettings = { ...S, workdayStart: 1200, workdayEnd: 120 };
  const nightTasks = [
    tl(0, "01:00-02:00 Ended overnight event", null),
    tl(1, "03:00-04:00 Later event", null),
    tl(2, "Completed task 30m", true),
  ];
  eq("Tidy aligns elapsed events to overnight windows", [
    ...settledTaskLines(nightTasks, nightSettings, 120),
  ], [0, 2]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);

// ---- datefmt ----
{
  const d = new Date(2026, 7, 26, 9, 5, 3);
  eq("format YYYY-MM-DD", formatDate(d, "YYYY-MM-DD"), "2026-08-26");
  eq("format with day name", formatDate(d, "YYYY-MM-DD ddd"), "2026-08-26 Wed");
  eq("format M D no pad", formatDate(d, "M/D"), "8/26");
  eq("format month name", formatDate(d, "MMM D, YYYY"), "Aug 26, 2026");
  eq("format time", formatDate(d, "HH:mm:ss"), "09:05:03");
  const p1 = parseDateStrict("2026-08-26", "YYYY-MM-DD")!;
  eq("parse roundtrip", [p1.getFullYear(), p1.getMonth() + 1, p1.getDate()], [2026, 8, 26]);
  eq("parse with weekday", parseDateStrict("2026-08-26 Wed", "YYYY-MM-DD ddd") !== null, true);
  eq("reject month 13", parseDateStrict("2026-13-01", "YYYY-MM-DD"), null);
  eq("reject feb 30", parseDateStrict("2026-02-30", "YYYY-MM-DD"), null);
  eq("reject partial", parseDateStrict("2026-08-26 notes", "YYYY-MM-DD"), null);
  eq("reject wrong format", parseDateStrict("2026/08/26", "YYYY-MM-DD"), null);
  eq("parse with HH mm tokens", parseDateStrict("2026-08-26 14:30", "YYYY-MM-DD HH:mm") !== null, true);
}
