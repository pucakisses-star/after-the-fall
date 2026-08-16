/**
 * Derived political borders (spec §8, §57).
 *
 * Territories store *areas*, not boundaries. The lines between them are computed:
 * every boundary segment is classified by looking at who is on each side.
 *
 *   • two territories under the same sovereign → the finer of their two border
 *     weights (an internal provincial hairline)
 *   • two territories under different sovereigns → the heavier weight (a
 *     sovereign border)
 *   • nobody on the other side → that territory's own border weight (its coast
 *     or outer frontier)
 *
 * That single rule is what §57 asks for: assign counties to states, and the
 * national borders appear and disappear on their own.
 *
 * The result is memoised on the identity of the territories record, so panning
 * and zooming never recompute it.
 */

import { borderWeightFor } from '@/model/defaults';
import { sovereignOf } from '@/model/hierarchy';
import { visibleInTime } from '@/model/timeline';
import { deriveBorders, mergeBorderSegments } from '@/geo/topology';
import { coastlinePolygons } from '@/io/importers';
import type { BorderStyleKind, MapProject, Territory, UUID } from '@/model/types';
import type { LineString, MultiPolygon, Polygon } from 'geojson';

export interface ClassifiedBorder {
  geometry: LineString;
  kind: BorderStyleKind;
  /**
   * This run lies along the coastline: land on one side, open water on the
   * other. Not a border anybody drew — it is where the country stops because
   * the ground does — so the renderers leave it to the coastline rather than
   * stroking a political line over the sea's edge.
   */
  coastal: boolean;
  /** Territories on each side, for hit-testing and inspection. */
  left: UUID;
  right: UUID | null;
}

let cacheKey: unknown = null;
let cacheTimeKey: string | null = null;
let cacheValue: ClassifiedBorder[] = [];

// ---------------------------------------------------------------------------
// The coastline, for telling a coast from a frontier
// ---------------------------------------------------------------------------

/**
 * Bumped when the coastline arrives, so callers that cache derived borders can
 * fold it into their key and reclassify once the coast is known.
 */
export let coastGeneration = 0;

const coastListeners = new Set<() => void>();

/**
 * Run `cb` when the coastline finishes loading, so a renderer that has already
 * drawn the borders once can redraw them classified. Returns an unsubscribe.
 */
export function onCoastReady(cb: () => void): () => void {
  coastListeners.add(cb);
  return () => coastListeners.delete(cb);
}

let coastIndex: CoastVertices | null | undefined;

function requestCoast(): void {
  if (coastIndex !== undefined) return;
  coastIndex = null;
  coastlinePolygons()
    .then((land) => {
      coastIndex = indexCoastVertices(land);
      invalidateBorderCache();
      coastGeneration++;
      for (const cb of coastListeners) cb();
    })
    .catch(() => {
      // No coastline — a headless test, or the fetch failed. Everything is a
      // frontier then, which is the drawing this map always made.
    });
}

// ---------------------------------------------------------------------------
// Is this vertex on the shore?
// ---------------------------------------------------------------------------

/**
 * Grid side, in degrees. Two cells cover the tolerance below with room to
 * spare, which is what lets a lookup read a 3×3 neighbourhood and stop.
 */
const COAST_CELL = 0.01;
/** How near a vertex has to be to the coastline to be *on* it, in degrees. */
const COAST_TOLERANCE = 0.0008;

/** Coastline vertices in a uniform grid, for asking the question in constant time. */
export interface CoastVertices {
  /** Flat [x, y, x, y, …] per cell. */
  cells: Map<number, number[]>;
}

export function indexCoastVertices(land: (Polygon | MultiPolygon)[]): CoastVertices {
  const cells = new Map<number, number[]>();
  for (const g of land) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of polys) {
      for (const ring of rings) {
        for (const [x, y] of ring) {
          const k = cellKey(x, y);
          const bucket = cells.get(k);
          if (bucket) bucket.push(x, y);
          else cells.set(k, [x, y]);
        }
      }
    }
  }
  return { cells };
}

/** Cell id packed into one number, so the map is keyed without building strings. */
function cellKey(x: number, y: number): number {
  const cx = Math.floor(x / COAST_CELL);
  const cy = Math.floor(y / COAST_CELL);
  // Longitude spans 36,000 cells at this size; the shift is comfortably clear.
  return cy * 131072 + cx;
}

/** Does a coastline vertex sit within the tolerance of this point? */
export function onCoast(index: CoastVertices, x: number, y: number): boolean {
  const cx = Math.floor(x / COAST_CELL);
  const cy = Math.floor(y / COAST_CELL);
  const tol2 = COAST_TOLERANCE * COAST_TOLERANCE;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = index.cells.get((cy + dy) * 131072 + (cx + dx));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i += 2) {
        const ex = bucket[i] - x;
        const ey = bucket[i + 1] - y;
        if (ex * ex + ey * ey <= tol2) return true;
      }
    }
  }
  return false;
}

/**
 * A stretch shorter than this many segments flips to match its neighbours.
 *
 * Where a frontier meets the sea its last vertex is a coastline vertex too, so
 * the join reads as a segment of coast in the middle of a frontier. Without the
 * smoothing that draws as a one-segment gap in the border at every river mouth
 * and headland the frontier ends on.
 */
