import {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Notice,
  Plugin,
  PluginSettingTab,
  SettingDefinitionItem,
  TFile,
  setIcon,
} from "obsidian";
import { DEFAULT_SETTINGS, NautEvent, NautilusSettings, workdayWindow } from "./types";
import {
  bumpProgressInLine,
  fixTaskLines,
  parseRowParams,
  TaskLine,
} from "./parser";
import { addStartAfter, alignIntervalToWindow } from "./scheduler";
import {
  ClockInterval,
  OpenClock,
  ReviewTask,
  buildDailyReview,
  clockEntriesForTask,
  clockInTask,
  closeClockIfOwnerDone,
  closeClockLine,
  findOpenClock,
  fixClockDurations,
} from "./timing";
import { PanelTab, renderExecPanel, tickElapsedLabels } from "./panel";
import { formatDate, parseDateStrict } from "./datefmt";
import { buildNautilusSvg, TODO_PALETTE } from "./render";

const LIST_RE = /^\s*(?:[-*+]|\d+\.)\s+/;
const CHECK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+/;

/** Persisted data.json shape: settings plus ephemeral POMO state. */
interface PersistedData extends Partial<NautilusSettings> {
  pomoStartMs?: number | null;
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Heuristic "is this today's daily note": compare the basename against
 * today's date in the user-configured format. Public API only — the core
 * Daily Notes plugin exposes no official way to read its date format.
 */
function isTodayDailyNote(file: TFile, format: string): boolean {
  return file.basename === formatDate(new Date(), format || "YYYY-MM-DD");
}

/**
 * Collect list items directly below the code block. Lines indented deeper
 * than the first task (LOGBOOK drawers, CLOCK entries, subtasks) belong to
 * their parent task and are never parsed as tasks themselves.
 */
function collectTasks(lines: string[], fromLine: number): TaskLine[] {
  const out: TaskLine[] = [];
  let started = false;
  let baseIndent = -1;
  for (let i = fromLine; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (started) break;
      continue;
    }
    const indent = /^\s*/.exec(line)![0].length;
    if (!LIST_RE.test(line)) {
      if (started && indent > baseIndent) continue; // non-list child content
      break;
    }
    if (!started) {
      started = true;
      baseIndent = indent;
    } else if (indent !== baseIndent) {
      if (indent > baseIndent) continue; // child line of the previous task
      else break;
    }
    const cm = line.match(CHECK_RE);
    let text: string;
    let checked: boolean | null = null;
    if (cm) {
      checked = cm[1].toLowerCase() === "x";
      text = line.slice(cm[0].length);
    } else {
      text = line.replace(LIST_RE, "");
    }
    out.push({ line: i, text, checked, indent });
  }
  return out;
}

