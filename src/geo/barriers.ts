/**
 * The lines a fill may not cross (spec §6, §57).
 *
 * A frontier on a real map follows something: a river, the crest of a range, the
 * boundary of the county it was carved out of. The paint bucket is how that gets
 * drawn here — click one side of a river and the realm takes everything up to
 * it — and this is where "a river" stops being a picture and becomes geometry
 * the fill can be stopped by.
 *
 * What counts is what the user can see and has said they mean. A selection is
 * the strongest statement: select a river and it is the only wall. With nothing
 * selected, every line the map is currently drawing counts — the document's own
 * rivers and roads on visible layers, and the reference layers left switched on.
 * Turning a layer off takes it out of the fill, which is the same gesture as
 * taking it off the plate.
 */

import { findBasemapSource, loadBasemap } from './basemap';
import { coastlinePolygons, lakePolygons } from '@/io/importers';
import { layerEffective } from '@/model/hierarchy';
import { normalizePoly } from './operations';
import type { Poly } from './operations';
import type { MapProject, UUID } from '@/model/types';
import type { Position } from 'geojson';

/**
 * Reference layers whose geometry is a boundary worth stopping at.
 *
 * Water and administrative divisions, not roads or places: a road network runs
 * through every territory it serves and would shatter each fill into the blocks
 * between junctions, which is not a political boundary anybody has ever drawn.
 * Lakes are listed so the panel names them among the barriers, but they are
 * consumed as water rather than as lines — `barrierWaters` below — because a
 * lake bounds a fill the way the sea does, not the way a river does.
 */
export const BARRIER_ROLES = ['rivers', 'lakes', 'counties', 'states', 'countries'] as const;

/** One human-readable name per barrier layer in play, for the panel and the toast. */
export function barrierSources(project: MapProject): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const entry of project.basemap) {
    if (!entry.visible) continue;
    const source = findBasemapSource(entry.sourceId);
    if (!source?.role) continue;
    if (!(BARRIER_ROLES as readonly string[]).includes(source.role)) continue;
    out.push({ id: source.id, name: source.name });
  }
  return out;
}

/** Every ring and line of a geometry, as bare coordinate arrays. */
function linesOf(geometry: { type: string; coordinates: unknown }): Position[][] {
  switch (geometry.type) {
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates as Position[][];
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat();
    default:
      return [];
  }
}

/**
 * The document's own lines: rivers, roads and coastlines the user has drawn.
 *
 * Label paths are excluded — they are invisible carriers for text, and a name
 * curving through a realm is not a claim about where it ends.
 */
function projectLines(project: MapProject, selection: UUID[]): Position[][] {
  const selected = selection.filter((id) => project.linearFeatures[id]);
  const chosen = selected.length
    ? selected.map((id) => project.linearFeatures[id])
    : Object.values(project.linearFeatures).filter(
        (f) => !f.hidden && layerEffective(project, f.layerId).visible,
      );

  const out: Position[][] = [];
  for (const f of chosen) {
    if (f.kind === 'label-path') continue;
    out.push(...linesOf(f.geometry));
  }
  return out;
}

/**
 * Every line the fill should stop at, in WGS84.
 *
 * Asynchronous because the reference layers are fetched, and memoised by
 * `loadBasemap` — so the first fill of a session pays for the rivers and the
 * rest are immediate. A layer that fails to load is skipped rather than failing
 * the fill: a barrier that is not there is a fill that goes further, which the
 * user can see and undo.
 *
 * Lakes are deliberately absent: a lake is not a line but water, and a fill
 * treats it the way it treats the sea — `barrierWaters` below is its half.
 * Cutting a shoreline as a line taught us why: the fill's pocket-healing pass,
 * which repairs the scraps where two barrier lines cross, sees the severed lake
 * as ground that was solid before the cut and quietly pastes it back. Absent
 * from the answer, that is — a shoreline is still in the network the dangling
 * ends are closed *against*, the same as the coast, so a river that stops short
 * of the lake it runs into is carried the rest of the way.
 */
