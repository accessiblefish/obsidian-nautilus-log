import { Platform } from "obsidian";
import { Center, NautEvent, NautilusSettings, Rect } from "./types";
import {
  PI,
  RESERVE,
  MAX_PROFILE_RADIUS,
  SNAIL_PROFILE_RADII,
  angleToRad,
  atVertex,
  createArcPath,
  getHourBoundaries,
  getLegendRect,
  minToAngle,
  profileRadius,
  rawProfileRadius,
  spiralCellInnerIndex,
  posSweepAngleMid,
} from "./geometry";

import { fillDay } from "./scheduler";
import { formatCapacityDuration } from "./capacity";
import {
  availableSlotGroups,
  pastTimelineSegments,
  pastUnplannedSegments,
} from "./timeline";

const FONT_FAMILY =
  "'方正屏显雅宋简体', 'FZPingXianYaSong-R-GBK', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const MEETING_PALETTE = [
  "rgba(252,194,0,0.8)",
  "rgba(252,194,0,0.6)",
  "rgba(252,194,0,0.4)",
  "rgba(252,194,0,0.3)",
];
export const TODO_PALETTE = [
  "rgba(4,100,132,0.3)",
  "rgba(8,153,200,0.3)",
  "rgba(47,186,232,0.3)",
  "rgba(58,202,249,0.3)",
];
const GRAY = "rgba(128,128,128,0.1)";
const CLOCK_HAND_COLOR = "#EA0F0F5B";
const SPIRAL_COLOR = "var(--naut-spiral)";
const BENT_LINE_GAP = 5;
const PLAYBACK_SECONDS = 6;
let chartInstance = 0;
let tooltipInstance = 0;

/**
 * Pop-in delay for the playback animation, in the SAME domain as the
 * pointer sweep: workdayStart..workdayEnd mapped onto the playback
 * duration, clamped so early/late slices just appear at the ends.
 */
function playbackDelay(
  taskStartMin: number | null | undefined,
  workdayStart: number,
  workdayEnd: number
): string {
  const start = taskStartMin ?? workdayStart;
  const frac = Math.min(
    1,
    Math.max(0, (start - workdayStart) / (workdayEnd - workdayStart))
  );
  return `${frac * PLAYBACK_SECONDS}s`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

type SvgAttrs = Record<string, string | number>;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: SvgAttrs = {},
  children: (SVGElement | Text)[] = []
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(c);
  return el;
}

function txt(s: string): Text {
  return document.createTextNode(s);
}

/** Replace the alpha channel of an rgba(...) string. */
function setAlpha(color: string, alpha: string): string {
  return color.replace(/,\s*[\d.]+\)\s*$/, `,${alpha})`);
}

export interface RenderParams {
  settings: NautilusSettings;
  isDaily: boolean;
  pageTitle: string;
  nowMin: number;
  planFromTime: number;
  showDone: boolean;
  playing: boolean;
  /** actual CLOCK arcs, pre-positioned (minutes from midnight, window-aligned) */
  actuals: NautEvent[];
  onProgressClick?: (ev: NautEvent) => void;
}

interface Ctx {
  p: RenderParams;
  center: Center;
  scaler: number;
  fontSize: number;
  innerRadius: number;
  isMobile: boolean;
  dotPatternId: string;
  unplannedPatternId: string;
  tooltip: ChartTooltip;
}

interface TooltipInfo {
  title: string;
  meta: string;
  ariaLabel: string;
  start: number;
  end: number;
}

function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function tooltipInfo(
  title: string,
  kind: string,
  start: number,
  end: number
): TooltipInfo {
  const range = `${clockLabel(start)}–${clockLabel(end)}`;
  const duration = formatCapacityDuration(end - start);
  return {
    title,
    meta: `${kind} · ${range} · ${duration}`,
    ariaLabel: `${title}. ${kind}. ${range}. ${duration}`,
    start,
    end,
  };
}

/** Body-level tooltip shared by mouse and keyboard focus, clipped to viewport. */
class ChartTooltip {
  private el: HTMLDivElement | null = null;
  private owner: SVGGElement | null = null;
  private readonly id = `nautilus-tooltip-${++tooltipInstance}`;

