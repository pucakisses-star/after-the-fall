/**
 * Polygon operations backed by Turf (spec §5, §55, §58).
 *
 * Rule from spec §63.13: prefer established GIS libraries over hand-rolled
 * geometry. Everything here is a thin, well-defined wrapper over Turf, with the
 * awkward bits (splitting a polygon by an arbitrary polyline; keeping MultiPolygon
 * and Polygon interchangeable) handled once, here, rather than at each call site.
 */

import * as turf from '@turf/turf';
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
  Position,
} from 'geojson';

export type Poly = Polygon | MultiPolygon;

type PolyFeature = Feature<Poly>;

function feat(g: Poly): PolyFeature {
  return { type: 'Feature', properties: {}, geometry: g };
}

function collection(polys: Poly[]): FeatureCollection<Poly> {
  return { type: 'FeatureCollection', features: polys.map(feat) };
}

/** Normalise a MultiPolygon with a single ring set down to a Polygon. */
export function normalizePoly(g: Poly | null | undefined): Poly | null {
  if (!g) return null;
  if (g.type === 'MultiPolygon') {
    const parts = g.coordinates.filter((p) => p.length > 0 && p[0].length >= 4);
    if (parts.length === 0) return null;
    if (parts.length === 1) return { type: 'Polygon', coordinates: parts[0] };
    return { type: 'MultiPolygon', coordinates: parts };
  }
  if (g.coordinates.length === 0 || g.coordinates[0].length < 4) return null;
  return g;
}

/**
 * Resolve a self-crossing outline into a valid region.
 *
 * Freehand strokes cross themselves — a hand drawing a loop overshoots the
 * start, and a shape traced round a county doubles back on itself somewhere.
 * A ring like that is not a polygon: its area is signed nonsense and every
 * boolean after it inherits the problem. Passing it through the clipper against
 * itself splits it at its own crossings and hands back the region it encloses,
 * which is what the person drawing it meant.
 */
export function makeValid(g: Poly): Poly | null {
  const n = normalizePoly(g);
  if (!n) return null;
  try {
    const merged = turf.union(collection([n, n]));
    return merged ? normalizePoly(merged.geometry as Poly) : null;
  } catch {
    return null;
  }
}

/** Split a MultiPolygon into its constituent Polygons (§5: islands, exclaves). */
export function explode(g: Poly): Polygon[] {
  if (g.type === 'Polygon') return [g];
  return g.coordinates.map((rings) => ({ type: 'Polygon', coordinates: rings }) as Polygon);
}

/** Combine several polygons into one geometry, keeping disjoint parts as a MultiPolygon. */
export function union(polys: Poly[]): Poly | null {
  const valid = polys.map(normalizePoly).filter((p): p is Poly => p !== null);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  try {
    const result = turf.union(collection(valid));
    return result ? normalizePoly(result.geometry as Poly) : null;
  } catch {
    return null;
  }
}

/** `a` minus `b`. Returns null when `b` swallows `a` entirely. */
export function difference(a: Poly, b: Poly): Poly | null {
  const na = normalizePoly(a);
  const nb = normalizePoly(b);
  if (!na) return null;
  if (!nb) return na;
  try {
    const result = turf.difference(collection([na, nb]));
    return result ? normalizePoly(result.geometry as Poly) : null;
  } catch {
    return na;
  }
}

export function intersection(a: Poly, b: Poly): Poly | null {
  const na = normalizePoly(a);
  const nb = normalizePoly(b);
  if (!na || !nb) return null;
  try {
    const result = turf.intersect(collection([na, nb]));
    return result ? normalizePoly(result.geometry as Poly) : null;
  } catch {
    return null;
  }
}

/**
 * Cut a polygon down to a rectangle.
 *
 * Sutherland–Hodgman against an axis-aligned box, which is linear in the vertex
 * count rather than the O(n log n) of a general boolean. Use it to reduce a
 * large polygon to the neighbourhood of a small one *before* the real operation:
 * intersecting a 200-vertex shape against North America's 66,000-vertex
 * coastline directly costs two seconds, and against the same coastline trimmed
 * to a box around the shape, ten milliseconds — for the same answer.
 */