export async function barrierLines(project: MapProject, selection: UUID[] = []): Promise<Position[][]> {
  const own = projectLines(project, selection);
  // An explicit selection is the whole answer: the user pointed at the line they
  // meant, and adding every river on the continent to it would ignore them.
  if (selection.some((id) => project.linearFeatures[id])) return own;

  const { reference, close } = await referenceNetwork(project);
  // The map's own rivers are closed against the same network; there are a
  // handful of them and the index is already built, so this costs nothing.
  return [...close(own), ...reference];
}

/**
 * The reference barriers, gap-closed, built once per set of visible layers.
 *
 * Indexing a continent of rivers takes the better part of a second, and the
 * fill asks for the barriers on every click — so the answer is held until the
 * layers behind it change, which is the only thing that can alter it.
 */
let networkCache:
  | { key: string; reference: Position[][]; close: (lines: Position[][]) => Position[][] }
  | null = null;

async function referenceNetwork(project: MapProject): Promise<{
  reference: Position[][];
  close: (lines: Position[][]) => Position[][];
}> {
  const sources = barrierSources(project).filter(
    (s) => findBasemapSource(s.id)?.role !== 'lakes',
  );
  const key = sources.map((s) => s.id).join('|');
  if (networkCache?.key === key) return networkCache;

  const lines: Position[][] = [];
  for (const source of sources) {
    try {
      for (const f of await loadBasemap(source.id)) lines.push(...linesOf(f.geometry));
    } catch {
      // Reported by the layer panel already; a missing barrier is not a reason
      // to refuse the fill.
    }
  }
  // The coast is where a river ends, so it has to be in the network the ends are
  // closed against — the shore itself is already the region's edge, and a
  // hairline drawn along it changes nothing.
  const coast: Position[][] = [];
  try {
    for (const g of await coastlinePolygons()) coast.push(...linesOf(g));
  } catch {
    // No coastline: mouths stay as they are, which is how it was before.
  }
  // And so is a lakeshore, for exactly the same reason. A lake is water rather
  // than a line and so stays out of `reference` below — but a river that runs
  // into one still ends *at* it, and on the shipped rivers 486 of those mouths
  // stop short of the shore, 471 of them by less than five hundred metres. With
  // nothing there to reach, each was a hole the flood poured through and walked
  // round the river by. The coast is in this network already and its mouths
  // hold; the lakes were the half that was missing.
  const shore: Position[][] = [];
  try {
    for (const g of await lakePolygons()) shore.push(...linesOf(g));
  } catch {
    // Same bargain as the coast: no lakes, no bridging, which is how it was.
  }
  const close = makeGapCloser([...lines, ...coast, ...shore]);
  networkCache = { key, reference: close(lines), close };
  return networkCache;
}

/**
 * How far a dangling end may reach to find the network it belongs to, in km.
 *
 * Generous enough to cross the disagreement between two datasets drawn at the
 * same scale — a tributary's mouth and the trunk it joins are separate features
 * traced separately, and a kilometre covers where they part company. Short
 * enough that it cannot invent a frontier: a stream that genuinely stops in open
 * country finds nothing within this and is left alone.
 */
const GAP_BRIDGE_KM = 1.5;
/**
 * How far a headwater is carried on along its own course, in km.
 *
 * The other half of why a small river did not stop a fill, and the larger half:
 * measured on the shipped rivers, a leaking tributary's source sits 7 to 28 km
 * from anything else, so the flood simply walks round the top of the stream and
 * comes back down the other bank. A drawn stream is the visible part of a
 * watershed that runs on to the divide, so a dangling source is continued along
 * the bearing it ended on until it meets the next water — which is where the
 * divide between two valleys actually lies.
 *
 * Capped, and only ever to a *hit*: a source with nothing within this reach is
 * left as it was rather than given an invented frontier running off into open
 * country.
 */