  attach(target: SVGGElement, info: TooltipInfo, ctx: Ctx): void {
    target.addEventListener("mouseenter", () => this.show(target, info, ctx));
    target.addEventListener("mouseleave", () => this.hide(target));
    target.addEventListener("focus", () => this.show(target, info, ctx));
    target.addEventListener("blur", () => this.hide(target));
    target.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.hide(target);
        event.stopPropagation();
      }
    });
  }

  private show(target: SVGGElement, info: TooltipInfo, ctx: Ctx): void {
    this.hide();
    const svg = target.ownerSVGElement;
    if (!svg) return;
    const el = createEl("div", { cls: "nautilus-hover-tooltip" });
    el.id = this.id;
    el.setAttribute("role", "tooltip");
    el.createEl("strong", { text: info.title });
    el.createEl("span", { text: info.meta });
    document.body.appendChild(el);
    this.el = el;
    this.owner = target;
    target.setAttribute("aria-describedby", this.id);

    const mid = posSweepAngleMid(
      angleToRad(minToAngle(info.start)),
      angleToRad(minToAngle(info.end))
    );
    const radius = (MAX_PROFILE_RADIUS + 15) * ctx.scaler;
    const point = { x: ctx.center.cx + Math.cos(mid) * radius, y: ctx.center.cy - Math.sin(mid) * radius };
    const center = { x: ctx.center.cx, y: ctx.center.cy };
    const matrix = svg.getScreenCTM();
    let anchorX: number;
    let anchorY: number;
    let centerX: number;
    let centerY: number;
    if (matrix) {
      const anchor = svg.createSVGPoint();
      anchor.x = point.x;
      anchor.y = point.y;
      const screenAnchor = anchor.matrixTransform(matrix);
      const svgCenter = svg.createSVGPoint();
      svgCenter.x = center.x;
      svgCenter.y = center.y;
      const screenCenter = svgCenter.matrixTransform(matrix);
      anchorX = screenAnchor.x;
      anchorY = screenAnchor.y;
      centerX = screenCenter.x;
      centerY = screenCenter.y;
    } else {
      const rect = target.getBoundingClientRect();
      anchorX = rect.right;
      anchorY = rect.top + rect.height / 2;
      centerX = rect.left;
      centerY = anchorY;
    }

    const dx = anchorX - centerX;
    const dy = anchorY - centerY;
    const preferred = Math.abs(dx) >= Math.abs(dy)
      ? dx < 0 ? "left" : "right"
      : dy < 0 ? "top" : "bottom";
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const gap = 10;
    let left = preferred === "left" ? anchorX - width - gap : anchorX + gap;
    let top = anchorY - height / 2;
    if (preferred === "top" || preferred === "bottom") {
      left = anchorX - width / 2;
      top = preferred === "top" ? anchorY - height - gap : anchorY + gap;
    }
    left = Math.max(12, Math.min(window.innerWidth - width - 12, left));
    top = Math.max(12, Math.min(window.innerHeight - height - 12, top));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.classList.add("is-positioned");
  }

  private hide(target?: SVGGElement): void {
    if (target && this.owner !== target) return;
    this.owner?.removeAttribute("aria-describedby");
    this.el?.remove();
    this.el = null;
    this.owner = null;
  }

  destroy(): void {
    this.hide();
  }
}

/* ------------------------------------------------------------------ *
 * One annular slice (ported from `slice`)
 * ------------------------------------------------------------------ */

interface SliceOpts {
  bgColor?: string | null;
  borderColor?: string | null;
  legendRect?: Rect | null;
  text?: string | null;
  timestamp?: string | null;
  fontWeight?: string | null;
  done?: boolean;
  nonZeroProgress?: boolean;
  clickToProgress?: boolean;
  onClick?: (() => void) | null;
  taskStartMin?: number | null;
  taskEndMin?: number | null;
}

