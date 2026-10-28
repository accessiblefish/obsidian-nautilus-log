import { App, Modal, Notice, setIcon } from "obsidian";
import { formatCapacityDuration } from "./capacity";
import { DeskTask, TaskLogEntry } from "./log";

export interface DeskModalHandlers {
  loadLogs: (task: DeskTask) => Promise<TaskLogEntry[]>;
  appendLog: (task: DeskTask, text: string) => Promise<TaskLogEntry | null>;
  openTask: (task: DeskTask) => Promise<void>;
}

/** Task cards below one Nautilus chart; click enters the logging modal. */
export function renderDeskCards(
  container: HTMLElement,
  tasks: DeskTask[],
  onOpen: (index: number) => void
): void {
  if (tasks.length === 0) return;
  const root = container.createDiv({ cls: "nautilus-desk" });
  root.createDiv({
    cls: "nautilus-desk-heading",
    text: `nautilus task (${tasks.length})`,
  });
  const grid = root.createDiv({ cls: "nautilus-desk-grid" });
  tasks.forEach((task, index) => {
    const card = grid.createEl("button", {
      cls: "nautilus-desk-card",
      attr: {
        type: "button",
        "aria-label": `Open log for ${task.description}`,
      },
    });
    card.createSpan({ cls: "nautilus-desk-card-title", text: task.description });
    card.createSpan({
      cls: "nautilus-desk-card-duration",
      text: formatCapacityDuration(task.duration),
    });
    if (task.latestLog) {
      const time = /(\d{2}:\d{2})$/.exec(task.latestLog.stamp)?.[1];
      card.createSpan({
        cls: "nautilus-desk-card-log",
        text: `${time ? `${time} · ` : ""}${task.latestLog.text}`,
        attr: { title: task.latestLog.text },
      });
    }
    card.addEventListener("click", () => onOpen(index));
  });
}

/** Minimal single-task logging surface with seamless previous/next navigation. */
export class DeskModal extends Modal {
  private index: number;
  private input: HTMLInputElement | null = null;
  private addButton: HTMLButtonElement | null = null;
  private previousButton: HTMLButtonElement | null = null;
  private nextButton: HTMLButtonElement | null = null;
  private logsEl: HTMLElement | null = null;
  private busy = false;
  private renderSeq = 0;

  constructor(
    app: App,
    private sourceTitle: string,
    private tasks: DeskTask[],
    initialIndex: number,
    private handlers: DeskModalHandlers
  ) {
    super(app);
    this.index = initialIndex;
  }

  onOpen(): void {
    this.modalEl.addClass("nautilus-desk-modal");
    this.setTitle("nautilus task");
    this.render();
    this.scope.register(["Mod", "Alt"], "ArrowLeft", () => {
      void this.navigate(-1);
      return false;
    });
    this.scope.register(["Mod", "Alt"], "ArrowRight", () => {
      void this.navigate(1);
      return false;
    });
  }

  onClose(): void {
    this.renderSeq++;
    if (!this.busy && this.input?.value.trim()) void this.appendCurrentLog();
    this.contentEl.empty();
  }

  private currentTask(): DeskTask {
    return this.tasks[this.index];
  }

