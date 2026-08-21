/**
 * Stray threads left behind by boolean edits (spec §6).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE PASS FROM `repairTopology`
 * ---------------------------------------------------------------------------
 * `repairTopology` is about the relationship *between* territories: two realms
 * that overlap, or a gap where they fail to meet. This module is about the mess
 * inside one realm's own geometry, and it needs a different measure entirely.
 *
 * Every boolean operation — carving a duchy out of a kingdom, trimming to a
 * coastline, splitting along a river — leaves scraps where two boundaries came
 * within a rounding error of each other without touching. On the map those
 * scraps are the thing the user actually sees: a dark dash lying across a
 * country, or floating inside one. A shape narrow enough has no visible
 * interior, so all that renders is its outline, and an outline with no width is
 * a line. Hence "stray lines".
 *
 * The measure has to be WIDTH, not area. This is the lesson that keeps having
 * to be relearned here, so it is written down: a 2 km² scrap can be a real
 * island somebody lives on, or a ribbon 300 m wide and seven kilometres long
 * that is pure rounding error, and no area threshold separates them. Every
 * audit of this map that filtered on area declared it clean while the dashes
 * were still on screen. `ringWidthKm` — area over half the perimeter — is exact
 * for a ribbon however it meanders, and reports a disc's radius, so real ground
 * scores far above anything a thread reaches.
 *
 * Three shapes are caught, because all three render as the same dark dash:
 *
 *   THREAD  a whole part narrower than the limit. Renders as a dash lying on
 *           the map, usually along the border it failed to meet.
 *   SLIT    a *hole* narrower than the limit. Renders as a dash floating inside
 *           the fill, with the country's colour on both sides of it — the most
 *           confusing of the three, because nothing looks wrong with the shape.
 *   SPIKE   a needle of vertices doubling back on itself. Encloses no area at
 *           all, so no area or ring-width test can see it; only the angle at
 *           the tip gives it away.
 *
 * ---------------------------------------------------------------------------
 * WHY A THREAD ALSO HAS TO BE TOUCHING SOMETHING
 * ---------------------------------------------------------------------------
 * Width alone would delete the Florida Keys. A barrier island four hundred
 * metres wide and ten kilometres long is a hairline by every measure here, and
 * it is also real ground that somebody meant to draw. Measured on this map, a
 * width-only sweep took six islands off the Kingdom of the Keys along with the
 * scraps — eight per cent of that realm.
 *
 * What separates them is not shape but company. A scrap is *born* from a
 * boolean between two realms, so it lies against the boundary that produced
 * it — it touches its neighbour. An island sits by itself in open water and
 * touches nothing. Measured across this map that test splits 120 candidate
 * threads into 76 scraps and 44 islands, it puts every Kingdom of the Keys
 * island on the keep side, and the answer does not move at all as the touch
 * tolerance goes from zero to two hundred metres — so it is reading a real
 * structural difference rather than a tuned number.
 *
 * Slits and spikes need no such test. Nobody draws a four-hundred-metre slot
 * through a realm, and nobody draws a border that doubles back on itself.
 *
 * Nothing here moves a vertex that is part of a real boundary. Threads and
 * slits are dropped whole, and despiking only ever deletes a vertex whose two
 * legs are within a few degrees of doubling back — so a shared border survives
 * the pass bit-identical on both sides of itself.
 */

import type { Polygon, Position } from 'geojson';
import { areaKm2, bbox, explode, normalizePoly, polygonsIntersect, ringWidthKm } from './operations';
import type { Poly } from './operations';
import type { Territory, UUID } from '@/model/types';

/**
 * How thin is too thin, in kilometres.
 *
 * 0.75 km is about a pixel and a half at the zoom a whole country is drawn at,
 * which is the scale at which these become visible as marks. Below it nothing
 * legible is being thrown away; above it a real if narrow strip of ground could
 * be, so the threshold is exposed rather than baked in.
 */
export const DEFAULT_HAIRLINE_KM = 0.75;