function renderSlice(
  startAngle: number,
  endAngle: number,
  innerRadius: number,
  outerRadius: number,
  ctx: Ctx,
  o: SliceOpts
): SVGGElement {
  const { center, settings } = { center: ctx.center, settings: ctx.p.settings };
  const startRad = angleToRad(startAngle);
  const endRad = angleToRad(endAngle);
  const hasTaskSpan = o.taskStartMin != null && o.taskEndMin != null;
  const midRad = hasTaskSpan
    ? posSweepAngleMid(
        angleToRad(minToAngle(o.taskStartMin!)),
        angleToRad(minToAngle(o.taskEndMin!))
      )
    : posSweepAngleMid(startRad, endRad);
  const lineOuterRadius = hasTaskSpan
    ? profileRadius(
        (o.taskStartMin! + o.taskEndMin!) / 2,
        settings.workdayStart,
        ctx.scaler
      )
    : outerRadius;

  const bg = o.bgColor ?? "rgba(255,255,255,0)";
  const border = o.borderColor ?? "none";
  const dash = o.borderColor != null ? "2,2" : "none";

  const g = svgEl("g");

  if (o.nonZeroProgress) {
    g.appendChild(
      svgEl("path", {
        d: createArcPath(startAngle, endAngle, innerRadius, outerRadius, center),
        fill: `url(#${ctx.dotPatternId})`,
      })
    );
  }

  const path = svgEl("path", {
    d: createArcPath(startAngle, endAngle, innerRadius, outerRadius, center),
    class: "nautilus-slice",
    "stroke-dasharray": dash,
    fill: bg,
    stroke: border,
  });
  // playback pop-in delay: slices appear when the sweeping pointer reaches
  // their start time
  path.style.setProperty(
    "--pb-delay",
    playbackDelay(o.taskStartMin, settings.workdayStart, settings.workdayEnd)
  );
  if (o.clickToProgress && o.onClick) {
    path.classList.add("nautilus-clickable");
    path.addEventListener("click", o.onClick);
  }
  g.appendChild(path);

  // ---- legend (bent connector line + label) ----
  if (o.text && o.legendRect) {
    const rect = o.legendRect;
    const lineStartX =
      center.cx + Math.cos(midRad) * (lineOuterRadius + BENT_LINE_GAP);
    const lineStartY =
      center.cy - Math.sin(midRad) * (lineOuterRadius + BENT_LINE_GAP);
    const legendRad = -rect.realRadians;
    const atV = atVertex(legendRad);
    const onLeft = legendRad <= -PI / 2 || legendRad >= PI / 2;

    let endX: number;
    let endY: number;
    if (atV) {
      endX = rect.x + rect.w / 2;
      endY = rect.y + (legendRad < 0 ? 0 : rect.h);
    } else if (legendRad < PI && legendRad > PI / 2) {
      endX = rect.x + rect.w + BENT_LINE_GAP;
      endY = rect.y + rect.h * Math.sin(legendRad);
    } else if (legendRad < PI / 2 && legendRad > 0) {
      endX = rect.x;
      endY = rect.y + rect.h / 2 + (rect.h * Math.sin(legendRad)) / 2;
    } else if (legendRad < 0 && legendRad > -PI / 2) {
      endX = rect.x;
      endY = rect.y + (rect.h * Math.cos(legendRad)) / 2;
    } else {
      endX = rect.x + rect.w + BENT_LINE_GAP;
      endY = rect.y + ((Math.sin(legendRad) + 1) / 2) * rect.h;
    }

    const legendColor = o.done ? setAlpha(bg, "0.2") : setAlpha(bg, "1");
    const midX = (lineStartX + endX) / 2;
    const midY = (lineStartY + endY) / 2 + 15;

    const group = svgEl("g", { class: "nautilus-slice-group" });
    group.style.setProperty(
      "--pb-delay",
      playbackDelay(o.taskStartMin, settings.workdayStart, settings.workdayEnd)
    );
    group.appendChild(
      svgEl("path", {
        d: `M ${lineStartX},${lineStartY} Q ${midX},${midY} ${endX},${endY}`,
        class: "nautilus-link-line",
        stroke: legendColor,
        "stroke-width": "1.5px",
        fill: "none",
      })
    );
    const textX = atV ? endX : endX + (onLeft ? -BENT_LINE_GAP : BENT_LINE_GAP);
    const anchor = atV ? "middle" : onLeft ? "end" : "start";
    const t = svgEl(
      "text",
      {
        x: textX,
        y: rect.y + rect.h,
        "text-anchor": anchor,
        "alignment-baseline": "baseline",
        "font-weight": o.fontWeight ?? "normal",
        "text-decoration": o.done ? "line-through" : "none",
        fill: o.done ? setAlpha(bg, "0.5") : setAlpha(bg, "1"),
      },
      [txt(o.text.substring(0, settings.legendLenLimit))]
    );
    if (o.clickToProgress && o.onClick) {
      t.classList.add("nautilus-clickable");
      t.addEventListener("click", o.onClick);
    }
    group.appendChild(t);
    g.appendChild(group);
  }

  // ---- hour label on the spiral template ----
  if (o.timestamp) {
    const tx = center.cx + Math.cos(startRad) * (outerRadius - 10);
    const ty = center.cy - Math.sin(startRad) * (outerRadius - 10);
    const upright = startAngle >= 270 || startAngle <= 90;
    g.appendChild(
      svgEl(
        "text",
        {
          x: tx,
          y: ty,
          "font-size": ctx.fontSize - 3,
          "font-family": FONT_FAMILY,
          fill: border,
          transform: `rotate(${
            upright ? startAngle : startAngle - 180
          } ${tx},${ty})`,
          "text-anchor": "middle",
          "alignment-baseline": upright ? "after-edge" : "before-edge",
        },
        [txt(o.timestamp)]
      )
    );
  }

  return g;
}