  private render(): void {
    const seq = ++this.renderSeq;
    const task = this.currentTask();
    this.contentEl.empty();

    const nav = this.contentEl.createDiv({ cls: "nautilus-desk-modal-nav" });
    this.previousButton = nav.createEl("button", {
      cls: "nautilus-desk-icon-btn",
      attr: { type: "button", title: "Previous task", "aria-label": "Previous task" },
    });
    setIcon(this.previousButton, "chevron-left");
    this.previousButton.addEventListener("click", () => void this.navigate(-1));
    nav.createSpan({
      cls: "nautilus-desk-position",
      text: `${this.index + 1} / ${this.tasks.length}`,
    });
    this.nextButton = nav.createEl("button", {
      cls: "nautilus-desk-icon-btn",
      attr: { type: "button", title: "Next task", "aria-label": "Next task" },
    });
    setIcon(this.nextButton, "chevron-right");
    this.nextButton.addEventListener("click", () => void this.navigate(1));

    this.contentEl.createDiv({
      cls: "nautilus-desk-source",
      text: this.sourceTitle,
    });
    const heading = this.contentEl.createDiv({ cls: "nautilus-desk-task" });
    heading.createSpan({ cls: "nautilus-desk-task-title", text: task.description });
    heading.createSpan({
      cls: "nautilus-desk-task-duration",
      text: formatCapacityDuration(task.duration),
    });

    this.logsEl = this.contentEl.createDiv({ cls: "nautilus-desk-logs" });
    this.logsEl.createDiv({ cls: "nautilus-desk-empty", text: "Loading logs…" });

    const composer = this.contentEl.createDiv({ cls: "nautilus-desk-composer" });
    this.input = composer.createEl("input", {
      cls: "nautilus-desk-input",
      attr: {
        type: "text",
        placeholder: "Write a log entry…",
        "aria-label": `Log entry for ${task.description}`,
      },
    });
    this.addButton = composer.createEl("button", {
      cls: "nautilus-desk-add",
      text: "Log",
      attr: { type: "button" },
    });
    this.addButton.addEventListener("click", () => void this.appendCurrentLog());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void this.appendCurrentLog();
      }
    });

    const footer = this.contentEl.createDiv({ cls: "nautilus-desk-footer" });
    footer.createSpan({ text: "Ctrl/Cmd + Alt + ← / →" });
    const open = footer.createEl("button", {
      cls: "nautilus-desk-open",
      text: "Open task note",
      attr: { type: "button" },
    });
    open.addEventListener("click", () => void this.openCurrentTask());
    this.updateButtons();
    void this.loadCurrentLogs(seq);
    window.setTimeout(() => this.input?.focus(), 0);
  }

  private async loadCurrentLogs(seq: number): Promise<void> {
    const task = this.currentTask();
    const logs = await this.handlers.loadLogs(task);
    if (seq !== this.renderSeq || !this.logsEl || task.line !== this.currentTask().line) return;
    this.logsEl.empty();
    if (logs.length === 0) {
      this.logsEl.createDiv({
        cls: "nautilus-desk-empty",
        text: "No log entries yet. Write the first one below.",
      });
      return;
    }
    for (const entry of logs) this.appendLogElement(entry);
  }

  private appendLogElement(entry: TaskLogEntry): void {
    if (!this.logsEl) return;
    this.logsEl.querySelector(".nautilus-desk-empty")?.remove();
    const row = this.logsEl.createDiv({ cls: "nautilus-desk-log" });
    row.createEl("time", {
      cls: "nautilus-desk-log-time",
      text: /(\d{2}:\d{2})$/.exec(entry.stamp)?.[1] ?? entry.stamp,
    });
    row.createSpan({ cls: "nautilus-desk-log-text", text: entry.text });
  }

  private updateButtons(): void {
    if (this.previousButton) {
      this.previousButton.disabled = this.busy || this.index === 0;
    }
    if (this.nextButton) {
      this.nextButton.disabled = this.busy || this.index === this.tasks.length - 1;
    }
    if (this.addButton) this.addButton.disabled = this.busy;
    if (this.input) this.input.disabled = this.busy;
  }

  /** Returns false when the task changed or persistence failed. */
  private async appendCurrentLog(): Promise<boolean> {
    if (this.busy || !this.input) return false;
    const text = this.input.value.trim();
    if (!text) return true;
    const task = this.currentTask();
    this.busy = true;
    this.updateButtons();
    try {
      const entry = await this.handlers.appendLog(task, text);
      if (!entry) {
        new Notice("Nautilus Log: the task changed, so the log was not saved.");
        return false;
      }
      if (task.line === this.currentTask().line && this.input) {
        if (this.input.value.trim() === text) this.input.value = "";
        this.appendLogElement(entry);
      }
      // Inserting a child shifts later tasks; keep session line hints fresh.
      for (let i = this.index + 1; i < this.tasks.length; i++) {
        this.tasks[i].line++;
      }
      return true;
    } catch (error) {
      console.error("[Nautilus Log] Desk log write failed", error);
      new Notice("Nautilus Log: the log could not be saved.");
      return false;
    } finally {
      this.busy = false;
      this.updateButtons();
      this.input?.focus();
    }
  }

  private async navigate(offset: number): Promise<void> {
    if (this.busy) return;
    const nextIndex = this.index + offset;
    if (nextIndex < 0 || nextIndex >= this.tasks.length) return;
    if (!(await this.appendCurrentLog())) return;
    this.index = nextIndex;
    this.render();
  }

  private async openCurrentTask(): Promise<void> {
    if (this.busy || !(await this.appendCurrentLog())) return;
    const task = this.currentTask();
    this.close();
    await this.handlers.openTask(task);
  }
}
