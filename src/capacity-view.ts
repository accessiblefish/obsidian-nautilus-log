import { setIcon } from "obsidian";
import { CapacityMetric, CapacityMetrics } from "./capacity";

function summaryItem(parent: HTMLElement, metric: CapacityMetric): void {
  const item = parent.createSpan({
    cls: `nautilus-metric-summary-item nautilus-metric--${metric.tone}`,
  });
  item.createEl("strong", { cls: "nautilus-metric-value", text: metric.value });
  item.createSpan({
    cls: "nautilus-metric-summary-label",
    text: metric.summaryLabel ?? metric.label,
  });
}

function separator(parent: HTMLElement): void {
  parent.createSpan({
    cls: "nautilus-metric-separator",
    text: "·",
    attr: { "aria-hidden": "true" },
  });
}

function reading(parent: HTMLElement, metric: CapacityMetric): void {
  const row = parent.createDiv({
    cls: `nautilus-metric nautilus-metric--${metric.tone}`,
  });
  row.createSpan({ cls: "nautilus-metric-label", text: metric.label });
  const value = row.createSpan({ cls: "nautilus-metric-reading" });
  value.createEl("strong", { cls: "nautilus-metric-value", text: metric.value });
  if (metric.total) {
    value.createSpan({ cls: "nautilus-metric-total", text: `/ ${metric.total}` });
  }
  if (metric.burning) {
    const flame = value.createSpan({
      cls: "nautilus-burning-icon",
      attr: { title: metric.burningLabel ?? "", "aria-label": metric.burningLabel ?? "" },
    });
    setIcon(flame, "flame");
  }
}

/** Render the original Planned / Free / Left and Available / Events header. */
export function renderCapacityMetrics(
  container: HTMLElement,
  metrics: CapacityMetrics
): void {
  const ordered = [metrics.planned, metrics.status, metrics.available, metrics.events];
  const ariaLabel = ordered
    .map(
      (metric) =>
        `${metric.label} ${metric.value}${metric.total ? ` / ${metric.total}` : ""}`
    )
    .concat(`${metrics.planned.percent} ${metrics.planned.percentLabel}`)
    .join(", ");
  const root = container.createDiv({
    cls: "nautilus-metrics",
    attr: { "aria-label": ariaLabel },
  });

  const summary = root.createDiv({ cls: "nautilus-metrics-summary" });
  summaryItem(summary, metrics.planned);
  separator(summary);
  summaryItem(summary, metrics.status);
  separator(summary);
  const percent = summary.createSpan({
    cls: `nautilus-metric-summary-item nautilus-metric-percent nautilus-metric-percent--${metrics.planned.percentTone}`,
  });
  percent.createEl("strong", {
    cls: "nautilus-metric-value",
    text: metrics.planned.percent,
  });
  percent.createSpan({
    cls: "nautilus-metric-summary-label",
    text: metrics.planned.percentLabel,
  });

  const capacity = root.createDiv({ cls: "nautilus-metrics-capacity" });
  reading(capacity, metrics.available);
  reading(capacity, metrics.events);
}
