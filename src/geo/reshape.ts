/**
 * Redrawing part of a boundary by hand (spec §5, §6, §21).
 *
 * Vertex editing moves the points a border already has, one at a time. That is
 * the wrong instrument for "this stretch of the frontier is wrong, let me draw
 * it again": you want to put a stroke down over the border, the way you would
 * with a pencil, and have the border become the stroke.
 *
 * So: a stroke that begins near a boundary and ends near the same boundary
 * replaces the run of border between those two points. Everything else about
 * the shape is untouched — the rest of the ring, the other rings, the holes.
 *
 * Which of the two runs between the endpoints gets replaced is the only real
 * question, since two points on a closed ring always divide it into two. The
 * answer is the one the stroke was drawn *along*: the run whose vertices sit
 * closest to the stroke. Length would be the obvious rule and is the wrong one,
 * because redrawing the long way round a small enclave is a perfectly ordinary
 * thing to want and the short-arc rule would silently turn the shape inside
 * out.
 */

import type { LineString, MultiPolygon, Polygon, Position } from 'geojson';

/** Where a point falls on a ring: which ring, which segment, and how far along. */
interface RingPosition {
  polygon: number;
  ring: number;
  segment: number;
  t: number;
  point: Position;
  distance: number;
}

const lonScale = (lat: number) => Math.max(0.2, Math.cos((lat * Math.PI) / 180));

/** Distance between two points, with longitude scaled by the latitude it is at. */
function gap(a: Position, b: Position): number {
  const sx = lonScale((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * sx, a[1] - b[1]);
}

/** Closest point to `p` on a segment, as a fraction along it. */
function project(p: Position, a: Position, b: Position): { t: number; point: Position; distance: number } {
  const sx = lonScale(p[1]);
  const dx = (b[0] - a[0]) * sx;
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : (((p[0] - a[0]) * sx * dx + (p[1] - a[1]) * dy) / len2);
  t = Math.max(0, Math.min(1, t));
  const point: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, point, distance: gap(p, point) };
}

const polygonsOf = (g: Polygon | MultiPolygon) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

/** The nearest place on one particular ring to a given point. */
function nearestOnRing(ring: Position[], pi: number, ri: number, p: Position): RingPosition | null {
  let best: RingPosition | null = null;
  for (let si = 0; si < ring.length - 1; si++) {
    const hit = project(p, ring[si], ring[si + 1]);
    if (!best || hit.distance < best.distance) {
      best = { polygon: pi, ring: ri, segment: si, t: hit.t, point: hit.point, distance: hit.distance };
    }
  }
  return best;
}