/** Corners sharper than this are candidate needle tips. */
const SPIKE_ANGLE_DEG = 5;

/** Kilometres in a degree of latitude. */
const KM_PER_DEGREE = 111.32;

export type HairlineKind = 'thread' | 'slit' | 'spike';

export interface Hairline {
  territoryId: UUID;
  name: string;
  kind: HairlineKind;
  /** How wide the offending shape is, in km. Zero for a spike, which has no width. */
  widthKm: number;
  areaKm2: number;
  /** Where it is, for the "Show" button. A spike reports a tiny box round its tip. */
  geometry: Polygon;
}

export interface CleanOptions {
  maxWidthKm?: number;
  /** Territories that must not be modified. */
  lockedIds?: Set<UUID>;
  removeThreads?: boolean;
  removeSlits?: boolean;
  removeSpikes?: boolean;
  /**
   * Spare narrow parts that touch nothing — they are islands, not scraps.
   * On by default; turn it off only to sweep an archipelago deliberately.
   */
  keepIslands?: boolean;
}

export interface CleanResult {
  /** Territory id → cleaned geometry. Only changed territories appear. */
  changes: Map<UUID, Poly>;
  found: Hairline[];
  log: string[];
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Local kilometres per degree of longitude, which shortens away from the equator. */
const lonScale = (lat: number) => Math.cos((lat * Math.PI) / 180);

function legKm(from: Position, to: Position): [number, number] {
  const lat = (from[1] + to[1]) / 2;
  return [(to[0] - from[0]) * lonScale(lat) * KM_PER_DEGREE, (to[1] - from[1]) * KM_PER_DEGREE];
}

function boxAround(p: Position, km: number): Polygon {
  const dy = km / KM_PER_DEGREE;
  const dx = dy / Math.max(0.05, lonScale(p[1]));
  return {
    type: 'Polygon',
    coordinates: [
      [
        [p[0] - dx, p[1] - dy],
        [p[0] + dx, p[1] - dy],
        [p[0] + dx, p[1] + dy],
        [p[0] - dx, p[1] + dy],
        [p[0] - dx, p[1] - dy],
      ],
    ],
  };
}

interface Neighbour {
  id: UUID;
  box: [number, number, number, number];
  geometry: Poly;
}

function buildNeighbours(territories: Territory[]): Neighbour[] {
  const out: Neighbour[] = [];
  for (const t of territories) {
    if (!t.geometry) continue;
    try {
      out.push({ id: t.id, box: bbox(t.geometry), geometry: t.geometry });
    } catch {
      // Unreadable geometry simply cannot vouch for anything.
    }
  }
  return out;
}

/**
 * Does this narrow part have company?
 *
 * A bounding-box pre-filter first, so the expensive test only runs for the
 * handful of realms that could possibly be in contact. Anything that touches
 * another realm at all was made by a boolean against it; anything alone in the
 * water is an island.
 */
function touchesAnotherRealm(part: Polygon, ownerId: UUID, neighbours: Neighbour[]): boolean {
  let box: [number, number, number, number];
  try {
    box = bbox(part);
  } catch {
    return false;
  }
  for (const n of neighbours) {
    if (n.id === ownerId) continue;
    if (n.box[2] < box[0] || box[2] < n.box[0] || n.box[3] < box[1] || box[3] < n.box[1]) continue;
    try {
      if (polygonsIntersect(part, n.geometry)) return true;
    } catch {
      // A geometry too broken to test cannot be evidence of contact.
    }
  }
  return false;
}

/**
 * Delete needle tips from one ring, repeatedly, until nothing more doubles back.
 *
 * A vertex goes when its two legs are within `SPIKE_ANGLE_DEG` of folding flat
 * against each other AND the excursion they enclose is narrower than the limit.
 * Both conditions are needed: the angle alone would shave a genuine sharp cape,
 * and the width alone would eat every short segment on a detailed coast.
 *
 * Iterating matters because a needle is usually several vertices deep — peeling
 * the tip exposes the next one. Returns null if the ring collapses, which means
 * the whole ring was needle.
 */
function despikeRing(ring: Position[], maxWidthKm: number): { ring: Position[] | null; removed: Position[] } {
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  let pts = closed ? ring.slice(0, -1) : ring.slice();
  const removed: Position[] = [];
  const cosLimit = Math.cos((SPIKE_ANGLE_DEG * Math.PI) / 180);

  // Bounded so a pathological ring cannot spin here. Each sweep peels one layer.
  for (let sweep = 0; sweep < 64 && pts.length >= 3; sweep++) {
    const drop = new Set<number>();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const [ax, ay] = legKm(b, a); // b→a
      const [cx, cy] = legKm(b, c); // b→c
      const la = Math.hypot(ax, ay);
      const lc = Math.hypot(cx, cy);
      if (la === 0 || lc === 0) continue;
      const cos = (ax * cx + ay * cy) / (la * lc);
      if (cos < cosLimit) continue; // corner is not sharp enough to be a needle
      // Width of the excursion: how far the shorter leg stands off the longer.
      const sin = Math.abs(ax * cy - ay * cx) / (la * lc);
      if (Math.min(la, lc) * sin >= maxWidthKm) continue;
      drop.add(i);
    }
    // Never drop two neighbours in one sweep — removing both ends of a segment
    // can jump the boundary across ground rather than peeling a tip off it.
    let dropped = 0;
    const next: Position[] = [];
    let lastDropped = false;
    for (let i = 0; i < pts.length; i++) {
      if (drop.has(i) && !lastDropped && pts.length - dropped > 3) {
        removed.push(pts[i]);
        dropped++;
        lastDropped = true;
        continue;
      }
      lastDropped = false;
      next.push(pts[i]);
    }
    if (dropped === 0) break;
    pts = next;
  }