const HEADWATER_REACH_KM = 60;
/** Grid side for the segment index, in degrees — comfortably over the reach above. */
const GAP_CELL = 0.05;
const DEGREE_KM = 111.32;

/**
 * Close the pinholes a river network leaks through (spec §6, §57).
 *
 * A barrier stops a fill only if it reaches all the way across the ground being
 * filled, and a river network is not one line but thousands of separately traced
 * features. Measured on the shipped rivers, 1,525 of their ends stop between
 * 35 m and 5 km short of the water they run into — a tributary that does not
 * quite touch its trunk, a mouth that stops short of the shore. The wall a fill
 * cuts is 33 m wide, so every one of those is a hole the flood pours through,
 * and it is why the big rivers held while the small ones did not: a trunk runs
 * coast to coast, a tributary is a chain and a chain is only as good as its
 * joints.
 *
 * So each dangling end is walked to the nearest line within `GAP_BRIDGE_KM` and
 * joined to it. Nothing is extended into open country: an end with nothing near
 * it is a headwater, and a stream that really does stop in the hills leaves the
 * two banks connected around its source, which is the truth about that ground.
 */
export function closeBarrierGaps(lines: Position[][], extra: Position[][] = []): Position[][] {
  return makeGapCloser([...lines, ...extra])(lines);
}

/**
 * Build the closer once, use it many times.
 *
 * The index over the network is the whole cost of this file — a pass over
 * every segment of every river on the continent — and the fill asks for the
 * barriers on every click. Handing back a function that owns the index lets the
 * reference network be indexed once a session while the map's own lines, which
 * do change, are closed against it for the price of the lines themselves.
 */
