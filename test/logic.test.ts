import { DEFAULT_SETTINGS, NautEvent, workdayWindow } from "../src/types";
import { parseRowParams, bumpProgressInLine, hasDoneTime, hasTrailingDoneTime, stripTrailingDoneTime, fixTaskLines, TaskLine } from "../src/parser";
import { addStartAfter, alignIntervalToWindow, fillDay } from "../src/scheduler";
import {
  actualMinutesInWindow,
  buildDailyReview,
  clockEntriesForTask,
  clockInTask,
  closeClockLine,
  findOpenClock,
  formatClockLine,
  lastClockEndMs,
  parseClockLine,
} from "../src/timing";
import { minToAngle, posSweepAngle, angleToRad, iterateRectPlace, spiralProfileIndex, spiralCellInnerIndex } from "../src/geometry";

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
eq("default duration", e3.duration, 15);

const e4 = parseRowParams("9-11am Standup", false, 3, S)!;
eq("am range", [e4.start, e4.end], [540, 660]);

const e5 = parseRowParams("1-3pm Review", false, 4, S)!;
eq("pm propagation to from-side", [e5.start, e5.end], [780, 900]);

const e6 = parseRowParams("Call 45m d50%", false, 5, S)!;
eq("progress scales duration", [e6.progress, e6.duration], [50, 23]);

const e7 = parseRowParams("Done thing d13:20", true, 6, S)!;
eq("done todo with timestamp", [e7.done, e7.doneAt, e7.start, e7.end], [true, 800, 785, 800]);

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
  // clock-in: inserts LOGBOOK + open CLOCK; switching closes the previous
  const lines = ["- [ ] Task A 30m", "- [ ] Task B 45m"];
  clockInTask(lines, 0, 0, D(10, 0));
  eq("clock-in inserts logbook", lines, [
    "- [ ] Task A 30m",
    "  - LOGBOOK::",
    "    - CLOCK: [2026-08-26 Wed 10:00]",
    "- [ ] Task B 45m",
  ]);
  clockInTask(lines, 3, 0, D(10, 30));
  eq("switch closes previous clock", lines[2], "    - CLOCK: [2026-08-26 Wed 10:00]--[2026-08-26 Wed 10:30] => 0:30");
  eq("new open clock under B", lines[5], "    - CLOCK: [2026-08-26 Wed 10:30]");
  const open = findOpenClock(lines)!;
  eq("open clock located", [open.clockLine, open.taskLine], [5, 3]);
  closeClockLine(lines, open.clockLine, D(11, 0));
  eq("clock out", lines[5], "    - CLOCK: [2026-08-26 Wed 10:30]--[2026-08-26 Wed 11:00] => 0:30");
  eq("no open clock left", findOpenClock(lines), null);
  const entries = clockEntriesForTask(lines, 0, 0);
  eq("entries of A", entries.length, 1);
  const day0 = new Date(2026, 7, 26, 0, 0, 0, 0).getTime();
  eq("actual minutes in window", actualMinutesInWindow(entries, day0, day0 + 1440 * 60000, D(12, 0).getTime()), 30);
  eq("last clock end", lastClockEndMs(entries), D(10, 30).getTime());
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