/* ------------------------------------------------------------------ *
 * Spiral blueprint (hour ring template)
 * ------------------------------------------------------------------ */

function cellInnerRadius(minute: number, ctx: Ctx): number {
  const innerIdx = spiralCellInnerIndex(
    minute,
    ctx.p.settings.workdayEnd,
    ctx.p.settings.workdayStart
  );
  return innerIdx != null
    ? Math.max(ctx.innerRadius, SNAIL_PROFILE_RADII[innerIdx] * ctx.scaler)
    : ctx.innerRadius;
}

function renderBlueprint(ctx: Ctx): SVGGElement {
  const g = svgEl("g", { class: "nautilus-grid", "aria-hidden": "true" });
  const ws = ctx.p.settings.workdayStart;
  const we = ctx.p.settings.workdayEnd;
  // one cell per hour across the whole window (which may cross midnight);
  // when the window spans more than 12h, earlier cells raise their inner
  // radius so the +12h paired cell on the same angle stays visible
  for (let m = ws; m < we; m += 60) {
    const end = Math.min(we, m + 60);
    g.appendChild(
      renderSlice(minToAngle(m), minToAngle(end), cellInnerRadius(m, ctx), profileRadius(m, ws, ctx.scaler), ctx, {
        borderColor: SPIRAL_COLOR,
        timestamp: String(Math.floor(m / 60) % 24),
      })
    );
  }
  // tip label "0" when the window ends exactly at midnight
  if (we % 1440 === 0) {
    const rad = angleToRad(minToAngle(we));
    const r = profileRadius(we - 60, ws, ctx.scaler) + 12;
    g.appendChild(
      svgEl(
        "text",
        {
          x: ctx.center.cx + Math.cos(rad) * r,
          y: ctx.center.cy - Math.sin(rad) * r,
          "font-size": ctx.fontSize - 3,
          fill: SPIRAL_COLOR,
          "text-anchor": "middle",
          "alignment-baseline": "central",
        },
        [txt("0")]
      )
    );
  }
  return g;
}