/** Parse optional per-block overrides from the code fence content. */
function parseBlockArgs(source: string, base: NautilusSettings): NautilusSettings {
  const s = { ...base };
  for (const line of source.split("\n")) {
    const m = line.match(/^\s*([A-Za-z]+)\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    const n = parseInt(val, 10);
    if (key === "start" && n >= 0 && n <= 23) s.workdayStart = n * 60;
    else if (key === "end" && n >= 1 && n <= 24) s.workdayEnd = n * 60;
    else if (key === "duration" && n >= 5 && n <= 60) s.defaultDuration = n;
    else if (key === "len" && n >= 15 && n <= 30) s.legendLenLimit = n;
    else if (key === "tag") s.customColorTag = val;
  }
  const [ws, we] = workdayWindow(s);
  s.workdayStart = ws;
  s.workdayEnd = we;
  return s;
}

/**
 * "Now" on the window's continuous timeline: when the window crosses
 * midnight, times before the workday start belong to the next day.
 */
function effectiveNow(settings: NautilusSettings): number {
  const raw = nowMinutes();
  return settings.workdayEnd > 1440 && raw < settings.workdayStart
    ? raw + 1440
    : raw;
}

/* ------------------------------------------------------------------ */

class NautilusBlock extends MarkdownRenderChild {
  private state = { showDone: true, playing: false };
  private seq = 0;
  private settings: NautilusSettings;
  private pendings: NautEvent[] = [];
  private dones: NautEvent[] = [];
  /** actual CLOCK arcs, positioned by real intervals (see docs/adr/0001) */
  private actuals: NautEvent[] = [];
  private isDaily = false;
  private pageTitle = "";
  private file: TFile | null = null;
  private simMin: number | null = null;
  private rafId: number | null = null;
  private setPointer: ((nowMin: number) => void) | null = null;
  /** first line of this block's section, used to pick the primary plan */
  private sectionStart = 0;
  private clockInfo = new Map<number, ClockInterval[]>();
  private openClock: (OpenClock & { description: string }) | null = null;
  private planTasks: ReviewTask[] = [];
  private reviewTasks: ReviewTask[] = [];
  private panelTab: PanelTab = "timing";
  private windowMs: [number, number] = [0, 0];
  /** re-render timer while an open CLOCK runs on today's daily note */
  private liveTimer: number | null = null;

  constructor(
    private plugin: NautilusLogPlugin,
    private source: string,
    containerEl: HTMLElement,
    readonly ctx: MarkdownPostProcessorContext
  ) {
    super(containerEl);
    this.settings = { ...plugin.settings };
  }

  onload(): void {
    this.plugin.blocks.add(this);
    void this.refresh();
  }

  /** Current file path; survives renames (TFile.path updates in place). */
  getPath(): string {
    return this.file?.path ?? this.ctx.sourcePath;
  }

  isDailyBlock(): boolean {
    return this.isDaily;
  }

  getSectionStart(): number {
    return this.sectionStart;
  }

  onunload(): void {
    this.plugin.blocks.delete(this);
    if (this.rafId !== null) window.cancelAnimationFrame(this.rafId);
    if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
  }

  async refresh(): Promise<void> {
    const mySeq = ++this.seq;
    // prefer the stored TFile reference: ctx.sourcePath goes stale after a rename
    const byRef = this.file
      ? this.plugin.app.vault.getAbstractFileByPath(this.file.path)
      : null;
    const file =
      byRef instanceof TFile
        ? byRef
        : this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!(file instanceof TFile)) return;
    const section = this.ctx.getSectionInfo(this.containerEl);
    if (!section) {
      this.containerEl.empty();
      this.containerEl.createDiv({
        cls: "nautilus-container",
        text: "Nautilus Log: cannot locate this block (Live Preview is not supported yet — use Reading view).",
      });
      return;
    }
    const content = await this.plugin.app.vault.cachedRead(file);
    if (mySeq !== this.seq) return;
    this.sectionStart = section.lineStart;

    const lines = content.split("\n");
    const settings = parseBlockArgs(this.source, this.plugin.settings);
    const tasks = collectTasks(lines, section.lineEnd + 1);

    // Pass 1: fix timestamps (normally already handled by the plugin-level
    // vault "modify" handler; this is a fallback, e.g. after external edits).
    // Checking a task done also closes its running CLOCK (docs/adr/0001).
    const doneTaskLines = new Set(
      tasks.filter((t) => t.checked === true).map((t) => t.line)
    );
    const clockClosed = closeClockIfOwnerDone(lines, doneTaskLines, new Date());
    if (
      clockClosed ||
      fixClockDurations(lines) ||
      fixTaskLines(lines, tasks, settings, nowMinutes())
    ) {
      await this.plugin.app.vault.modify(file, lines.join("\n"));
      // the vault "modify" event triggers the real re-render
      return;
    }

    // Pass 2: parse events.
    const pendings: NautEvent[] = [];
    const dones: NautEvent[] = [];
    const actuals: NautEvent[] = [];
    const noteDate = parseDateStrict(
      file.basename,
      this.plugin.settings.dailyNoteFormat || "YYYY-MM-DD"
    );
    const dayBase = noteDate ?? new Date();
    dayBase.setHours(0, 0, 0, 0);
    const dayBaseMs = dayBase.getTime();
    const winStartMs = dayBaseMs + settings.workdayStart * 60000;
    const winEndMs = dayBaseMs + settings.workdayEnd * 60000;
    this.windowMs = [winStartMs, winEndMs];
    const [winStart, winEnd] = workdayWindow(settings);
    const nowMs = Date.now();
    this.clockInfo.clear();
    this.planTasks = [];
    this.reviewTasks = [];
    const descByLine = new Map<number, string>();
    let todoHueIdx = 0;
    // One arc per CLOCK interval, clipped to the workday window. A running
    // entry reaches to now. Every arc carries its legend, so each interval
    // of a multi-interval day stays identifiable.
    const toArc = (ev: NautEvent, e: ClockInterval): NautEvent | null => {
      const s = (e.start.getTime() - dayBaseMs) / 60000;
      const en = ((e.end?.getTime() ?? nowMs) - dayBaseMs) / 60000;
      const [a1, a2] = alignIntervalToWindow(s, en, winStart, winEnd);
      const cs = Math.max(a1, winStart);
      const ce = Math.min(a2, winEnd);
      if (ce <= cs) return null;
      return {
        ...ev,
        start: cs,
        end: ce,
        duration: ce - cs,
        actual: true,
        doneAt: null,
        progress: 0,
      };
    };
    for (const t of tasks) {
      const ev = parseRowParams(t.text, t.checked === true, t.line, settings);
      if (!ev) continue;
      descByLine.set(t.line, ev.description);
      const entries = clockEntriesForTask(lines, t.line, t.indent);
      this.clockInfo.set(t.line, entries);
      if (ev.todo) {
        const rt: ReviewTask = {
          line: t.line,
          description: ev.description,
          done: ev.done,
          plannedMinutes: ev.estimate,
        };
        this.reviewTasks.push(rt);
        if (!ev.done) this.planTasks.push(rt);
        ev.bgColor =
          ev.bgColor ?? TODO_PALETTE[todoHueIdx % TODO_PALETTE.length];
        todoHueIdx++;
      }
      if (ev.meeting && ev.done) {
        dones.push(ev);
        continue;
      }
      if (ev.done && ev.todo) {
        // Actual-first (docs/adr/0001): any CLOCK record wins — one arc per
        // interval, ignoring planned time and the done stamp. Only without
        // any clock does the done stamp anchor an estimate-sized slice.
        if (entries.length > 0) {
          for (const e of entries) {
            const arc = toArc(ev, e);
            if (arc) actuals.push(arc);
          }
          continue;
        }
        if (ev.doneAt == null) continue;
        const [s2, e2] = alignIntervalToWindow(
          ev.doneAt - ev.estimate,
          ev.doneAt,
          winStart,
          winEnd
        );
        dones.push({ ...ev, start: s2, end: e2, duration: ev.estimate });
        continue;
      }
      // pending todo: planned slice schedules as before; tracked intervals
      // (including a running CLOCK, drawn to now) appear as actual arcs.
      // Arcs carry their own legend too — during playback the planned slice
      // sits at a different time, so an unlabeled arc would be
      // unidentifiable.
      if (ev.todo) {
        for (const e of entries) {
          const arc = toArc(ev, e);
          if (arc) actuals.push(arc);
        }
      }
      pendings.push(ev);
    }
    const open = findOpenClock(lines);
    this.openClock = open
      ? { ...open, description: descByLine.get(open.taskLine) ?? "" }
      : null;
    this.settings = settings;
    this.pendings = addStartAfter(pendings);
    this.dones = dones;
    this.actuals = actuals;
    this.file = file;
    this.isDaily = isTodayDailyNote(file, this.plugin.settings.dailyNoteFormat);
    this.pageTitle = file.basename;
    if (this.liveTimer !== null) {
      window.clearTimeout(this.liveTimer);
      this.liveTimer = null;
    }
    if (
      this.openClock &&
      this.isDaily &&
      this.plugin.settings.executionLayer
    ) {
      // grow the live arc once a minute while a CLOCK runs
      this.liveTimer = window.setTimeout(() => void this.refresh(), 60000);
    }
    this.renderFrame();
  }

  renderFrame(): void {
    const nowMin = this.simMin ?? effectiveNow(this.settings);
    const planFromTime = this.state.playing
      ? 0
      : this.isDaily
      ? nowMin
      : this.settings.workdayStart;

    this.containerEl.empty();
    const wrap = this.containerEl.createDiv({ cls: "nautilus-container" });

    if (
      this.plugin.settings.executionLayer &&
      this.isDaily &&
      this.plugin.primaryBlock() === this
    ) {
      const nowMs = Date.now();
      renderExecPanel(wrap, {
        settings: this.plugin.settings,
        tab: this.panelTab,
        openClock: this.openClock,
        planTasks: this.planTasks,
        entriesByLine: this.clockInfo,
        review: buildDailyReview(
          this.reviewTasks,
          this.clockInfo,
          this.windowMs[0],
          this.windowMs[1],
          nowMs
        ),
        pomoStartMs: this.plugin.pomoStartMs,
        nowMs,
        onTab: (tab) => {
          this.panelTab = tab;
          this.renderFrame();
        },
        onClockIn: (line) => void this.plugin.clockIn(this.file, this.getPath(), line),
        onClockOut: () => void this.plugin.clockOut(this.file, this.getPath()),
        onPomoToggle: () => void this.plugin.togglePomo(),
      });
    }

    const rendered = buildNautilusSvg(this.pendings, this.dones, {
      settings: this.settings,
      isDaily: this.isDaily,
      pageTitle: this.pageTitle,
      nowMin,
      planFromTime,
      showDone: this.state.showDone,
      playing: this.state.playing,
      actuals: this.actuals,
      onProgressClick: (ev) => void this.onProgressClick(ev),
    });
    this.setPointer = rendered.setPointer;
    wrap.appendChild(rendered.svg);
    if (rendered.overflow.length > 0) {
      const names = rendered.overflow.map((e) => e.description).join(", ");
      wrap.createDiv({
        cls: "nautilus-overflow",
        text: `Won't fit today: ${names}`,
      });
    }

    // controls live in-flow below the chart so they never overlap the
    // execution panel or Obsidian's own code-block action buttons
    const controls = wrap.createDiv({ cls: "nautilus-controls-top" });
    const eyeBtn = controls.createEl("button", {
      cls: "nautilus-toggle-btn",
      attr: {
        title: this.state.showDone ? "Hide completed" : "Show completed",
      },
    });
    setIcon(eyeBtn, this.state.showDone ? "eye" : "eye-off");
    eyeBtn.addEventListener("click", () => {
      this.state.showDone = !this.state.showDone;
      this.renderFrame();
    });
    const playBtn = this.plugin.settings.showPlaybackButton
      ? controls.createEl("button", {
          cls: "nautilus-toggle-btn",
          attr: { title: "Replay the day (hyper-lapse)" },
        })
      : null;
    if (playBtn) {
      setIcon(playBtn, "play");
      playBtn.disabled = this.state.playing;
      playBtn.addEventListener("click", () => this.playback());
    }
  }

  private playback(): void {
    if (this.state.playing) return;
    this.state.playing = true;
    this.simMin = this.settings.workdayStart;
    // Render ONCE so the slice pop-in animations can run to completion;
    // rebuilding the DOM every frame would keep restarting them, leaving
    // everything invisible except the pointer.
    this.renderFrame();
    const start = performance.now();
    const duration = 6000;
    const ws = this.settings.workdayStart;
    const we = this.settings.workdayEnd;
    const tick = (t: number) => {
      const prog = Math.min(1, (t - start) / duration);
      const sim = Math.floor(ws + prog * (we - ws));
      this.simMin = sim;
      this.setPointer?.(sim);
      if (prog < 1) {
        this.rafId = window.requestAnimationFrame(tick);
      } else {
        this.state.playing = false;
        this.simMin = null;
        this.renderFrame();
      }
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private async onProgressClick(ev: NautEvent): Promise<void> {
    if (!this.file || ev.line < 0) return;
    const content = await this.plugin.app.vault.read(this.file);
    const lines = content.split("\n");
    if (ev.line >= lines.length) return;
    lines[ev.line] = bumpProgressInLine(lines[ev.line], 10, nowMinutes());
    await this.plugin.app.vault.modify(this.file, lines.join("\n"));
    // metadataCache "changed" listener triggers the re-render
  }
}

/* ------------------------------------------------------------------ */

export default class NautilusLogPlugin extends Plugin {
  settings: NautilusSettings = { ...DEFAULT_SETTINGS };
  blocks: Set<NautilusBlock> = new Set();
  /** standalone POMO start (epoch ms); null when not running */
  pomoStartMs: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerMarkdownCodeBlockProcessor("nautilus", (source, el, ctx) => {
      ctx.addChild(new NautilusBlock(this, source, el, ctx));
    });

    this.addSettingTab(new NautilusSettingTab(this.app, this));

    // vault "modify" fires immediately on every file change (including
    // checkbox clicks in Live Preview, where no rendered block exists).
    // Fix completion stamps right away, then re-render affected blocks.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          void this.fixTimestamps(file).then(() => this.refreshAll(file.path));
        }
      })
    );
    // keep the now-pointer moving even without edits
    // renames change no content, so no "modify" event fires — refresh
    // explicitly to update the central label (file basename)
    this.registerEvent(
      this.app.vault.on("rename", () => this.refreshAll())
    );
    // keep the now-pointer moving even without edits
    this.registerInterval(
      window.setInterval(() => this.refreshAll(), 30_000)
    );
    // 1s ticker for the execution panel's elapsed labels
    this.registerInterval(
      window.setInterval(() => {
        if (!this.settings.executionLayer) return;
        for (const block of this.blocks) {
          if (block.containerEl.isConnected) {
            tickElapsedLabels(block.containerEl, Date.now());
          }
        }
      }, 1_000)
    );

    this.addCommand({
      id: "nautilus-clock-out",
      name: "Clock out current task",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) void this.clockOut(file, file.path);
      },
    });

    this.addCommand({
      id: "nautilus-clock-toggle-line",
      name: "Clock in/out task on current line",
      editorCallback: (editor, view) => {
        const file = view.file;
        if (!file) return;
        void this.clockToggleLine(file, editor.getCursor().line);
      },
    });

    this.addCommand({
      id: "nautilus-locate-primary-plan",
      name: "Locate primary plan",
      callback: () => {
        const today = formatDate(
          new Date(),
          this.settings.dailyNoteFormat || "YYYY-MM-DD"
        );
        const folder = this.settings.dailyNotesFolder.replace(/^\/|\/$/g, "");
        const path = folder ? `${folder}/${today}.md` : `${today}.md`;
        // direct path lookup — no vault-wide enumeration
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          void this.app.workspace.getLeaf().openFile(file);
        } else {
          new Notice(`Nautilus Log: daily note not found at ${path}`);
        }
      },
    });
  }

  /**
   * The first nautilus block on today's daily note — the execution panel's
   * primary plan (same rule as the Roam extension).
   */
  primaryBlock(): NautilusBlock | null {
    let best: NautilusBlock | null = null;
    for (const b of this.blocks) {
      if (!b.containerEl.isConnected || !b.isDailyBlock()) continue;
      if (
        !best ||
        b.getPath() < best.getPath() ||
        (b.getPath() === best.getPath() && b.getSectionStart() < best.getSectionStart())
      ) {
        best = b;
      }
    }
    return best;
  }

  /** Clock in a task: closes any running CLOCK at the same instant. */
  async clockIn(file: TFile | null, path: string, taskLine: number): Promise<void> {
    const f = file ?? this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const lines = (await this.app.vault.read(f)).split("\n");
    const tasks = this.tasksOfFile(lines);
    const task = tasks.find((t) => t.line === taskLine);
    if (!task) return;
    clockInTask(lines, taskLine, task.indent, new Date());
    this.pomoStartMs = null; // CLOCK always has priority over POMO
    await this.app.vault.modify(f, lines.join("\n"));
    void this.saveData({ ...this.settings, pomoStartMs: null });
  }

  async clockOut(file: TFile | null, path: string): Promise<void> {
    const f = file ?? this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const lines = (await this.app.vault.read(f)).split("\n");
    const open = findOpenClock(lines);
    if (!open) return;
    if (closeClockLine(lines, open.clockLine, new Date())) {
      await this.app.vault.modify(f, lines.join("\n"));
    }
  }

  /** Toggle CLOCK for the task on a given editor line, if it is a plan task. */
  async clockToggleLine(file: TFile, line: number): Promise<void> {
    const lines = (await this.app.vault.read(file)).split("\n");
    const tasks = this.tasksOfFile(lines);
    const task = tasks.find((t) => t.line === line);
    if (!task) return;
    const open = findOpenClock(lines);
    if (open && open.taskLine === line) {
      closeClockLine(lines, open.clockLine, new Date());
    } else {
      clockInTask(lines, line, task.indent, new Date());
      this.pomoStartMs = null;
      void this.saveData({ ...this.settings, pomoStartMs: null });
    }
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async togglePomo(): Promise<void> {
    this.pomoStartMs = this.pomoStartMs ? null : Date.now();
    await this.saveData({ ...this.settings, pomoStartMs: this.pomoStartMs });
    this.refreshAll();
  }

  /** All nautilus-block task lines of a file's content. */
  private tasksOfFile(lines: string[]): TaskLine[] {
    const out: TaskLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*```nautilus\s*$/.test(lines[i])) continue;
      let end = i + 1;
      while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) end++;
      if (end >= lines.length) continue;
      out.push(...collectTasks(lines, end + 1));
      i = end;
    }
    return out;
  }

  refreshAll(path?: string): void {
    for (const block of [...this.blocks]) {
      if (!block.containerEl.isConnected) {
        this.blocks.delete(block);
        continue;
      }
      if (!path || block.getPath() === path) void block.refresh();
    }
  }

  private fixingPaths = new Set<string>();

  /**
   * Scan every ```nautilus block in a file and fix completion stamps below
   * it. Runs on the raw file, independent of any rendered block instance,
   * so it also works while editing in Live Preview.
   */
  async fixTimestamps(file: TFile): Promise<void> {
    if (file.extension !== "md" || this.fixingPaths.has(file.path)) return;
    this.fixingPaths.add(file.path);
    try {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      let dirty = false;
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*```nautilus\s*$/.test(lines[i])) continue;
        let end = i + 1;
        while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) end++;
        if (end >= lines.length) continue;
        const tasks = collectTasks(lines, end + 1);
        // done means work stopped: close a running CLOCK whose owner checked
        const doneTaskLines = new Set(
          tasks.filter((t) => t.checked === true).map((t) => t.line)
        );
        if (closeClockIfOwnerDone(lines, doneTaskLines, new Date())) {
          dirty = true;
        }
        if (fixTaskLines(lines, tasks, this.settings, nowMinutes())) {
          dirty = true;
        }
        i = end;
      }
      if (fixClockDurations(lines)) dirty = true;
      if (dirty) await this.app.vault.modify(file, lines.join("\n"));
    } finally {
      this.fixingPaths.delete(file.path);
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as PersistedData | null;
    // migrate untouched legacy defaults to the current defaults
    if (data) {
      const legacy: [keyof NautilusSettings, number, number][] = [
        ["workdayStart", 480, 420],
        ["defaultDuration", 15, 30],
        ["pomodoroThreshold", 45, 25],
        ["forgottenTimerWarning", 120, 30],
      ];
      for (const [key, oldVal, newVal] of legacy) {
        if ((data as Record<string, unknown>)[key] === oldVal) {
          (data as Record<string, unknown>)[key] = newVal;
        }
      }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.pomoStartMs = data?.pomoStartMs ?? null;
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, pomoStartMs: this.pomoStartMs });
    this.refreshAll();
  }
}

/** Description with an optional subtle warning line below. */
function descWithWarn(desc: string, warn?: string): string | DocumentFragment {
  if (!warn) return desc;
  return createFragment((frag) => {
    frag.appendText(desc);
    frag.createDiv({ cls: "nautilus-setting-warn", text: warn });
  });
}

class NautilusSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NautilusLogPlugin) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (key === "workdayStart" || key === "workdayEnd") return String(s[key]);
    return s[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    s[key] =
      (key === "workdayStart" || key === "workdayEnd") &&
      typeof value === "string"
        ? parseInt(value, 10)
        : value;
    await this.plugin.saveSettings();
    // re-evaluate visible() predicates (execution layer sub-settings)
    this.update();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const execVisible = () => this.plugin.settings.executionLayer;
    const hourOptions = (from: number, to: number): Record<string, string> => {
      const o: Record<string, string> = {};
      for (let h = from; h <= to; h++) {
        o[String(h * 60)] = h === 24 ? "24:00" : `${h}:00`;
      }
      return o;
    };
    return [
      {
        name: "Workday start",
        desc: "The day plan starts at this hour. Default: 7:00.",
        control: {
          type: "dropdown",
          key: "workdayStart",
          options: hourOptions(0, 23),
        },
      },
      {
        name: "Workday end",
        desc: "The day plan ends at this hour. An end at or before the start runs into the next day. Default: 22:00.",
        control: {
          type: "dropdown",
          key: "workdayEnd",
          options: hourOptions(1, 24),
        },
      },
      {
        name: "Default task duration",
        desc: "Planned length for tasks without a written duration. Default: 30 min.",
        control: {
          type: "slider",
          key: "defaultDuration",
          min: 5,
          max: 60,
          step: 5,
          displayFormat: (v) => `${v} min`,
        },
      },
      {
        name: "Label length limit",
        desc: "Maximum characters per task name on the chart. One Chinese character counts as two. Default: 22.",
        control: {
          type: "slider",
          key: "legendLenLimit",
          min: 15,
          max: 30,
          step: 1,
          displayFormat: (v) => String(v),
        },
      },
      {
        name: "Show playback button",
        desc: "Show a button that replays the day as an animation. Default: on.",
        control: { type: "toggle", key: "showPlaybackButton" },
      },
      {
        name: "Daily note date name",
        desc: descWithWarn(
          "The date format in daily note filenames (e.g. YYYY-MM-DD). Default: YYYY-MM-DD.",
          "A wrong format means the plugin cannot tell which note is today."
        ),
        control: {
          type: "text",
          key: "dailyNoteFormat",
          placeholder: "YYYY-MM-DD",
        },
      },
      {
        name: "Daily notes folder",
        desc: 'The folder that stores daily notes (e.g. Daily). Used by the "Locate primary plan" command. Default: empty (vault root).',
        control: {
          type: "text",
          key: "dailyNotesFolder",
          placeholder: "Daily",
        },
      },
      {
        name: "Record completion time",
        desc: descWithWarn(
          "Checking off a task adds a completion time (e.g. d14:31). Unchecking removes the timestamp. Default: on.",
          "Without a timestamp, a finished task cannot be shown on the chart."
        ),
        control: { type: "toggle", key: "stampOnCheck" },
      },
      {
        name: "Highlight tag",
        desc: "Tasks with the highlight tag use the highlight color (e.g. #focus). Default: empty (off).",
        control: { type: "text", key: "customColorTag", placeholder: "#focus" },
      },
      {
        name: "Highlight color",
        desc: "The color for tasks with the highlight tag. Default: rgba(255,0,0,0.5).",
        control: {
          type: "text",
          key: "customColor",
          placeholder: "rgba(255,0,0,0.5)",
        },
      },
      {
        type: "group",
        heading: "Execution layer",
        items: [
          {
            name: "Execution layer",
            desc: "CLOCK records, a POMO timer, and a daily review above the chart. Default: off.",
            control: { type: "toggle", key: "executionLayer" },
          },
          {
            name: "Pomodoro time",
            desc: "Minutes before the POMO timer turns red. Default: 25 min.",
            visible: execVisible,
            control: {
              type: "slider",
              key: "pomodoroThreshold",
              min: 0,
              max: 120,
              step: 5,
              displayFormat: (v) => `${v} min`,
            },
          },
          {
            name: "Show finished tasks for",
            desc: "Minutes a stopped task stays in the Timing tab. 0 hides stopped tasks. Default: 45 min.",
            visible: execVisible,
            control: {
              type: "slider",
              key: "recentRetention",
              min: 0,
              max: 120,
              step: 5,
              displayFormat: (v) => `${v} min`,
            },
          },
          {
            name: "Forgotten timer warning",
            desc: descWithWarn(
              "Minutes a CLOCK may run before the elapsed time turns red. 0 disables. Default: 30 min.",
              "The warning never stops the CLOCK."
            ),
            visible: execVisible,
            control: {
              type: "slider",
              key: "forgottenTimerWarning",
              min: 0,
              max: 240,
              step: 10,
              displayFormat: (v) => `${v} min`,
            },
          },
        ],
      },
    ];
  }
}
