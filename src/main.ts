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
import { DEFAULT_SETTINGS, NautEvent, NautilusSettings } from "./types";
import {
  bumpProgressInLine,
  fixTaskLines,
  minutesToTime,
  parseRowParams,
  TaskLine,
} from "./parser";
import { addStartAfter } from "./scheduler";
import { WORKDAY_END } from "./geometry";
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

/** Collect list items directly below the code block. */
function collectTasks(lines: string[], fromLine: number): TaskLine[] {
  const out: TaskLine[] = [];
  let started = false;
  for (let i = fromLine; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (started) break;
      continue;
    }
    if (!LIST_RE.test(line)) break;
    started = true;
    const cm = line.match(CHECK_RE);
    let text: string;
    let checked: boolean | null = null;
    if (cm) {
      checked = cm[1].toLowerCase() === "x";
      text = line.slice(cm[0].length);
    } else {
      text = line.replace(LIST_RE, "");
    }
    out.push({ line: i, text, checked });
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
    if (key === "start" && n >= 4 && n <= 12) s.workdayStart = n * 60;
    else if (key === "duration" && n >= 5 && n <= 60) s.defaultDuration = n;
    else if (key === "len" && n >= 15 && n <= 30) s.legendLenLimit = n;
    else if (key === "tag") s.customColorTag = val;
  }
  return s;
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
    for (const t of tasks) {
      const ev = parseRowParams(t.text, t.checked === true, t.line, settings);
      if (!ev) continue;
      if (ev.doneAt != null || (ev.meeting && ev.done)) dones.push(ev);
      else pendings.push(ev);
    }
    this.settings = settings;
    this.pendings = addStartAfter(pendings);
    this.dones = dones;
    this.file = file;
    this.isDaily = isTodayDailyNote(file, this.plugin.settings.dailyNoteFormat);
    this.pageTitle = file.basename;
    this.renderFrame();
  }

  renderFrame(): void {
    const nowMin = this.simMin ?? nowMinutes();
    const planFromTime = this.state.playing
      ? 0
      : this.isDaily
      ? nowMin
      : this.settings.workdayStart;

    this.containerEl.empty();
    const wrap = this.containerEl.createDiv({ cls: "nautilus-container" });

    const controls = wrap.createDiv({ cls: "nautilus-controls-top" });
    const eyeBtn = controls.createEl("button", {
      cls: "nautilus-toggle-btn",
      attr: {
        title: this.state.showDone ? "隐藏已完成事项" : "显示已完成事项",
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
          attr: { title: "回放一整天 (Hyper-lapse playback)" },
        })
      : null;
    if (playBtn) {
      playBtn.innerHTML = PLAY_SVG;
      playBtn.disabled = this.state.playing;
      playBtn.addEventListener("click", () => this.playback());
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
    const tick = (t: number) => {
      const prog = Math.min(1, (t - start) / duration);
      const sim = Math.floor(ws + prog * (WORKDAY_END - ws));
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
        for (let h = 4; h <= 12; h++) {
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
