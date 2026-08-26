import { Center, NautilusSettings, Rect } from "./types";

/* ------------------------------------------------------------------ *
 * Constants — ported from the original component.cljs
 * ------------------------------------------------------------------ */

export const PI = Math.PI;
export const WORKDAY_END = 1320; // 22:00
export const TRIES_THRESHOLD = 25;
export const RESERVE = 15;
export const INIT_STARTING_DISTANCE = 30;

/**
 * Outer radius of the spiral per hour of day (index = hour, 0..24).
 * Hours 0-3 are night (collapsed at center); the day starts at 4:00,
 * peaks at 8:00 and spirals inward.
 */
export const SNAIL_OUTER_RADII: number[] = (() => {
  const arr = [0, 0, 0, 0, 130, 135, 140, 145, 150];
  for (let r = 145; r >= 70; r -= 5) arr.push(r);
  return arr;
})();

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Scaled outer radius at hour t (used for drawing). */
export function outerRadiusAt(t: number, scaler: number): number {
  return SNAIL_OUTER_RADII[mod(Math.floor(t), SNAIL_OUTER_RADII.length)] * scaler;
}

/** Raw outer radius at hour t (used for legend placement, as in the original). */
export function rawRadius(t: number): number {
  return SNAIL_OUTER_RADII[mod(Math.floor(t), SNAIL_OUTER_RADII.length)];
}

/* ------------------------------------------------------------------ *
 * Angle math
 * ------------------------------------------------------------------ */

export function angleToRad(angle: number): number {
  return (180 - angle) * (PI / 180);
}

export function minToAngle(minutes: number): number {
  return mod((minutes - 540) / 2, 360);
}

export function posSweepAngle(startRad: number, endRad: number): number {
  return (
    2 * PI - (endRad > startRad ? endRad - startRad : endRad - startRad + 2 * PI)
  );
}

export function posSweepAngleMid(startRad: number, endRad: number): number {
  return endRad + posSweepAngle(startRad, endRad) / 2;
}

/* ------------------------------------------------------------------ *
 * Legend collision
 * ------------------------------------------------------------------ */

function between(x: number, a: number, b: number): boolean {
  return x >= a && x <= b;
}

function collide(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

export function collides(rect: Rect, rects: Rect[]): boolean {
  return rects.some((r) => collide(rect, r));
}

export function atVertex(radians: number): boolean {
  return between(radians, 1.01, 2.05) || between(radians, -2.05, -1.01);
}

/**
 * Find a position for a legend rect that does not overlap existing rects.
 * Faithful port of iterate-rect-place (including its quirky radius/angle
 * fallback protocol and the 25-try threshold).
 */
export function iterateRectPlace(
  rect: Rect,
  rects: Rect[],
  startRadians: number,
  startRadius: number,
  center: Center
): Rect {
  const maxLegendRadius = startRadius * 1.7;
  const maxRadiansSpan = PI / 17;
  let radians = startRadians;
  let radius = startRadius;
  let angleOffset = 0;
  let radiusOffset = 0;
  let counter = 0;
  let radiusInc = 3;
  let trying: "radius" | "angle" = atVertex(radians) ? "radius" : "angle";

  for (;;) {
    const minRadians = radians - maxRadiansSpan / 2;
    const maxRadians = radians + maxRadiansSpan / 2;
    const x = center.cx + Math.cos(radians) * radius;
    const y = center.cy + Math.sin(radians) * radius;
    const onLeft = radians > PI / 2 || radians < -PI / 2;
    const atV = atVertex(radians);
    const hShift = atV ? rect.w / 2 : onLeft ? rect.w : 0;
    const vShift = rect.h / 2;
    const placed: Rect = { ...rect, x: x - hShift, y: y - vShift, radians };
    if (counter > TRIES_THRESHOLD || !collides(placed, rects)) return placed;

    if (trying === "radius") {
      if (radius < maxLegendRadius) {
        radius = startRadius + radiusOffset;
        radiusOffset += radiusInc;
        counter++;
      } else {
        radius = startRadius;
        counter = 0;
        radiusInc = 0;
        trying = "angle";
      }
    } else {
      if (radians > minRadians && radians < maxRadians) {
        radians = startRadians + angleOffset;
        angleOffset =
          angleOffset === 0 || angleOffset > 0
            ? -(angleOffset + 0.03)
            : 0.03 - angleOffset;
        counter++;
        radiusInc = 0;
      } else {
        radians = startRadians;
        radius = startRadius;
        counter = 0;
        trying = "radius";
      }
    }
  }
}

export function realRectRadians(rect: Rect, center: Center): number {
  const rcx = rect.x + rect.w / 2;
  const rcy = rect.y + rect.h / 2;
  return Math.atan2(rcy - center.cy, rcx - center.cx);
}

/** CJK characters count double. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 255 ? 2 : 1;
  return w;
}

export function getLegendRect(
  rects: Rect[],
  text: string,
  sliceRadians: number,
  outerRadius: number,
  center: Center,
  settings: NautilusSettings,
  fontSize: number,
  isMobile: boolean
): Rect {
  const w =
    (fontSize / 1.55) * Math.min(displayWidth(text), settings.legendLenLimit);
  const h = fontSize * 1.15;
  const placed = iterateRectPlace(
    { w, h, x: 0, y: 0, radians: 0, realRadians: 0, text },
    rects,
    -sliceRadians,
    outerRadius + (isMobile ? 0 : INIT_STARTING_DISTANCE),
    center
  );
  placed.realRadians = realRectRadians(placed, center);
  return placed;
}

/* ------------------------------------------------------------------ *
 * SVG arc paths
 * ------------------------------------------------------------------ */

export function calculateCoordinates(
  angle: number,
  radius: number,
  center: Center
): [number, number] {
  const rad = angleToRad(angle);
  return [center.cx + Math.cos(rad) * radius, center.cy - Math.sin(rad) * radius];
}

export function createArcPath(
  startAngle: number,
  endAngle: number,
  innerRadius: number,
  outerRadius: number,
  center: Center
): string {
  const startRad = angleToRad(startAngle);
  const endRad = angleToRad(endAngle);
  const [sxo, syo] = calculateCoordinates(startAngle, outerRadius, center);
  const [exo, eyo] = calculateCoordinates(endAngle, outerRadius, center);
  const [sxi, syi] = calculateCoordinates(startAngle, innerRadius, center);
  const [exi, eyi] = calculateCoordinates(endAngle, innerRadius, center);
  const largeArc = posSweepAngle(startRad, endRad) >= PI ? 1 : 0;
  return (
    `M${sxo},${syo}` +
    ` A${outerRadius},${outerRadius} 0 ${largeArc} 1 ${exo},${eyo}` +
    ` L${exi},${eyi}` +
    ` A${innerRadius},${innerRadius} 0 ${largeArc} 0 ${sxi},${syi}` +
    `Z`
  );
}

/** Hour boundaries (minutes) strictly inside (startMin, endMin). */
export function getHourBoundaries(startMin: number, endMin: number): number[] {
  let first = Math.floor((startMin + 59) / 60) * 60;
  if (first <= startMin) first += 60;
  const out: number[] = [];
  for (let b = first; b < endMin; b += 60) out.push(b);
  return out;
}
