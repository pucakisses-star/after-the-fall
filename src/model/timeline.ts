/**
 * Timeline filtering (spec §30).
 *
 * Every feature carries an optional `TimelineRange`. When the timeline is on,
 * only features whose range contains the current year are drawn — which applies
 * uniformly to states, subdivisions, cities, borders (derived from the visible
 * territories), roads and labels, exactly as §30 asks.
 */

import type { TimelineRange, TimelineSettings } from './types';

/** Half-open: `start <= year < end`. Nulls are unbounded. */
export function existsAtYear(range: TimelineRange, year: number): boolean {
  if (range.start !== null && year < range.start) return false;
  if (range.end !== null && year >= range.end) return false;
  return true;
}

/** True when a feature should be drawn, taking the timeline switch into account. */
export function visibleInTime(range: TimelineRange, timeline: TimelineSettings): boolean {
  if (!timeline.enabled) return true;
  return existsAtYear(range, timeline.currentYear);
}

/** The span covered by a set of ranges, for seeding the slider's bounds. */
export function boundsOf(ranges: TimelineRange[], fallback: [number, number]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const r of ranges) {
    if (r.start !== null) {
      min = Math.min(min, r.start);
      max = Math.max(max, r.start);
    }
    if (r.end !== null) {
      min = Math.min(min, r.end);
      max = Math.max(max, r.end);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return fallback;
  const pad = Math.max(10, Math.round((max - min) * 0.1));
  return [min - pad, max + pad];
}
