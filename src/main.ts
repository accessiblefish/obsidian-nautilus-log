import {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  moment,
} from "obsidian";
import { DEFAULT_SETTINGS, NautEvent, NautilusSettings, workdayWindow } from "./types";
import {
  bumpProgressInLine,
  fixTaskLines,
  minutesToTime,
  parseRowParams,
  TaskLine,
} from "./parser";
import { addStartAfter, alignIntervalToWindow } from "./scheduler";
import {
  ClockInterval,
  OpenClock,
  ReviewTask,
  actualMinutesInWindow,
  buildDailyReview,
  clockEntriesForTask,
  clockInTask,
  closeClockLine,
  findOpenClock,
  lastClockEndMs,
} from "./timing";
import { PanelTab, renderExecPanel, tickElapsedLabels } from "./panel";
import { buildNautilusSvg } from "./render";

const LIST_RE = /^\s*(?:[-*+]|\d+\.)\s+/;
const CHECK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+/;

const EYE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
const PLAY_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;

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
  try {
    return file.basename === moment().format(format || "YYYY-MM-DD");
  } catch {
    return file.basename === moment().format("YYYY-MM-DD");
  }
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
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
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
    // vault "modify" handler; this is a fallback, e.g. after external edits)
    if (
      fixTaskLines(lines, tasks, settings, nowMinutes())
    ) {
      await this.plugin.app.vault.modify(file, lines.join("\n"));
      // the vault "modify" event triggers the real re-render
      return;
    }

    // Pass 2: parse events.
    const pendings: NautEvent[] = [];
    const dones: NautEvent[] = [];
    const noteMoment = moment(
      file.basename,
      this.plugin.settings.dailyNoteFormat || "YYYY-MM-DD",
      true
    );
    const dayBase = noteMoment.isValid() ? noteMoment.toDate() : new Date();
    dayBase.setHours(0, 0, 0, 0);
    const dayBaseMs = dayBase.getTime();
    const winStartMs = dayBaseMs + settings.workdayStart * 60000;
    const winEndMs = dayBaseMs + settings.workdayEnd * 60000;
    this.windowMs = [winStartMs, winEndMs];
    this.clockInfo.clear();
    this.planTasks = [];
    this.reviewTasks = [];
    const descByLine = new Map<number, string>();
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
      }
      if (ev.meeting && ev.done) {
        dones.push(ev);
        continue;
      }
      if (ev.done && ev.todo) {
        // historical slice: prefer total valid Actual time; anchor at the
        // explicit dHH:MM stamp, else at the last CLOCK end. Without either,
        // no history is invented (the task simply does not appear).
        const actual = actualMinutesInWindow(
          entries,
          winStartMs,
          winEndMs,
          Date.now()
        );
        const lastEnd = lastClockEndMs(entries);
        let endMin: number | null = ev.doneAt;
        if (endMin == null && actual > 0 && lastEnd != null) {
          endMin = Math.round((lastEnd - dayBaseMs) / 60000);
        }
        if (endMin == null) continue;
        const duration = actual > 0 ? actual : ev.estimate;
        const [s2, e2] = alignIntervalToWindow(
          endMin - duration,
          endMin,
          settings.workdayStart,
          settings.workdayEnd
        );
        dones.push({ ...ev, start: s2, end: e2, duration });
        continue;
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
    this.file = file;
    this.isDaily = isTodayDailyNote(file, this.plugin.settings.dailyNoteFormat);
    this.pageTitle = file.basename;
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
    eyeBtn.innerHTML = this.state.showDone ? EYE_SVG : EYE_OFF_SVG;
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
      playBtn.innerHTML = PLAY_SVG;
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
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.state.playing = false;
        this.simMin = null;
        this.renderFrame();
      }
    };
    this.rafId = requestAnimationFrame(tick);
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
        const today = moment().format(
          this.settings.dailyNoteFormat || "YYYY-MM-DD"
        );
        const file = this.app.vault
          .getFiles()
          .find((f) => f.basename === today && f.extension === "md");
        if (file) void this.app.workspace.getLeaf().openFile(file);
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
        if (fixTaskLines(lines, tasks, this.settings, nowMinutes())) {
          dirty = true;
        }
        i = end;
      }
      if (dirty) await this.app.vault.modify(file, lines.join("\n"));
    } finally {
      this.fixingPaths.delete(file.path);
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.pomoStartMs = data?.pomoStartMs ?? null;
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, pomoStartMs: this.pomoStartMs });
    this.refreshAll();
  }
}

class NautilusSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NautilusLogPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Nautilus Log" });

    new Setting(containerEl)
      .setName("Workday start")
      .setDesc("The spiral plans flexible tasks starting from this hour.")
      .addDropdown((d) => {
        for (let h = 0; h <= 23; h++) {
          d.addOption(String(h * 60), `${h}:00`);
        }
        d.setValue(String(this.plugin.settings.workdayStart)).onChange(
          async (v) => {
            this.plugin.settings.workdayStart = parseInt(v, 10);
            await this.plugin.saveSettings();
          }
        );
      });

    new Setting(containerEl)
      .setName("Workday end")
      .setDesc(
        "The last hour of the plan. An end at or before the start continues past midnight into the next day."
      )
      .addDropdown((d) => {
        for (let h = 1; h <= 24; h++) {
          d.addOption(String(h * 60), h === 24 ? "24:00" : `${h}:00`);
        }
        d.setValue(String(this.plugin.settings.workdayEnd)).onChange(
          async (v) => {
            this.plugin.settings.workdayEnd = parseInt(v, 10);
            await this.plugin.saveSettings();
          }
        );
      });

    new Setting(containerEl)
      .setName("Default task duration")
      .setDesc("Minutes assigned to flexible tasks without an explicit duration (5–60).")
      .addSlider((s) =>
        s
          .setLimits(5, 60, 5)
          .setValue(this.plugin.settings.defaultDuration)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.defaultDuration = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Legend length limit")
      .setDesc("Maximum characters shown for each label on the spiral (15–30).")
      .addSlider((s) =>
        s
          .setLimits(15, 30, 1)
          .setValue(this.plugin.settings.legendLenLimit)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.legendLenLimit = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show playback button")
      .setDesc("Show the hyper-lapse play button that replays the whole day.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showPlaybackButton).onChange(async (v) => {
          this.plugin.settings.showPlaybackButton = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Daily note date format")
      .setDesc(
        "moment.js format matching your daily note filenames (e.g. YYYY-MM-DD). Charts in daily notes plan from the current time; other notes plan from the workday start."
      )
      .addText((t) =>
        t
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.settings.dailyNoteFormat)
          .onChange(async (v) => {
            this.plugin.settings.dailyNoteFormat = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Stamp completion time")
      .setDesc(
        "When you check off a task, append a dHH:MM timestamp so it stays visible on the spiral where it was completed."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.stampOnCheck).onChange(async (v) => {
          this.plugin.settings.stampOnCheck = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Execution layer")
      .setDesc(
        "Enable CLOCK tracking (org-compatible LOGBOOK entries), a standalone POMO, and the Planned vs Actual daily review. Default off."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.executionLayer).onChange(async (v) => {
          this.plugin.settings.executionLayer = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.executionLayer) {
      new Setting(containerEl)
        .setName("Pomodoro threshold")
        .setDesc("Minutes before the POMO signal turns red (0–120).")
        .addSlider((s) =>
          s
            .setLimits(0, 120, 5)
            .setValue(this.plugin.settings.pomodoroThreshold)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.pomodoroThreshold = v;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Recent retention")
        .setDesc(
          "Minutes a finished CLOCK stays in the Timing recents list. 0 disables."
        )
        .addSlider((s) =>
          s
            .setLimits(0, 120, 5)
            .setValue(this.plugin.settings.recentRetention)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.recentRetention = v;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Forgotten timer warning")
        .setDesc(
          "Warn when a CLOCK runs longer than this many minutes. Never stops the CLOCK. 0 disables."
        )
        .addSlider((s) =>
          s
            .setLimits(0, 240, 10)
            .setValue(this.plugin.settings.forgottenTimerWarning)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.forgottenTimerWarning = v;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Highlight tag")
      .setDesc(
        "Tasks containing this tag are drawn with the custom color below (e.g. #focus). Empty disables."
      )
      .addText((t) =>
        t
          .setPlaceholder("#focus")
          .setValue(this.plugin.settings.customColorTag)
          .onChange(async (v) => {
            this.plugin.settings.customColorTag = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight color")
      .setDesc("rgba(...) color for tasks carrying the highlight tag.")
      .addText((t) =>
        t
          .setPlaceholder("rgba(255,0,0,0.5)")
          .setValue(this.plugin.settings.customColor)
          .onChange(async (v) => {
            this.plugin.settings.customColor = v.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
