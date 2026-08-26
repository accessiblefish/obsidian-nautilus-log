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

const FONT_FAMILY =
  "'方正屏显雅宋简体', 'FZPingXianYaSong-R-GBK', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const MEETING_PALETTE = [
  "rgba(252,194,0,0.8)",
  "rgba(252,194,0,0.6)",
  "rgba(252,194,0,0.4)",
  "rgba(252,194,0,0.3)",
];
const TODO_PALETTE = [
  "rgba(4,100,132,0.3)",
  "rgba(8,153,200,0.3)",
  "rgba(47,186,232,0.3)",
  "rgba(58,202,249,0.3)",
];
const GRAY = "rgba(128,128,128,0.1)";
const CLOCK_HAND_COLOR = "#EA0F0F5B";
const SPIRAL_COLOR = "var(--naut-spiral)";
const BENT_LINE_GAP = 5;
const DOT_PATTERN_ID = "nautilus-dot-pattern";
const PLAYBACK_SECONDS = 6;

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
  onProgressClick?: (ev: NautEvent) => void;
}

interface Ctx {
  p: RenderParams;
  center: Center;
  scaler: number;
  fontSize: number;
  innerRadius: number;
  isMobile: boolean;
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
        fill: `url(#${DOT_PATTERN_ID})`,
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

function renderBlueprint(ctx: Ctx): SVGGElement {
  const g = svgEl("g");
  const ws = ctx.p.settings.workdayStart;
  const we = ctx.p.settings.workdayEnd;
  // one cell per hour across the whole window (which may cross midnight);
  // when the window spans more than 12h, earlier cells raise their inner
  // radius so the +12h paired cell on the same angle stays visible
  for (let m = ws; m < we; m += 60) {
    const end = Math.min(we, m + 60);
    const innerIdx = spiralCellInnerIndex(m, we, ws);
    const innerR =
      innerIdx != null
        ? Math.max(ctx.innerRadius, SNAIL_PROFILE_RADII[innerIdx] * ctx.scaler)
        : ctx.innerRadius;
    g.appendChild(
      renderSlice(minToAngle(m), minToAngle(end), innerR, profileRadius(m, ws, ctx.scaler), ctx, {
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
  if (event.meeting) {
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
    clickToProgress: p.isDaily && event.todo,
  };
}

function eventSlices(
  event: NautEvent,
  index: number,
  legendRect: Rect,
  ctx: Ctx
): SVGGElement {
  const { p } = ctx;
  const { bg, done, clickToProgress } = sliceParams(event, index, p);
  const group = svgEl("g", { class: "event-slice-group" });

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
          nonZeroProgress: event.progress > 0,
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
    if (event.freetime) continue;
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

function renderCentralLabel(pageTitle: string, ctx: Ctx): SVGGElement {
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
  if (rows.length > 1) {
    g.appendChild(
      svgEl(
        "text",
        {
          x: cx,
          y: cy + 13,
          "text-anchor": "middle",
          "dominant-baseline": "central",
          fill: "var(--naut-text-sub)",
          "font-weight": "500",
          "font-size": ctx.fontSize * 0.7,
        },
        [txt(rows[1])]
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

  const { scheduled, overflow } = fillDay(
    pendings,
    p.settings.workdayStart,
    p.settings.workdayEnd,
    p.planFromTime
  );
  const allForDim = p.showDone ? [...scheduled, ...dones] : scheduled;

  const baseCtx = { p, scaler, fontSize, innerRadius, isMobile };
  const [cx, width, cy, height] = eventsToNewDimensions(
    allForDim,
    { cx: w0 / 2, cy: h0 / 2 },
    baseCtx
  );
  const ctx: Ctx = { ...baseCtx, center: { cx, cy } };

  const [slicesG, rects] = eventsToSlices(scheduled, ctx, []);
  const doneG = p.showDone ? eventsToSlices(dones, ctx, rects)[0] : null;

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
    id: DOT_PATTERN_ID,
    width: 4,
    height: 4,
    patternUnits: "userSpaceOnUse",
  });
  pattern.appendChild(svgEl("circle", { r: 0.5, cx: 1, cy: 1, fill: "gray" }));
  pattern.appendChild(svgEl("circle", { r: 0.5, cx: 5, cy: 5, fill: "gray" }));
  defs.appendChild(pattern);
  svg.appendChild(defs);

  svg.appendChild(renderBlueprint(ctx));
  if (doneG) svg.appendChild(doneG);
  svg.appendChild(slicesG);
  let pointer: SVGLineElement | null = null;
  if (p.isDaily || p.playing) {
    pointer = renderNowPointer(ctx);
    svg.appendChild(pointer);
  }
  svg.appendChild(renderCentralLabel(p.pageTitle, ctx));

  return {
    svg,
    setPointer: (nowMin: number) => {
      if (pointer) setPointerPosition(pointer, nowMin, ctx);
    },
    overflow,
  };
}