export function makeGapCloser(all: Position[][]): (lines: Position[][]) => Position[][] {
  // Segment index: cell -> [lineIndex, segIndex, ...]
  const cells = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cy * 131072 + cx;
  for (let li = 0; li < all.length; li++) {
    const line = all[li];
    for (let i = 1; i < line.length; i++) {
      const [x1, y1] = line[i - 1];
      const [x2, y2] = line[i];
      const cx0 = Math.floor(Math.min(x1, x2) / GAP_CELL);
      const cx1 = Math.floor(Math.max(x1, x2) / GAP_CELL);
      const cy0 = Math.floor(Math.min(y1, y2) / GAP_CELL);
      const cy1 = Math.floor(Math.max(y1, y2) / GAP_CELL);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = key(cx, cy);
          const bucket = cells.get(k);
          if (bucket) bucket.push(li, i);
          else cells.set(k, [li, i]);
        }
      }
    }
  }

  /** Nearest point on any line other than `self`, within `maxDeg`. */
  const nearest = (x: number, y: number, self: number, maxDeg: number): Position | null => {
    const cx = Math.floor(x / GAP_CELL);
    const cy = Math.floor(y / GAP_CELL);
    const span = Math.max(1, Math.ceil(maxDeg / GAP_CELL));
    let best: Position | null = null;
    let bestD2 = maxDeg * maxDeg;
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const bucket = cells.get(key(cx + dx, cy + dy));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b += 2) {
          const li = bucket[b];
          if (li === self) continue;
          const line = all[li];
          const i = bucket[b + 1];
          const [ax, ay] = line[i - 1];
          const [bx, by] = line[i];
          const vx = bx - ax;
          const vy = by - ay;
          const len2 = vx * vx + vy * vy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
          const px = ax + t * vx;
          const py = ay + t * vy;
          const d2 = (px - x) * (px - x) + (py - y) * (py - y);
          if (d2 < bestD2) {
            bestD2 = d2;
            best = [px, py];
          }
        }
      }
    }
    return best;
  };

  /**
   * Where a stream carried on along `dir` from `(x, y)` first meets other water.
   *
   * The ray is walked one cell at a time so only the segments it actually passes
   * are tested; the first crossing wins, and nothing is returned if the reach
   * runs out first.
   */
  const firstHit = (
    x: number,
    y: number,
    dx: number,
    dy: number,
    self: number,
    reachDeg: number,
  ): Position | null => {
    const step = GAP_CELL / 2;
    const steps = Math.ceil(reachDeg / step);
    const seen = new Set<number>();
    let bestT = Infinity;
    let best: Position | null = null;
    for (let s = 0; s <= steps; s++) {
      const px = x + dx * step * s;
      const py = y + dy * step * s;
      const cx = Math.floor(px / GAP_CELL);
      const cy = Math.floor(py / GAP_CELL);
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const k = key(cx + ddx, cy + ddy);
          if (seen.has(k)) continue;
          seen.add(k);
          const bucket = cells.get(k);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b += 2) {
            const li2 = bucket[b];
            if (li2 === self) continue;
            const line = all[li2];
            const i = bucket[b + 1];
            const [ax, ay] = line[i - 1];
            const [bx, by] = line[i];
            // Ray (x,y)+t·d against segment a→b.
            const ex = bx - ax;
            const ey = by - ay;
            const den = dx * ey - dy * ex;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((ax - x) * ey - (ay - y) * ex) / den;
            const u = ((ax - x) * dy - (ay - y) * dx) / den;
            if (t <= 1e-9 || t > reachDeg || u < 0 || u > 1) continue;
            if (t < bestT) {
              bestT = t;
              best = [x + dx * t, y + dy * t];
            }
          }
        }
      }
      if (best && bestT <= step * s) break;
    }
    return best;
  };

  return (lines: Position[][]): Position[][] => {
  const out: Position[][] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length < 2) {
      out.push(line);
      continue;
    }
    // Latitude shrinks a degree of longitude, so the reach is measured where the
    // end actually is rather than at the equator.
    const lat = line[0][1];
    const lonScale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const perDeg = DEGREE_KM * Math.min(1, lonScale);
    const maxDeg = GAP_BRIDGE_KM / perDeg;
    const reachDeg = HEADWATER_REACH_KM / perDeg;

    /** Join a dangling end to what it nearly touches, or carry it on to what it would. */
    const close = (at: Position, from: Position): Position | null => {
      const near = nearest(at[0], at[1], li, maxDeg);
      if (near) return near;
      let dx = at[0] - from[0];
      let dy = at[1] - from[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) return null;
      dx /= len;
      dy /= len;
      return firstHit(at[0], at[1], dx, dy, li, reachDeg);
    };

    const head = close(line[0], line[Math.min(2, line.length - 1)]);
    const tail = close(line[line.length - 1], line[Math.max(0, line.length - 3)]);
    if (!head && !tail) {
      out.push(line);
      continue;
    }
    const joined = [...line];
    if (head) joined.unshift(head);
    if (tail) joined.push(tail);
    out.push(joined);
  }
  return out;
  };
}

/**
 * The standing water the fill may not pour over, in WGS84.
 *
 * Lake polygons, subtracted from the fill region the same way the sea already
 * is: a fill clicked on one bank stops at the shore, the far bank is reached
 * only around the ends of the lake — real land connectivity — and the water
 * itself belongs to nobody. Unlike the line barriers this is not a visibility
 * gesture: a lake does not stop being a lake because the layer showing it is
 * hidden, any more than the sea stops being the sea — the same bundled lakes
 * the trim subtracts on every commit.
 */
export async function barrierWaters(): Promise<Poly[]> {
  try {
    const waters: Poly[] = [];
    for (const g of await lakePolygons()) {
      const p = normalizePoly(g as Poly);
      if (p) waters.push(p);
    }
    return waters;
  } catch {
    // Same bargain as above: a missing lake is a fill that goes further.
    return [];
  }
}