/** The nearest place on any ring of the shape to a given point. */
function nearestOnBoundary(shape: Polygon | MultiPolygon, p: Position): RingPosition | null {
  let best: RingPosition | null = null;
  const polys = polygonsOf(shape);
  for (let pi = 0; pi < polys.length; pi++) {
    for (let ri = 0; ri < polys[pi].length; ri++) {
      const hit = nearestOnRing(polys[pi][ri], pi, ri, p);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
  }
  return best;
}

/**
 * The ring that suits *both* ends of a stroke, not the one nearest each.
 *
 * Asking each end for its own nearest ring and then insisting the two agree is
 * the same question asked twice, and on a realm of several parts the answers
 * differ for a reason that has nothing to do with the user: an end that lies on
 * the main outline can still sit a shade nearer some island of the same realm,
 * or nearer the rim of a hole, and the reshape is refused although a ring
 * carrying both ends was there all along. So every ring is offered both ends,
 * only those that can hold both within tolerance are kept, and of those the one
 * that fits the worse-placed end best wins.
 */
function ringForBoth(
  shape: Polygon | MultiPolygon,
  head: Position,
  tail: Position,
  tolerance: number,
): { from: RingPosition; to: RingPosition } | null {
  let best: { from: RingPosition; to: RingPosition; worst: number; total: number } | null = null;
  const polys = polygonsOf(shape);
  for (let pi = 0; pi < polys.length; pi++) {
    for (let ri = 0; ri < polys[pi].length; ri++) {
      const ring = polys[pi][ri];
      const from = nearestOnRing(ring, pi, ri, head);
      const to = nearestOnRing(ring, pi, ri, tail);
      if (!from || !to) continue;
      if (from.distance > tolerance || to.distance > tolerance) continue;
      const worst = Math.max(from.distance, to.distance);
      const total = from.distance + to.distance;
      if (!best || worst < best.worst || (worst === best.worst && total < best.total)) {
        best = { from, to, worst, total };
      }
    }
  }
  return best ? { from: best.from, to: best.to } : null;
}

/** The run of ring from one position to another, walking forwards, ends included. */
function runBetween(ring: Position[], from: RingPosition, to: RingPosition): Position[] {
  const out: Position[] = [from.point];
  const n = ring.length - 1; // the closing vertex repeats the first
  let i = (from.segment + 1) % n;
  const stop = (to.segment + 1) % n;
  // Walking forwards from just after `from` to just before `to`.
  for (let guard = 0; guard <= n; guard++) {
    if (i === stop) break;
    out.push(ring[i]);
    i = (i + 1) % n;
  }
  if (from.segment === to.segment && to.t >= from.t) {
    // Both ends on one segment, the short way: nothing in between.
    return [from.point, to.point];
  }
  out.push(ring[to.segment]);
  out.push(to.point);
  return dedupe(out);
}

function dedupe(points: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

/** Mean distance from a run of points to the nearest point of a stroke. */
function meanDistanceTo(run: Position[], stroke: Position[]): number {
  if (!run.length) return Infinity;
  let total = 0;
  for (const p of run) {
    let best = Infinity;
    for (let i = 0; i < stroke.length - 1; i++) {
      const d = project(p, stroke[i], stroke[i + 1]).distance;
      if (d < best) best = d;
    }
    total += best;
  }
  return total / run.length;
}

export interface ReshapeResult {
  geometry: Polygon | MultiPolygon;
  /** The run of boundary that was replaced, for handing the same edit to a neighbour. */
  replaced: Position[];
  /** The stroke as it was fitted onto the boundary, ends snapped to it. */
  drawn: Position[];
}

/**
 * Replace the stretch of boundary a stroke was drawn along with the stroke.
 *
 * Returns null when the stroke does not start and end near the same ring — the
 * caller should say so rather than guess, because every other interpretation of
 * a stroke that runs off the edge of a shape is a different tool.
 *
 * @param tolerance How near an end must come to the boundary to count, in
 *   degrees of latitude. A stroke that starts in open country is not a reshape.
 */
export function reshapeBoundary(
  shape: Polygon | MultiPolygon,
  stroke: LineString,
  tolerance: number,
): ReshapeResult | null {
  const points = dedupe(stroke.coordinates);
  if (points.length < 2) return null;

  const ends = ringForBoth(shape, points[0], points[points.length - 1], tolerance);
  if (!ends) return null;
  const { from, to } = ends;
  if (from.segment === to.segment && Math.abs(from.t - to.t) < 1e-9) return null;

  const polys = polygonsOf(shape).map((p) => p.map((r) => r.slice()));
  const ring = polys[from.polygon][from.ring];

  // The two runs the endpoints divide the ring into.
  const forward = runBetween(ring, from, to);
  const backward = runBetween(ring, to, from);

  // The stroke, with its ends pulled onto the boundary so the seam is exact.
  const drawn = dedupe([from.point, ...points.slice(1, -1), to.point]);
  if (drawn.length < 2) return null;

  // Replace the run the stroke was drawn along, which is the one it lies on top
  // of — not the shorter one. See the note at the top of the file.
  const replaceForward = meanDistanceTo(forward, drawn) <= meanDistanceTo(backward, drawn);
  const kept = replaceForward ? backward : forward;
  const replaced = replaceForward ? forward : backward;

  // The new ring is the run we kept, closed by the stroke. `kept` ends where
  // the stroke has to pick up, so the stroke joins it head to tail — which way
  // round that is depends on which run was kept. Getting it the wrong way round
  // does not fail loudly: it quietly builds the complement of the shape you
  // asked for, so a bite out of a border comes back as a bulge.
  const strokeBack = replaceForward ? drawn : [...drawn].reverse();
  const rebuilt = dedupe([...kept, ...strokeBack.slice(1)]);
  if (rebuilt.length < 3) return null;
  rebuilt.push([rebuilt[0][0], rebuilt[0][1]]);

  polys[from.polygon][from.ring] = rebuilt;
  const geometry: Polygon | MultiPolygon =
    shape.type === 'Polygon' ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };

  return { geometry, replaced, drawn };
}

/**
 * How far a point lies from a shape's boundary.
 *
 * To the boundary, not to its nearest vertex — a state border is often a single
 * straight edge hundreds of kilometres long with nothing in between, and a
 * vertex test would decide a stroke drawn along the middle of it was nowhere
 * near a border at all.
 */
export function distanceToBoundary(shape: Polygon | MultiPolygon, p: Position): number {
  return nearestOnBoundary(shape, p)?.distance ?? Infinity;
}

/** How far a run of boundary sits from a stroke, for choosing which neighbour follows an edit. */
export function boundaryFollows(shape: Polygon | MultiPolygon, run: Position[], tolerance: number): boolean {
  if (run.length < 2) return false;
  let on = 0;
  for (const p of run) {
    const hit = nearestOnBoundary(shape, p);
    if (hit && hit.distance <= tolerance) on++;
  }
  // Most of the run has to lie on this shape's boundary for it to be the
  // neighbour that shares it; a shape that merely touches at a corner does not.
  return on / run.length >= 0.7;
}