const COAST_SMOOTH = 3;

/**
 * Split a one-sided border into its coastal and frontier stretches.
 *
 * One run cannot simply be voted on. A territory reaching the sea has a single
 * merged outline run — same owner on the left, nobody on the right, all the way
 * round — so its coast and its inland frontier arrive as one line, and a vote
 * either strokes the coast or silences the frontier, whichever is longer.
 * Measured on the demonstration map's Baja: one 778-point run around the whole
 * peninsula tip, coast and frontier together, drawn all-soft by the vote. So
 * each segment is classified on its own and consecutive segments of a kind
 * become one stretch.
 *
 * The test is coincidence rather than geometry, and that is the whole
 * performance of this file. Asking "is there land on one side and sea on the
 * other" means a point-in-polygon probe either side of every segment, against a
 * coastline of four thousand parts: it cost eight and a half seconds per
 * classification on the demonstration map, and since the borders are re-derived
 * whenever the territory set changes, that was eight and a half seconds on
 * every fill, paint and border edit. But a territory's coastal edge does not
 * merely run *near* the shore — it *is* the shore, vertex for vertex, because
 * every path that puts ground on the map clips it to the coastline. So the
 * question is whether this segment's endpoints are coastline vertices, which is
 * a lookup in a grid: the same classification, measured at a hundredth of the
 * cost.
 */
export function splitByCoast(
  line: LineString,
  coast: CoastVertices,
): { coastal: boolean; geometry: LineString }[] {
  const ring = line.coordinates;
  if (ring.length < 2) return [{ coastal: false, geometry: line }];

  // One lookup per vertex rather than two per segment: neighbouring segments
  // share an end, and on a coastal run that is every vertex asked twice.
  const shore: boolean[] = ring.map(([x, y]) => onCoast(coast, x, y));

  const kinds: boolean[] = [];
  for (let i = 1; i < ring.length; i++) kinds.push(shore[i - 1] && shore[i]);

  // Flip stretches too short to mean anything.
  for (let i = 0; i < kinds.length; ) {
    let j = i;
    while (j < kinds.length && kinds[j] === kinds[i]) j++;
    if (j - i < COAST_SMOOTH && (i > 0 || j < kinds.length)) {
      const fill = i > 0 ? kinds[i - 1] : kinds[j];
      for (let k = i; k < j; k++) kinds[k] = fill;
    }
    i = j;
  }

  const out: { coastal: boolean; geometry: LineString }[] = [];
  let start = 0;
  for (let i = 1; i <= kinds.length; i++) {
    if (i === kinds.length || kinds[i] !== kinds[start]) {
      out.push({
        coastal: kinds[start],
        geometry: { type: 'LineString', coordinates: ring.slice(start, i + 1) },
      });
      start = i;
    }
  }
  return out;
}

export function computeBorders(project: MapProject): ClassifiedBorder[] {
  requestCoast();
  const timeKey = project.timeline.enabled ? String(project.timeline.currentYear) : 'all';
  if (cacheKey === project.territories && cacheTimeKey === timeKey) return cacheValue;

  const territories = Object.values(project.territories).filter(
    (t) => !t.hidden && visibleInTime(t.timeline, project.timeline),
  );
  const byId = new Map<UUID, Territory>(territories.map((t) => [t.id, t]));

  const raw = mergeBorderSegments(deriveBorders(territories));
  const out: ClassifiedBorder[] = [];

  for (const b of raw) {
    const left = byId.get(b.left);
    if (!left) continue;
    const right = b.right ? byId.get(b.right) : undefined;

    let kind: BorderStyleKind;
    if (!right) {
      kind = left.borderKind;
      // Only a one-sided run can be a coast: where two territories meet, the
      // line between them is a border whatever ground it crosses. One run can
      // be both in turn — a coast and then an inland frontier — so it is split
      // rather than judged whole.
      if (coastIndex) {
        for (const piece of splitByCoast(b.geometry, coastIndex)) {
          out.push({ geometry: piece.geometry, kind, coastal: piece.coastal, left: b.left, right: b.right });
        }
        continue;
      }
    } else {
      const sovL = sovereignOf(project, left.id)?.id;
      const sovR = sovereignOf(project, right.id)?.id;
      if (sovL && sovR && sovL === sovR) {
        // Same state either side — draw the quieter of the two lines.
        kind =
          borderWeightFor(left.borderKind) <= borderWeightFor(right.borderKind)
            ? left.borderKind
            : right.borderKind;
      } else {
        // Different states — the border is as strong as the stronger claim.
        kind =
          borderWeightFor(left.borderKind) >= borderWeightFor(right.borderKind)
            ? left.borderKind
            : right.borderKind;
      }
    }

    out.push({ geometry: b.geometry, kind, coastal: false, left: b.left, right: b.right });
  }

  // Draw quiet lines first so heavy sovereign borders land on top of them.
  out.sort((a, b) => borderWeightFor(a.kind) - borderWeightFor(b.kind));

  cacheKey = project.territories;
  cacheTimeKey = timeKey;
  cacheValue = out;
  return out;
}

export function invalidateBorderCache(): void {
  cacheKey = null;
  cacheTimeKey = null;
  cacheValue = [];
}
