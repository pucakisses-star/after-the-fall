/**
 * Political palette generation (spec §22).
 *
 * The requirement is "neighbouring states should not have nearly identical
 * colours", which is graph colouring: build the adjacency graph of the territories,
 * then walk it assigning, to each territory in turn, the palette entry that is
 * most different from the colours already given to its neighbours.
 *
 * Territories are visited most-constrained-first (highest degree), which is the
 * standard Welsh–Powell ordering and gives noticeably better separation than
 * arbitrary order on real maps, where a handful of states border everything.
 */

import * as turf from '@turf/turf';
import { PALETTES, type PaletteMode } from '@/model/defaults';
import { colorDistance, hslToRgb, rgbToHsl, parseColor, toHex } from '@/model/color';
import type { Territory, UUID } from '@/model/types';

export interface AdjacencyGraph {
  neighbors: Map<UUID, Set<UUID>>;
}

/**
 * Two territories are neighbours when their bounding boxes overlap *and* the
 * geometries actually touch or intersect. The bbox pre-pass is what keeps this
 * usable at a couple of thousand polygons.
 */
export function buildAdjacency(territories: Territory[]): AdjacencyGraph {
  const neighbors = new Map<UUID, Set<UUID>>();
  for (const t of territories) neighbors.set(t.id, new Set());

  const boxes = territories.map((t) => {
    try {
      return turf.bbox({ type: 'Feature', properties: {}, geometry: t.geometry });
    } catch {
      return null;
    }
  });

  // Grow each bbox slightly so polygons that merely come very close still count
  // as neighbours — visually they read as adjacent even if they do not touch.
  const pad = 0.02;

  for (let i = 0; i < territories.length; i++) {
    const bi = boxes[i];
    if (!bi) continue;
    for (let j = i + 1; j < territories.length; j++) {
      const bj = boxes[j];
      if (!bj) continue;
      if (bi[2] + pad < bj[0] || bj[2] + pad < bi[0] || bi[3] + pad < bj[1] || bj[3] + pad < bi[1]) continue;
      let touches = false;
      try {
        touches = turf.booleanIntersects(
          { type: 'Feature', properties: {}, geometry: territories[i].geometry },
          { type: 'Feature', properties: {}, geometry: territories[j].geometry },
        );
      } catch {
        touches = false;
      }
      if (touches) {
        neighbors.get(territories[i].id)!.add(territories[j].id);
        neighbors.get(territories[j].id)!.add(territories[i].id);
      }
    }
  }

  return { neighbors };
}

export interface RecolorOptions {
  mode: PaletteMode;
  /** Territories that keep their current colour. */
  lockedIds?: Set<UUID>;
  /** Base hue for monochromatic mode, 0..360. */
  baseHue?: number;
  /** Deterministic seed so "recolor" is repeatable within a session. */
  seed?: number;
}

/** Build the candidate colour list for a mode. */
export function paletteFor(mode: PaletteMode, count: number, opts: RecolorOptions = { mode }): string[] {
  if (mode === 'monochromatic') {
    const hue = opts.baseHue ?? 32;
    const out: string[] = [];
    const n = Math.max(count, 6);
    for (let i = 0; i < n; i++) {
      const l = 0.42 + (0.42 * i) / Math.max(1, n - 1);
      const s = 0.34 - 0.14 * (i / Math.max(1, n - 1));
      out.push(toHex(hslToRgb({ h: hue, s, l })));
    }
    return out;
  }
  if (mode === 'random') {
    const rng = mulberry32(opts.seed ?? 1);
    const out: string[] = [];
    const n = Math.max(count, 8);
    for (let i = 0; i < n; i++) {
      // Golden-angle hue stepping keeps random palettes from clumping.
      const h = (rng() * 360 + i * 137.508) % 360;
      out.push(toHex(hslToRgb({ h, s: 0.3 + rng() * 0.35, l: 0.55 + rng() * 0.2 })));
    }
    return out;
  }
  return PALETTES[mode];
}

/**
 * Assign colours. Returns territory id → hex colour for every territory that
 * should change; locked territories are omitted (spec §22: "do not recolor
 * locked territories") but still constrain their neighbours.
 */
export function recolor(
  territories: Territory[],
  currentColorOf: (t: Territory) => string,
  opts: RecolorOptions,
): Map<UUID, string> {
  const locked = opts.lockedIds ?? new Set<UUID>();
  const graph = buildAdjacency(territories);
  const palette = paletteFor(opts.mode, territories.length, opts);
  const assigned = new Map<UUID, string>();
  const result = new Map<UUID, string>();

  // Locked territories are fixed points in the graph.
  for (const t of territories) {
    if (locked.has(t.id) || t.locked) assigned.set(t.id, currentColorOf(t));
  }

  const order = [...territories]
    .filter((t) => !locked.has(t.id) && !t.locked)
    .sort((a, b) => (graph.neighbors.get(b.id)?.size ?? 0) - (graph.neighbors.get(a.id)?.size ?? 0));

  let cursor = 0;
  for (const t of order) {
    const neighborColors = [...(graph.neighbors.get(t.id) ?? [])]
      .map((n) => assigned.get(n))
      .filter((c): c is string => !!c);

    let best: { color: string; score: number } | null = null;
    for (let k = 0; k < palette.length; k++) {
      // Rotate the starting point so a run of unconstrained territories still
      // cycles through the palette instead of all taking entry 0.
      const color = palette[(cursor + k) % palette.length];
      const score = neighborColors.length
        ? Math.min(...neighborColors.map((c) => colorDistance(color, c)))
        : 1000 - k; // prefer earlier palette entries when unconstrained
      if (!best || score > best.score) best = { color, score };
      if (score > 160) break; // comfortably distinct — take it and move on
    }

    const chosen = best?.color ?? palette[cursor % palette.length];
    // If even the best candidate is close to a neighbour, nudge its lightness so
    // the two still read apart.
    const finalColor =
      best && best.score < 60 && neighborColors.length ? nudge(chosen, neighborColors) : chosen;

    assigned.set(t.id, finalColor);
    result.set(t.id, finalColor);
    cursor++;
  }

  return result;
}

function nudge(color: string, neighbors: string[]): string {
  const hsl = rgbToHsl(parseColor(color));
  for (const delta of [0.12, -0.12, 0.22, -0.22]) {
    const candidate = toHex(hslToRgb({ ...hsl, l: Math.max(0.2, Math.min(0.88, hsl.l + delta)) }));
    const worst = Math.min(...neighbors.map((n) => colorDistance(candidate, n)));
    if (worst > 60) return candidate;
  }
  return color;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
