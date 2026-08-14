/**
 * Putting a frontier onto the river it runs beside (spec §6, §16, §55).
 *
 * Rivers are the boundary of first resort in the real world, and the growth
 * already knows it: crossing a watercourse costs extra, so a frontier settles
 * along one rather than cutting across. But settling *near* a river is not
 * lying *on* it. The frontier is traced on a twenty-kilometre lattice and then
 * rounded off, so what comes out is a smooth arc that wanders back and forth
 * across the river it was supposed to follow — the one thing a reader checks a
 * border against, and it visibly misses.
 *
 * So a dressed arc is offered the rivers near it, and any stretch running
 * within a tolerance of one of them is replaced by that river's own course.
 *
 * Shared borders survive it (§6). Two realms either side of a frontier hold the
 * same arc, one of them reversed, and everything here is symmetric under
 * reversal: which vertices are near a river does not depend on the direction of
 * travel, a stretch of river between two points is the same stretch either way
 * round, and the arc's endpoints — the junctions where three realms meet — are
 * pinned and never moved.
 */

import type { Position } from 'geojson';

/** Rivers bucketed by grid cell, so a point only meets the few segments near it. */
export interface RiverIndex {
  /** Each river as its own polyline; a snapped run must stay on one of them. */
  lines: Position[][];
  cell: number;
  buckets: Map<string, { line: number; seg: number }[]>;
}

const key = (cx: number, cy: number) => `${cx},${cy}`;

/**
 * How much of the frontier's own length the river must cover to count as the
 * course it follows rather than something it merely crosses.
 */
const ALONG_SHARE = 0.5;

/**
 * Longitude degrees shrink towards the poles, so a tolerance in raw degrees
 * would reach three times further across Alaska than across the Amazon. Every
 * distance here is measured with longitude scaled by the latitude it is at.
 */
const lonScale = (lat: number) => Math.max(0.2, Math.cos((lat * Math.PI) / 180));

export function indexRivers(lines: Position[][], cell: number): RiverIndex {
  const buckets = new Map<string, { line: number; seg: number }[]>();
  const size = Math.max(1e-6, cell);
  for (let line = 0; line < lines.length; line++) {
    const pts = lines[line];
    for (let seg = 0; seg < pts.length - 1; seg++) {
      const [ax, ay] = pts[seg];
      const [bx, by] = pts[seg + 1];
      const c0 = Math.floor(Math.min(ax, bx) / size);
      const c1 = Math.floor(Math.max(ax, bx) / size);
      const r0 = Math.floor(Math.min(ay, by) / size);
      const r1 = Math.floor(Math.max(ay, by) / size);
      // A segment longer than a few cells would blanket the grid; rivers at
      // 1:10m are far finer than any tolerance worth snapping at, so this only
      // guards against a pathological input.
      if ((c1 - c0) * (r1 - r0) > 4096) continue;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = key(c, r);
          const list = buckets.get(k);
          if (list) list.push({ line, seg });
          else buckets.set(k, [{ line, seg }]);
        }
      }
    }
  }
  return { lines, cell: size, buckets };
}

interface Hit {
  line: number;
  /** Position along the river: segment index plus the fraction along it. */
  at: number;
  point: Position;
  distance: number;
}

/** The nearest point on any river within `tolerance`, or null. */
function nearestRiver(index: RiverIndex, p: Position, tolerance: number): Hit | null {
  const [px, py] = p;
  const sx = lonScale(py);
  // The search box in raw degrees: the tolerance reaches further in longitude
  // than in latitude, by exactly the scale factor.
  const reachX = tolerance / sx;
  const c0 = Math.floor((px - reachX) / index.cell);
  const c1 = Math.floor((px + reachX) / index.cell);
  const r0 = Math.floor((py - tolerance) / index.cell);
  const r1 = Math.floor((py + tolerance) / index.cell);

  let best: Hit | null = null;
  const seen = new Set<number>();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const list = index.buckets.get(key(c, r));
      if (!list) continue;
      for (const { line, seg } of list) {
        // A segment spans several cells, so the same one arrives more than once.
        const id = line * 1e6 + seg;
        if (seen.has(id)) continue;
        seen.add(id);

        const pts = index.lines[line];
        const [ax, ay] = pts[seg];
        const [bx, by] = pts[seg + 1];
        const dx = (bx - ax) * sx;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : (((px - ax) * sx * dx + (py - ay) * dy) / len2);
        t = Math.max(0, Math.min(1, t));
        const qx = ax + (bx - ax) * t;
        const qy = ay + (by - ay) * t;
        const d = Math.hypot((px - qx) * sx, py - qy);
        if (d <= tolerance && (!best || d < best.distance)) {
          best = { line, at: seg + t, point: [qx, qy], distance: d };
        }
      }
    }
  }
  return best;
}