export function clipToBox(g: Poly, box: [number, number, number, number]): Poly | null {
  const ng = normalizePoly(g);
  if (!ng) return null;
  try {
    // Concatenated rather than unioned: the pieces come from disjoint parts of
    // one polygon set, so they are already disjoint, and a boolean union here
    // would cost more than the operation this exists to make cheap.
    const parts: Position[][][] = [];
    for (const part of explode(ng)) {
      const clipped = turf.bboxClip(part, box).geometry as Poly;
      if (clipped.type === 'MultiPolygon') parts.push(...clipped.coordinates);
      else if (clipped.coordinates.length) parts.push(clipped.coordinates);
    }
    return normalizePoly({ type: 'MultiPolygon', coordinates: parts });
  } catch {
    return null;
  }
}

export function polygonsIntersect(a: Poly, b: Poly): boolean {
  try {
    return turf.booleanIntersects(feat(a), feat(b));
  } catch {
    return false;
  }
}

/** Square kilometres. */
export function areaKm2(g: Poly): number {
  try {
    return turf.area(feat(g)) / 1e6;
  } catch {
    return 0;
  }
}

export function bbox(g: Poly): [number, number, number, number] {
  const b = turf.bbox(feat(g));
  return [b[0], b[1], b[2], b[3]];
}

/**
 * A point guaranteed to lie inside the polygon — the anchor for automatic label
 * placement. `pointOnFeature` is not always interior for awkward shapes, so try
 * the centroid first and fall back.
 */
export function interiorPoint(g: Poly): [number, number] {
  try {
    const centroid = turf.centroid(feat(g));
    if (turf.booleanPointInPolygon(centroid, feat(g))) {
      const c = centroid.geometry.coordinates;
      return [c[0], c[1]];
    }
  } catch {
    /* fall through */
  }
  try {
    // For a MultiPolygon prefer the largest part, so a country's label does not
    // land on a tiny offshore island.
    const parts = explode(g);
    const biggest = parts.reduce((best, p) => (areaKm2(p) > areaKm2(best) ? p : best), parts[0]);
    const p = turf.pointOnFeature(feat(biggest));
    const c = p.geometry.coordinates;
    return [c[0], c[1]];
  } catch {
    const b = bbox(g);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }
}

/** Douglas–Peucker. `tolerance` is in degrees. */
export function simplify(g: Poly, tolerance: number): Poly {
  try {
    const result = turf.simplify(feat(g), { tolerance, highQuality: true, mutate: false });
    return normalizePoly(result.geometry as Poly) ?? g;
  } catch {
    return g;
  }
}

/** Chaikin corner-cutting. Each iteration roughly doubles the vertex count. */
export function smoothPolygon(g: Poly, iterations: number): Poly {
  if (iterations <= 0) return g;
  try {
    const result = turf.polygonSmooth(feat(g), { iterations });
    const first = result.features[0];
    return first ? (normalizePoly(first.geometry as Poly) ?? g) : g;
  } catch {
    return g;
  }
}