  if (pts.length < 3) return { ring: null, removed };
  return { ring: [...pts, [pts[0][0], pts[0][1]]], removed };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Find and remove every thread, slit and spike in a set of territories.
 *
 * Reporting and repair are the same walk, so what the preview lists is exactly
 * what pressing the button removes — the two cannot disagree.
 */
export function cleanHairlines(territories: Territory[], opts: CleanOptions = {}): CleanResult {
  const maxWidthKm = opts.maxWidthKm ?? DEFAULT_HAIRLINE_KM;
  // The territory's own flag counts as well as the caller's set, so a caller
  // that forgets to pass one cannot quietly redraw a realm the user locked.
  const lockedIds = opts.lockedIds ?? new Set<UUID>();
  const lockedById = new Map(territories.map((t) => [t.id, t.locked === true]));
  const locked = { has: (id: UUID) => lockedIds.has(id) || lockedById.get(id) === true };
  const doThreads = opts.removeThreads ?? true;
  const doSlits = opts.removeSlits ?? true;
  const doSpikes = opts.removeSpikes ?? true;
  const keepIslands = opts.keepIslands ?? true;
  const neighbours = keepIslands ? buildNeighbours(territories) : [];

  const result: CleanResult = { changes: new Map(), found: [], log: [] };
  let islandsSpared = 0;

  for (const t of territories) {
    if (!t.geometry) continue;
    let parts: Polygon[];
    try {
      parts = explode(t.geometry);
    } catch {
      continue;
    }

    const kept: Position[][][] = [];
    let touched = false;

    for (const part of parts) {
      const [outer, ...holes] = part.coordinates;

      const outerWidth = ringWidthKm(outer);
      if (doThreads && outerWidth <= maxWidthKm) {
        const shell: Polygon = { type: 'Polygon', coordinates: [outer] };
        // An island touches nothing, and is ground somebody drew on purpose.
        const isScrap = !keepIslands || touchesAnotherRealm(shell, t.id, neighbours);
        if (isScrap) {
          result.found.push({
            territoryId: t.id,
            name: t.name,
            kind: 'thread',
            widthKm: outerWidth,
            areaKm2: areaKm2(shell),
            geometry: shell,
          });
          if (!locked.has(t.id)) {
            touched = true;
            continue; // drop the whole part
          }
        } else {
          islandsSpared++;
        }
      }

      const keptHoles: Position[][] = [];
      for (const hole of holes) {
        const w = ringWidthKm(hole);
        if (doSlits && w <= maxWidthKm) {
          result.found.push({
            territoryId: t.id,
            name: t.name,
            kind: 'slit',
            widthKm: w,
            areaKm2: areaKm2({ type: 'Polygon', coordinates: [hole] }),
            geometry: { type: 'Polygon', coordinates: [hole] },
          });
          if (!locked.has(t.id)) {
            touched = true;
            continue; // fill the slit by forgetting the hole
          }
        }
        keptHoles.push(hole);
      }

      let rings = [outer, ...keptHoles];

      if (doSpikes) {
        const despiked: Position[][] = [];
        let outerGone = false;
        for (let i = 0; i < rings.length; i++) {
          const { ring, removed } = despikeRing(rings[i], maxWidthKm);
          for (const tip of removed) {
            result.found.push({
              territoryId: t.id,
              name: t.name,
              kind: 'spike',
              widthKm: 0,
              areaKm2: 0,
              geometry: boxAround(tip, Math.max(maxWidthKm, 0.2)),
            });
          }
          if (removed.length > 0 && !locked.has(t.id)) touched = true;
          if (locked.has(t.id)) {
            despiked.push(rings[i]);
            continue;
          }
          if (!ring) {
            // The ring was needle all the way down. Losing the outer ring means
            // losing the part; losing a hole just fills it.
            if (i === 0) outerGone = true;
            continue;
          }
          despiked.push(ring);
        }
        if (outerGone) continue;
        rings = despiked;
      }

      if (rings.length !== part.coordinates.length) touched = true;
      kept.push(rings);
    }

    if (!touched || locked.has(t.id)) continue;

    const next = normalizePoly(
      kept.length === 0
        ? null
        : kept.length === 1
          ? { type: 'Polygon', coordinates: kept[0] }
          : { type: 'MultiPolygon', coordinates: kept },
    );
    // Never let a cleanup delete a realm outright. If everything about a
    // territory reads as thread, that is a judgement call for a person, not a
    // side effect of pressing a tidy-up button.
    if (!next) {
      result.log.push(`Left "${t.name}" alone — every part of it reads as a thread.`);
      continue;
    }
    result.changes.set(t.id, next);
  }

  const counts = {
    thread: result.found.filter((h) => h.kind === 'thread').length,
    slit: result.found.filter((h) => h.kind === 'slit').length,
    spike: result.found.filter((h) => h.kind === 'spike').length,
  };
  if (counts.thread) result.log.push(`Removed ${counts.thread} stray thread${counts.thread === 1 ? '' : 's'}.`);
  if (counts.slit) result.log.push(`Closed ${counts.slit} hairline slit${counts.slit === 1 ? '' : 's'}.`);
  if (counts.spike) result.log.push(`Filed off ${counts.spike} needle spike${counts.spike === 1 ? '' : 's'}.`);
  // Worth saying out loud: a sweep that silently skipped 44 shapes reads as a
  // sweep that missed them.
  if (islandsSpared > 0) {
    result.log.push(
      `Left ${islandsSpared} narrow island${islandsSpared === 1 ? '' : 's'} alone — ` +
        `each one touches no other realm, so it is ground you drew rather than a scrap.`,
    );
  }
  if (result.found.length === 0 && islandsSpared === 0) result.log.push('No stray lines found.');

  return result;
}

/** Report without changing anything, for a preview. */
export function findHairlines(territories: Territory[], maxWidthKm = DEFAULT_HAIRLINE_KM): Hairline[] {
  return cleanHairlines(territories, { maxWidthKm }).found;
}