function renderPastOverlays(
  occupiedEvents: NautEvent[],
  ctx: Ctx
): SVGGElement | null {
  if (!ctx.p.isDaily && !ctx.p.playing) return null;
  const { workdayStart, workdayEnd } = ctx.p.settings;
  const g = svgEl("g", { "aria-hidden": "true" });
  const past = svgEl("g", { class: "nautilus-past-overlay" });
  for (const segment of pastTimelineSegments(
    workdayStart,
    workdayEnd,
    ctx.p.nowMin
  )) {
    past.appendChild(
      svgEl("path", {
        d: createArcPath(
          minToAngle(segment.start),
          minToAngle(segment.end),
          cellInnerRadius(segment.start, ctx),
          profileRadius(segment.start, workdayStart, ctx.scaler),
          ctx.center
        ),
      })
    );
  }
  g.appendChild(past);

  const unplanned = svgEl("g", { class: "nautilus-unplanned-overlay" });
  for (const segment of pastUnplannedSegments({
    startMinutes: workdayStart,
    endMinutes: workdayEnd,
    nowMinutes: ctx.p.nowMin,
    occupiedEvents,
  })) {
    unplanned.appendChild(
      svgEl("path", {
        d: createArcPath(
          minToAngle(segment.start),
          minToAngle(segment.end),
          cellInnerRadius(segment.start, ctx),
          profileRadius(segment.start, workdayStart, ctx.scaler),
          ctx.center
        ),
        fill: `url(#${ctx.unplannedPatternId})`,
      })
    );
  }
  g.appendChild(unplanned);
  return g;
}