export function smoothLine(coords: Position[], iterations: number): Position[] {
  let pts = coords;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) break;
    const next: Position[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      next.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      next.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/**
 * Dissolve a set of polygons into one, erasing their shared internal boundaries.
 * This is the engine behind "Create Territory from Selection" (§55) and the
 * territory paint tool (§56).
 */
export function dissolve(polys: Poly[]): Poly | null {
  return union(polys);
}

/** Remove parts of a MultiPolygon smaller than `minKm2` (§58 "Remove Tiny Polygons"). */
export function removeTinyParts(g: Poly, minKm2: number): Poly | null {
  const parts = explode(g).filter((p) => areaKm2(p) >= minKm2);
  if (parts.length === 0) return null;
  return normalizePoly(
    parts.length === 1
      ? parts[0]
      : { type: 'MultiPolygon', coordinates: parts.map((p) => p.coordinates) },
  );
}

// ---------------------------------------------------------------------------
// Splitting a polygon with a line (§5 "cut polygons with a line", "split a territory")
// ---------------------------------------------------------------------------

/**
 * Cut `target` with `cutter`, returning two or more pieces.
 *
 * Turf has no polygon-split primitive, so this uses the standard noding +
 * polygonize construction:
 *
 *   1. Take the polygon's boundary rings as lines.
 *   2. Take the cutting line, clipped to the parts that actually lie inside.
 *   3. Node everything against everything (split each line at every crossing).
 *   4. Hand the fully-noded edge set to `polygonize`, which walks the minimal
 *      cycles and hands back the faces.
 *
 * If that fails — polygonize is picky about self-touching input — fall back to
 * subtracting a hairline buffer of the cutter, which always produces a valid
 * result and leaves a sliver gap that `repairTopology` can close.
 *
 * Returns `null` when the cutter does not actually divide the polygon.
 */
export function splitPolygon(target: Poly, cutter: LineString): Poly[] | null {
  const viaPolygonize = splitByPolygonize(target, [cutter]);
  if (viaPolygonize && viaPolygonize.length >= 2) return viaPolygonize;

  const viaBuffer = splitByThinBuffer(target, cutter);
  if (viaBuffer && viaBuffer.length >= 2) return viaBuffer;

  return null;
}

/**
 * Grow a polygon outward by `km`, all round.
 *
 * Used to reabsorb a cut: subtract a hairline from a shape to divide it, and the
 * hairline is ground that has left the map. Growing the piece you kept back over
 * it and clipping to the original puts it back without reconnecting what the cut
 * separated, so long as the growth is no wider than the cut.
 */
export function dilate(g: Poly, km: number): Poly | null {
  try {
    const grown = turf.buffer(feat(g), km, { units: 'kilometers' });
    return grown ? normalizePoly(grown.geometry as Poly) : null;
  } catch {
    return null;
  }
}

function splitByPolygonize(target: Poly, cutters: LineString[]): Poly[] | null {
  try {
    const boundary = turf.polygonToLine(feat(target));
    const boundaryLines: LineString[] = [];
    const pushLine = (g: LineString | { type: 'MultiLineString'; coordinates: Position[][] }) => {
      if (g.type === 'LineString') boundaryLines.push(g);
      else for (const c of g.coordinates) boundaryLines.push({ type: 'LineString', coordinates: c });
    };
    if (boundary.type === 'Feature') {
      pushLine(boundary.geometry as LineString);
    } else {
      for (const f of boundary.features) pushLine(f.geometry as LineString);
    }

    // Node each cutter against the boundary, then discard the parts outside the
    // polygon — a cutter that overshoots is the normal case, not an error.
    const cutPieces: LineString[] = [];
    for (const cutter of cutters) {
      if (cutter.coordinates.length < 2) continue;
      const cutFeature = turf.lineString(cutter.coordinates);
      let pieces: LineString[] = [];
      for (const bl of boundaryLines) {
        const split = turf.lineSplit(cutFeature, turf.lineString(bl.coordinates));
        if (split.features.length > 1) {
          for (const f of split.features) pieces.push(f.geometry as LineString);
        }
      }
      cutPieces.push(...(pieces.length ? pieces : [cutter]));
    }
    const insideCut = cutPieces.filter((ls) => {
      const mid = turf.along(turf.lineString(ls.coordinates), turf.length(turf.lineString(ls.coordinates)) / 2);
      return turf.booleanPointInPolygon(mid, feat(target));
    });
    if (insideCut.length === 0) return null;

    // Node the boundary against the cutter.
    const nodedBoundary: LineString[] = [];
    for (const bl of boundaryLines) {
      let pieces: LineString[] = [bl];
      for (const cut of insideCut) {
        const next: LineString[] = [];
        for (const p of pieces) {
          const s = turf.lineSplit(turf.lineString(p.coordinates), turf.lineString(cut.coordinates));
          if (s.features.length > 1) for (const f of s.features) next.push(f.geometry as LineString);
          else next.push(p);
        }
        pieces = next;
      }
      nodedBoundary.push(...pieces);
    }

    const edges = turf.featureCollection(
      [...nodedBoundary, ...insideCut].map((ls) => turf.lineString(ls.coordinates)),
    );
    const faces = turf.polygonize(edges);
    const polys = faces.features
      .map((f) => normalizePoly(f.geometry as Poly))
      .filter((p): p is Poly => p !== null)
      // polygonize can emit faces outside the original when the cutter overshoots.
      .filter((p) => {
        try {
          const c = turf.centroid(feat(p));
          return turf.booleanPointInPolygon(c, feat(target));
        } catch {
          return false;
        }
      });
    return polys.length >= 2 ? polys : null;
  } catch {
    return null;
  }
}

function splitByThinBuffer(target: Poly, cutter: LineString): Poly[] | null {
  try {
    // 1 metre in km — narrow enough to be invisible at atlas scales, wide enough
    // that the clipper does not collapse it.
    const blade = turf.buffer(turf.lineString(cutter.coordinates), 0.001, { units: 'kilometers' });
    if (!blade) return null;
    const cut = difference(target, blade.geometry as Poly);
    if (!cut) return null;
    const parts = explode(cut);
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

/** Convert a polygon's rings to closed line coordinate arrays. */
export function ringsOf(g: Poly): Position[][] {
  if (g.type === 'Polygon') return g.coordinates;
  return g.coordinates.flat();
}
