import { DEFAULT_SETTINGS, NautEvent } from "../src/types";
import { parseRowParams, bumpProgressInLine, hasDoneTime, hasTrailingDoneTime, stripTrailingDoneTime, fixTaskLines, TaskLine } from "../src/parser";
import { addStartAfter, fillDay } from "../src/scheduler";
import { minToAngle, posSweepAngle, angleToRad, iterateRectPlace } from "../src/geometry";

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
  description: "x", progress: 0, duration: 15, line: 0, start: 0, end: 0,
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
  600 // "now" = 10:00
);
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
  600
);
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

// ---- fixTaskLines: stamp + move-to-bottom ----
const tl = (line: number, text: string, checked: boolean | null): TaskLine => ({ line, text, checked });
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
