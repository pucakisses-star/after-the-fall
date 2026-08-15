/**
 * Flood-filling unclaimed land (spec §6, §57).
 *
 * The paint bucket: click a piece of land nobody holds and the realm beside it
 * grows to cover the whole of it, out to the coast and up to whatever its
 * neighbours already claim.
 *
 * The awkward part is scale. "Everything unclaimed" is land minus every
 * territory on the map, and the land file is four thousand landmasses at 1:10m —
 * differencing that globally to answer a question about one bay would take
 * seconds. So the region is found in a window around the click and the window is
 * grown only while the answer is still touching its own edge, which is the
 * signal that the region continues past it. A fill inside a small gap between
 * two realms settles on the first window; one that runs up an open coastline
 * grows until it stops, or until it hits the cap and says so.
 */

import { clipToBox, difference, explode, normalizePoly } from './operations';
import { distanceToBoundary } from './reshape';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { Poly } from './operations';

/** Window the search starts at, in degrees. Roughly a small country. */
const START_SPAN = 3;
/**
 * How much bigger each attempt is than the last.
 *
 * Every step clips the landmass again, and on a continent that clip is the whole
 * cost of the operation — so the ladder is short on purpose. 3° to the 90° cap
 * is four steps at this ratio and six at 2.5, which measured as a third off the
 * worst case for no loss on the small fills that settle in one step anyway.
 */
const GROWTH = 4;
/**
 * How far one click may reach, in degrees.
 *
 * Not a performance knob but a decision about what the tool means. Left
 * unbounded, clicking open country west of a realm on the demonstration map
 * hands it 22 million km² — the whole of North America minus its neighbours —
 * which is not what anybody means by "the unclaimed land I clicked", and which
 * took over a minute of blocked main thread to compute. A regional bound makes
 * the common fills immediate, keeps the huge ones honest by reporting that they
 * were cut short, and leaves clicking again as the way to keep going.
 */
const MAX_SPAN = 20;
/** Within this of the window edge counts as touching it, in degrees. */
const EDGE_EPS = 1e-6;
/**
 * How many of a region's edges are measured when deciding who borders it.
 *
 * A fill over open country can produce a boundary of tens of thousands of edges,
 * and the answer wanted from it is a proportion, not a total.
 */
const MAX_EDGE_SAMPLES = 3000;

export interface FillResult {
  geometry: Polygon | MultiPolygon;
  /**
   * True when the region ran to the edge of the largest window allowed, so what
   * came back is a piece of something bigger rather than the whole of it. The
   * caller says so rather than silently filling half a continent.
   */
  truncated: boolean;
}

/**
 * The connected patch of unclaimed land under a point.
 *
 * `land` is the coastline as polygons and `claimed` is every territory that
 * might be in the way. Returns null when the point is at sea or on ground
 * somebody already holds — both of which are ordinary answers, not failures.
 */
export function unclaimedRegionAt(
  point: [number, number],
  land: Poly[],
  claimed: Poly[],
  maxSpan = MAX_SPAN,
): FillResult | null {
  // Which landmass was clicked, decided once against the un-clipped coastline.
  //
  // Restricting the fill to that one island is not an optimisation, it is the
  // correctness fix: clipping land to a window gives every landmass a straight
  // artificial edge along the window, and dissolving the clipped pieces welds
  // any two that reach the same edge into one shape. Iceland came back joined to
  // Greenland — 3.4 million km² of "connected unclaimed land" separated by the
  // Denmark Strait. Unclaimed ground is connected within an island and never
  // across open water, so the island is the right bound.
  const island = land.find((l) => polyContains(l, point));
  if (!island) return null;

  for (let span = START_SPAN; ; span *= GROWTH) {
    const capped = Math.min(span, maxSpan);
    const box = windowAround(point, capped);

    const region = unclaimedInBox(point, box, island, claimed);
    if (!region) return null;

    if (!touchesBox(region, box)) return { geometry: region, truncated: false };
    if (capped >= maxSpan) return { geometry: region, truncated: true };
  }
}

/**
 * A search window of the given span, clamped to the world.
 *
 * Without the clamp a fill in Iceland grows a box reaching latitude 110°, which
 * is not a place, and the clipper's behaviour past the pole is nobody's idea of
 * defined.
 */
function windowAround(point: [number, number], span: number): [number, number, number, number] {
  return [
    Math.max(-180, point[0] - span / 2),
    Math.max(-90, point[1] - span / 2),
    Math.min(180, point[0] + span / 2),
    Math.min(90, point[1] + span / 2),
  ];
}

/** The island inside the box, minus everything claimed, reduced to the part under the point. */
function unclaimedInBox(
  point: [number, number],
  box: [number, number, number, number],
  island: Poly,
  claimed: Poly[],
): Polygon | MultiPolygon | null {
  let open: Poly | null = clipToBox(island, box);
  if (!open) return null;

  // Only the territories that reach into the window can be in the way, and
  // subtracting them one at a time beats unioning the whole map first.
  for (const c of claimed) {
    const near = clipToBox(c, box);
    if (!near) continue;
    open = difference(open, near);
    if (!open) return null;
  }

  // The click landed on exactly one of the leftover parts.
  for (const part of explode(open)) {
    if (containsPoint(part, point)) return normalizePoly(part);
  }
  return null;
}