function renderAvailableSlots(events: NautEvent[], ctx: Ctx): SVGGElement {
  const { workdayStart, workdayEnd } = ctx.p.settings;
  const slots = availableSlotGroups({
    events,
    startMinutes: workdayStart,
    endMinutes: workdayEnd,
    nowMinutes: ctx.p.nowMin,
    clampToNow: ctx.p.isDaily || ctx.p.playing,
  });
  const root = svgEl("g", { class: "nautilus-available-slots" });
  for (const slot of slots) {
    const info = tooltipInfo(
      slot.availableNow ? "Available now" : "Available slot",
      "Available",
      slot.start,
      slot.end
    );
    const group = svgEl("g", {
      class: "nautilus-available-slot" + (slot.availableNow ? " is-now" : ""),
      tabindex: 0,
      focusable: "true",
      role: "img",
      "aria-label": info.ariaLabel,
    });
    ctx.tooltip.attach(group, info, ctx);
    for (const segment of slot.segments) {
      group.appendChild(
        svgEl("path", {
          class: "nautilus-available-slot-hit",
          d: createArcPath(
            minToAngle(segment.start),
            minToAngle(segment.end),
            cellInnerRadius(segment.start, ctx),
            profileRadius(segment.start, workdayStart, ctx.scaler),
            ctx.center
          ),
          "vector-effect": "non-scaling-stroke",
        })
      );
    }
    root.appendChild(group);
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * Events -> slices
 * ------------------------------------------------------------------ */

function sliceParams(
  event: NautEvent,
  index: number,
  p: RenderParams
): { bg: string | null; done: boolean; clickToProgress: boolean } {
  const expired = event.meeting && p.isDaily && p.nowMin >= event.end;
  let bg: string | null = null;
  if (event.actual) {
    // actual CLOCK arc: own hue, dot pattern, never clickable/grayed
    bg = event.bgColor ?? TODO_PALETTE[index % TODO_PALETTE.length];
  } else if (event.meeting) {
    bg = expired
      ? GRAY
      : event.bgColor ?? MEETING_PALETTE[index % MEETING_PALETTE.length];
  } else if (event.todo) {
    bg =
      event.doneAt != null
        ? GRAY
        : event.bgColor ?? TODO_PALETTE[index % TODO_PALETTE.length];
  }
  return {
    bg,
    done: event.done,
    clickToProgress: !event.actual && p.isDaily && event.todo,
  };
}

function eventSlices(
  event: NautEvent,
  index: number,
  legendRect: Rect | null,
  ctx: Ctx
): SVGGElement {
  const { p } = ctx;
  const { bg, done, clickToProgress } = sliceParams(event, index, p);
  const group = svgEl("g", {
    class: "event-slice-group",
    tabindex: 0,
    focusable: "true",
    role: clickToProgress ? "button" : "img",
  });
  const kind = event.actual ? "Actual" : event.meeting ? "Event" : "Task";
  const info = tooltipInfo(event.description, kind, event.start, event.end);
  group.setAttribute("aria-label", info.ariaLabel);
  ctx.tooltip.attach(group, info, ctx);
  if (clickToProgress && p.onProgressClick) {
    group.addEventListener("keydown", (keyboardEvent) => {
      if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
        keyboardEvent.preventDefault();
        p.onProgressClick!(event);
      }
    });
  }

  const segments: [number, number][] = [];
  let curr = event.start;
  for (const b of getHourBoundaries(event.start, event.end)) {
    segments.push([curr, b]);
    curr = b;
  }
  if (curr < event.end) segments.push([curr, event.end]);

  segments.forEach(([s, e], idx) => {
    group.appendChild(
      renderSlice(
        minToAngle(s),
        minToAngle(e),
        ctx.innerRadius,
        profileRadius(s, ctx.p.settings.workdayStart, ctx.scaler),
        ctx,
        {
          bgColor: bg,
          text: idx === 0 ? event.description : null,
          legendRect: idx === 0 ? legendRect : null,
          done,
          fontWeight: "bold",
          nonZeroProgress: event.progress > 0 || event.actual === true,
          clickToProgress,
          onClick:
            clickToProgress && p.onProgressClick
              ? () => p.onProgressClick!(event)
              : null,
          taskStartMin: event.start,
          taskEndMin: event.end,
        }
      )
    );
  });
  return group;
}

function eventsToSlices(
  events: NautEvent[],
  ctx: Ctx,
  initRects: Rect[]
): [SVGGElement, Rect[]] {
  const g = svgEl("g");
  const rects = [...initRects];
  let i = 0;
  for (const event of events) {
    if (event.freetime) continue;
    if (event.noLegend) {
      g.appendChild(eventSlices(event, i, null, ctx));
      i++;
      continue;
    }
    const midRad = posSweepAngleMid(
      angleToRad(minToAngle(event.start)),
      angleToRad(minToAngle(event.end))
    );
    const radius = rawProfileRadius(event.start, ctx.p.settings.workdayStart);
    const rect = getLegendRect(
      rects,
      event.description,
      midRad,
      radius,
      ctx.center,
      ctx.p.settings,
      ctx.fontSize,
      ctx.isMobile
    );
    rects.push(rect);
    g.appendChild(eventSlices(event, i, rect, ctx));
    i++;
  }
  return [g, rects];
}

/**
 * Compute the viewBox dimensions and center so all legends fit,
 * ported from events->new-dimensions.
 */
function eventsToNewDimensions(
  events: NautEvent[],
  center0: Center,
  ctx: Omit<Ctx, "center">
): [number, number, number, number] {
  // initial bounding box: sample the spiral itself (every 15 min across the
  // window) since the radius profile is anchored to the workday start
  const ws = ctx.p.settings.workdayStart;
  const we = ctx.p.settings.workdayEnd;
  let leftMin = center0.cx;
  let rightMax = center0.cx;
  let topMin = center0.cy;
  let bottomMax = center0.cy;
  for (let m = ws; m <= we; m += 15) {
    const r = profileRadius(Math.min(m, we - 1), ws, ctx.scaler) + 16;
    const rad = angleToRad(minToAngle(m));
    leftMin = Math.min(leftMin, center0.cx + Math.cos(rad) * r);
    rightMax = Math.max(rightMax, center0.cx + Math.cos(rad) * r);
    topMin = Math.min(topMin, center0.cy - Math.sin(rad) * r);
    bottomMax = Math.max(bottomMax, center0.cy - Math.sin(rad) * r);
  }
  const rects: Rect[] = [];
  for (const event of events) {
    if (event.freetime || event.noLegend) continue;
    const midRad = posSweepAngleMid(
      angleToRad(minToAngle(event.start)),
      angleToRad(minToAngle(event.end))
    );
    const radius = rawProfileRadius(event.start, ws);
    const rect = getLegendRect(
      rects,
      event.description,
      midRad,
      radius,
      center0,
      ctx.p.settings,
      ctx.fontSize,
      ctx.isMobile
    );
    rects.push(rect);
    leftMin = Math.min(leftMin, rect.x);
    rightMax = Math.max(rightMax, rect.x + rect.w);
    topMin = Math.min(topMin, rect.y);
    bottomMax = Math.max(bottomMax, rect.y + rect.h);
  }
  return [
    RESERVE + center0.cx - leftMin,
    RESERVE + rightMax - leftMin,
    RESERVE + center0.cy - topMin,
    3 * RESERVE + (bottomMax - topMin),
  ];
}

/* ------------------------------------------------------------------ *
 * Center label + now pointer
 * ------------------------------------------------------------------ */

function renderCentralLabel(
  pageTitle: string,
  ctx: Ctx,
  nowLabel: string | null
): SVGGElement {
  const rows = pageTitle
    .split(/,(.+)/)
    .filter((s) => s !== undefined && s !== "")
    .slice(0, 2)
    .map((s) => s.substring(0, 16));
  if (rows.length === 0) rows.push(pageTitle.substring(0, 16));
  const { cx, cy } = ctx.center;
  const g = svgEl("g", { class: "nautilus-center-date" });
  g.appendChild(
    svgEl(
      "text",
      {
        x: cx,
        y: cy - 2,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        fill: "var(--naut-text-main)",
        "font-weight": "bold",
        "font-size": ctx.fontSize * 0.85,
      },
      [txt(rows[0])]
    )
  );
  if (nowLabel || rows.length > 1) {
    g.appendChild(
      svgEl(
        "text",
        {
          x: cx,
          y: cy + 13,
          "text-anchor": "middle",
          "dominant-baseline": "central",
          class: nowLabel ? "nautilus-center-now" : "",
          fill: nowLabel ? CLOCK_HAND_COLOR : "var(--naut-text-sub)",
          "font-weight": "500",
          "font-size": ctx.fontSize * 0.7,
        },
        [txt(nowLabel ?? rows[1])]
      )
    );
  }
  return g;
}

function renderNowPointer(ctx: Ctx): SVGLineElement {
  const line = svgEl("line", {
    class: "nautilus-now-pointer",
    stroke: CLOCK_HAND_COLOR,
    "stroke-width": 2,
    "stroke-linecap": "round",
  });
  setPointerPosition(line, ctx.p.nowMin, ctx);
  return line;
}

function setPointerPosition(line: SVGLineElement, nowMin: number, ctx: Ctx): void {
  const nowRad = angleToRad(minToAngle(nowMin));
  const r1 = ctx.innerRadius + 2;
  const r2 = MAX_PROFILE_RADIUS + 15;
  line.setAttribute("x1", String(ctx.center.cx + r1 * Math.cos(nowRad)));
  line.setAttribute("y1", String(ctx.center.cy - r1 * Math.sin(nowRad)));
  line.setAttribute("x2", String(ctx.center.cx + r2 * Math.cos(nowRad)));
  line.setAttribute("y2", String(ctx.center.cy - r2 * Math.sin(nowRad)));
}

/* ------------------------------------------------------------------ *
 * Top level
 * ------------------------------------------------------------------ */

export interface NautilusRender {
  svg: SVGSVGElement;
  /** Move the now-pointer without rebuilding the DOM (used during playback). */
  setPointer: (nowMin: number) => void;
  /** Todos that did not fit into the workday window. */
  overflow: NautEvent[];
  /** Remove body-level tooltip state before this chart is replaced. */
  destroy: () => void;
}

export function buildNautilusSvg(
  pendings: NautEvent[],
  dones: NautEvent[],
  p: RenderParams
): NautilusRender {
  const isMobile = Platform.isMobile;
  const scaler = isMobile ? 0.7 : 1;
  const fontSize = isMobile ? 12 : 14;
  const w0 = isMobile ? 450 : 600;
  const h0 = 0.7 * w0;
  const innerRadius = 50 * scaler;
  const instance = ++chartInstance;
  const dotPatternId = `nautilus-dot-pattern-${instance}`;
  const unplannedPatternId = `nautilus-unplanned-pattern-${instance}`;
  const tooltip = new ChartTooltip();

  // Actual CLOCK arcs block planned placement: tracked time is already
  // spent, so pending todos must flow around it. This only bites during
  // playback (planFromTime = 0), where the naive plan would otherwise be
  // laid out on top of the arcs; in the live view every arc ends before
  // "now", so placement is unchanged. Blockers are filtered back out of
  // the schedule — actual arcs render from p.actuals, not from slices.
  const blockers = p.actuals.map((a) => ({
    ...a,
    meeting: true,
    todo: false,
    noLegend: true,
  }));
  const { scheduled: laid, overflow } = fillDay(
    [...pendings, ...blockers],
    p.settings.workdayStart,
    p.settings.workdayEnd,
    p.planFromTime
  );
  const scheduled = laid.filter((e) => !e.actual);
  // actual arcs of done tasks follow the showDone toggle; pending ones stay
  const visibleActuals = p.actuals.filter((a) => p.showDone || !a.done);
  const allForDim = [
    ...scheduled,
    ...(p.showDone ? dones : []),
    ...visibleActuals,
  ];

  const baseCtx = {
    p,
    scaler,
    fontSize,
    innerRadius,
    isMobile,
    dotPatternId,
    unplannedPatternId,
    tooltip,
  };
  const [cx, width, cy, height] = eventsToNewDimensions(
    allForDim,
    { cx: w0 / 2, cy: h0 / 2 },
    baseCtx
  );
  const ctx: Ctx = { ...baseCtx, center: { cx, cy } };

  const [slicesG, rects] = eventsToSlices(scheduled, ctx, []);
  const [doneG, rects2] = p.showDone
    ? eventsToSlices(dones, ctx, rects)
    : [null, rects];
  const actualG = eventsToSlices(visibleActuals, ctx, rects2)[0];

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    xmlns: SVG_NS,
    class: "nautilus-svg" + (p.playing ? " playback-active" : ""),
    "font-family": FONT_FAMILY,
    "font-size": fontSize,
  });
  svg.style.maxWidth = `${width}px`;

  const defs = svgEl("defs");
  const pattern = svgEl("pattern", {
    id: dotPatternId,
    width: 4,
    height: 4,
    patternUnits: "userSpaceOnUse",
  });
  pattern.appendChild(svgEl("circle", { r: 0.5, cx: 1, cy: 1, fill: "gray" }));
  pattern.appendChild(svgEl("circle", { r: 0.5, cx: 5, cy: 5, fill: "gray" }));
  defs.appendChild(pattern);
  const unplannedPattern = svgEl("pattern", {
    id: unplannedPatternId,
    class: "nautilus-unplanned-pattern",
    width: 7,
    height: 7,
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  });
  unplannedPattern.appendChild(
    svgEl("line", {
      class: "nautilus-unplanned-stripe",
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 7,
    })
  );
  defs.appendChild(unplannedPattern);
  svg.appendChild(defs);

  const past = renderPastOverlays(
    [...scheduled.filter((event) => !event.freetime), ...dones, ...p.actuals],
    ctx
  );
  if (past) svg.appendChild(past);
  svg.appendChild(renderBlueprint(ctx));
  if (doneG) svg.appendChild(doneG);
  svg.appendChild(slicesG);
  svg.appendChild(actualG);
  svg.appendChild(renderAvailableSlots(scheduled, ctx));
  const showNow =
    (p.isDaily || p.playing) &&
    p.nowMin >= p.settings.workdayStart &&
    p.nowMin < p.settings.workdayEnd;
  let pointer: SVGLineElement | null = null;
  if (showNow) {
    pointer = renderNowPointer(ctx);
    svg.appendChild(pointer);
  }
  svg.appendChild(
    renderCentralLabel(p.pageTitle, ctx, showNow ? clockLabel(p.nowMin) : null)
  );
  const centerNow = svg.querySelector(".nautilus-center-now");

  return {
    svg,
    setPointer: (nowMin: number) => {
      if (pointer) setPointerPosition(pointer, nowMin, ctx);
      if (centerNow) centerNow.textContent = clockLabel(nowMin);
    },
    overflow,
    destroy: () => tooltip.destroy(),
  };
}