/** Length of a polyline, with longitude scaled by the latitude it sits at. */
function lengthOf(pts: Position[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const sx = lonScale((pts[i][1] + pts[i + 1][1]) / 2);
    total += Math.hypot((pts[i + 1][0] - pts[i][0]) * sx, pts[i + 1][1] - pts[i][1]);
  }
  return total;
}

/** The river's own course between two positions along it, endpoints included. */
function courseBetween(line: Position[], from: Hit, to: Hit): Position[] {
  const out: Position[] = [from.point];
  if (from.at < to.at) {
    for (let i = Math.ceil(from.at); i <= Math.floor(to.at); i++) {
      if (i > from.at && i < to.at) out.push(line[i]);
    }
  } else {
    for (let i = Math.floor(from.at); i >= Math.ceil(to.at); i--) {
      if (i < from.at && i > to.at) out.push(line[i]);
    }
  }
  out.push(to.point);
  return out;
}

/**
 * Replace every stretch of an arc that runs beside a river with the river.
 *
 * Both ends stay exactly where they were: they are the junctions where three
 * realms meet, and moving one in this arc but not in the two others that share
 * it would tear the map open at that point.
 *
 * A stretch qualifies on three counts, and each one is a mistake seen and
 * fixed. Three or more consecutive vertices must lie within the tolerance of
 * the *same* river, or a single vertex passing near a tributary drags the
 * border onto it and straight back. They must travel along it in a consistent
 * direction, or a frontier crossing a meander is snapped to a course that
 * doubles back. And the river must actually go somewhere over that stretch —
 * a frontier crossing a river at right angles has several vertices near it,
 * all projecting onto much the same point, and snapping there swings the border
 * along the bank and back for no reason. Following a river means travelling
 * with it, so the course has to cover a fair share of the ground the frontier
 * covered.
 */
export function snapToRivers(arc: Position[], index: RiverIndex, tolerance: number): Position[] {
  if (arc.length < 4 || tolerance <= 0) return arc;

  const hits = arc.map((p) => nearestRiver(index, p, tolerance));
  const out: Position[] = [];
  let i = 0;
  let snapped = false;

  while (i < arc.length) {
    const hit = hits[i];
    // How far the same river continues, keeping one direction along it.
    let j = i;
    if (hit) {
      let direction = 0;
      while (j + 1 < arc.length) {
        const next = hits[j + 1];
        if (!next || next.line !== hit.line) break;
        const step = next.at - hits[j]!.at;
        if (step === 0) break;
        const sign = step > 0 ? 1 : -1;
        if (direction === 0) direction = sign;
        else if (sign !== direction) break;
        j++;
      }
    }

    // The first and last vertices are pinned, so a run that reaches an end of
    // the arc gives up that vertex rather than the junction.
    if (hit && j - i >= 2) {
      const course = courseBetween(index.lines[hit.line], hits[i]!, hits[j]!);
      if (lengthOf(course) >= lengthOf(arc.slice(i, j + 1)) * ALONG_SHARE) {
        if (i === 0) out.push(arc[0]);
        for (const p of course) out.push(p);
        if (j === arc.length - 1) out.push(arc[arc.length - 1]);
        snapped = true;
        i = j + 1;
        continue;
      }
    }

    out.push(arc[i]);
    i++;
  }

  if (!snapped) return arc;
  // Rounding matches the rest of the outline, and drops any duplicate the
  // handover between a snapped run and the arc either side may have left.
  const cleaned: Position[] = [];
  for (const p of out) {
    const q: Position = [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))];
    const last = cleaned[cleaned.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    cleaned.push(q);
  }
  return cleaned.length >= 2 ? cleaned : arc;
}