/** Point-in-polygon for either polygon kind. */
function polyContains(g: Poly, point: [number, number]): boolean {
  if (g.type === 'Polygon') return containsPoint(g, point);
  return g.coordinates.some((coords) => containsPoint({ type: 'Polygon', coordinates: coords }, point));
}

/** Does any vertex sit on the window edge — i.e. was the region cut by it? */
function touchesBox(g: Polygon | MultiPolygon, box: [number, number, number, number]): boolean {
  for (const ring of ringsOf(g)) {
    for (const [x, y] of ring) {
      if (
        Math.abs(x - box[0]) < EDGE_EPS ||
        Math.abs(x - box[2]) < EDGE_EPS ||
        Math.abs(y - box[1]) < EDGE_EPS ||
        Math.abs(y - box[3]) < EDGE_EPS
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Which territory holds most of a region's edge (spec §57).
 *
 * The same question the generator answers when it hands a landlocked pocket to
 * a realm, asked interactively: whoever already surrounds this ground is who it
 * should go to.
 *
 * Measured as *length* of shared frontier, by walking the region's edges and
 * crediting each to whichever territory its midpoint lies against. The obvious
 * cheaper version — counting boundary vertices near each candidate — is wrong in
 * a way that took a test to see: a corridor between two realms is a rectangle,
 * its corners are shared two-and-two, and the count ties so the winner is
 * whichever candidate the loop happened to reach first. Length has no such
 * problem, and is also indifferent to how finely each stretch happens to be
 * traced.
 *
 * Returns null when nothing borders the region, which is the honest answer for
 * an island nobody has claimed: there is no neighbour for it to join.
 */
export function neighbourHoldingMostOf<T extends { id: string; geometry: Poly }>(
  region: Polygon | MultiPolygon,
  candidates: T[],
  tolerance: number,
): T | null {
  const shared = new Map<string, number>();

  // Only realms whose bounds actually reach the region can share an edge with
  // it, and testing that first is what keeps this usable. Filling an empty
  // continent produces a region of tens of thousands of edges, and measuring
  // every one of them against every territory on the map is the difference
  // between a click and a minute of frozen tab.
  const near = candidates.filter((c) => boxesTouch(bboxOf(region), bboxOf(c.geometry), tolerance));
  if (!near.length) return null;

  // Sample rather than walk, on a region too big to walk. Which realm holds most
  // of a frontier is a proportion, and a few thousand edges spread evenly over
  // the boundary settle it as well as all of them.
  const rings = ringsOf(region);
  const total = rings.reduce((n, r) => n + Math.max(0, r.length - 1), 0);
  const stride = Math.max(1, Math.ceil(total / MAX_EDGE_SAMPLES));

  let seen = 0;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      if (seen++ % stride !== 0) continue;
      const a = ring[i - 1];
      const b = ring[i];
      const mid: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

      let best: T | null = null;
      let bestDist = tolerance;
      for (const c of near) {
        const d = distanceToBoundary(c.geometry as Polygon | MultiPolygon, mid);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (!best) continue;

      // Degrees of longitude shrink toward the poles, so an east-west stretch
      // in the Arctic is not the same ground as one at the equator.
      const lonScale = Math.max(0.2, Math.cos((mid[1] * Math.PI) / 180));
      const len = Math.hypot((b[0] - a[0]) * lonScale, b[1] - a[1]);
      shared.set(best.id, (shared.get(best.id) ?? 0) + len);
    }
  }

  let winner: T | null = null;
  let most = 0;
  for (const c of near) {
    const len = shared.get(c.id) ?? 0;
    // Ties go to the lower id rather than to whoever was passed in first, so the
    // answer does not depend on the order of the document's territory record.
    if (len > most || (len === most && len > 0 && winner && c.id < winner.id)) {
      most = len;
      winner = c;
    }
  }
  return winner;
}

/** Bounds of any polygon, as [w, s, e, n]. */
function bboxOf(g: Poly): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of ringsOf(g as Polygon | MultiPolygon)) {
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

/** Do two boxes come within `pad` of each other? */
function boxesTouch(
  a: [number, number, number, number],
  b: [number, number, number, number],
  pad: number,
): boolean {
  return a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3];
}

function ringsOf(g: Polygon | MultiPolygon): Position[][] {
  return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
}

/** Ray-casting point-in-polygon, holes included. */
function containsPoint(g: Polygon, point: [number, number]): boolean {
  const [x, y] = point;
  if (!inRing(g.coordinates[0], x, y)) return false;
  for (let i = 1; i < g.coordinates.length; i++) {
    if (inRing(g.coordinates[i], x, y)) return false;
  }
  return true;
}

function inRing(ring: Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
