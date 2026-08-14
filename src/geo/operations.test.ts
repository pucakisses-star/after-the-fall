/** Critical geographic operations (spec §64). */

import { describe, expect, it } from 'vitest';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import {
  areaKm2,
  difference,
  dissolve,
  explode,
  interiorPoint,
  intersection,
  normalizePoly,
  removeTinyParts,
  simplify,
  splitPolygon,
  union,
} from './operations';

/** Axis-aligned rectangle helper, in degrees. */
function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  };
}

describe('normalizePoly', () => {
  it('collapses a single-part MultiPolygon to a Polygon', () => {
    const mp: MultiPolygon = { type: 'MultiPolygon', coordinates: [rect(0, 0, 1, 1).coordinates] };
    expect(normalizePoly(mp)?.type).toBe('Polygon');
  });

  it('keeps genuinely multi-part geometry as a MultiPolygon', () => {
    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [rect(0, 0, 1, 1).coordinates, rect(5, 5, 6, 6).coordinates],
    };
    expect(normalizePoly(mp)?.type).toBe('MultiPolygon');
  });

  it('rejects degenerate rings', () => {
    expect(normalizePoly({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] })).toBeNull();
  });
});

describe('union / merge', () => {
  it('merges two touching rectangles into one polygon', () => {
    const merged = union([rect(0, 0, 1, 1), rect(1, 0, 2, 1)]);
    expect(merged).not.toBeNull();
    expect(merged!.type).toBe('Polygon');
    // The merged area equals the sum, so nothing was lost or double-counted.
    expect(areaKm2(merged!)).toBeCloseTo(areaKm2(rect(0, 0, 2, 1)), 3);
  });

  it('keeps disjoint shapes as separate parts', () => {
    const merged = union([rect(0, 0, 1, 1), rect(10, 10, 11, 11)]);
    expect(merged!.type).toBe('MultiPolygon');
    expect(explode(merged!)).toHaveLength(2);
  });

  it('returns the input unchanged for a single polygon', () => {
    const only = rect(0, 0, 1, 1);
    expect(union([only])).toEqual(only);
  });

  it('returns null for an empty list', () => {
    expect(union([])).toBeNull();
  });
});

describe('difference and intersection', () => {
  it('punches a hole, producing an interior ring', () => {
    const result = difference(rect(0, 0, 10, 10), rect(4, 4, 6, 6));
    expect(result).not.toBeNull();
    expect(result!.type).toBe('Polygon');
    // Outer ring plus one hole.
    expect((result as Polygon).coordinates).toHaveLength(2);
  });

  it('reports the shared region of two overlapping rectangles', () => {
    const shared = intersection(rect(0, 0, 2, 2), rect(1, 1, 3, 3));
    expect(shared).not.toBeNull();
    expect(areaKm2(shared!)).toBeCloseTo(areaKm2(rect(1, 1, 2, 2)), 3);
  });

  it('returns null when shapes do not overlap', () => {
    expect(intersection(rect(0, 0, 1, 1), rect(5, 5, 6, 6))).toBeNull();
  });

  it('returns null when the subtrahend swallows the target', () => {
    expect(difference(rect(1, 1, 2, 2), rect(0, 0, 10, 10))).toBeNull();
  });
});

describe('dissolve (Create Territory from Selection)', () => {
  it('erases internal borders between a strip of adjacent divisions', () => {
    const strip = [rect(0, 0, 1, 1), rect(1, 0, 2, 1), rect(2, 0, 3, 1)];
    const merged = dissolve(strip);
    expect(merged!.type).toBe('Polygon');
    // A single ring means the internal boundaries are gone.
    expect((merged as Polygon).coordinates).toHaveLength(1);
    expect(areaKm2(merged!)).toBeCloseTo(areaKm2(rect(0, 0, 3, 1)), 3);
  });
});

describe('splitPolygon', () => {
  it('cuts a rectangle in two with a vertical line', () => {
    const cutter: LineString = { type: 'LineString', coordinates: [[5, -1], [5, 11]] };
    const pieces = splitPolygon(rect(0, 0, 10, 10), cutter);
    expect(pieces).not.toBeNull();
    expect(pieces!.length).toBeGreaterThanOrEqual(2);
    // The pieces together account for the original area.
    const total = pieces!.reduce((sum, p) => sum + areaKm2(p), 0);
    expect(total).toBeCloseTo(areaKm2(rect(0, 0, 10, 10)), 0);
  });

  it('cuts along a bent line', () => {
    const cutter: LineString = {
      type: 'LineString',
      coordinates: [[-1, 5], [4, 7], [7, 3], [11, 5]],
    };
    const pieces = splitPolygon(rect(0, 0, 10, 10), cutter);
    expect(pieces).not.toBeNull();
    expect(pieces!.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a line that does not cross the polygon', () => {
    const cutter: LineString = { type: 'LineString', coordinates: [[20, 20], [30, 30]] };
    expect(splitPolygon(rect(0, 0, 10, 10), cutter)).toBeNull();
  });
});

describe('cleanup helpers', () => {
  it('drops parts below the area threshold', () => {
    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [rect(0, 0, 1, 1).coordinates, rect(5, 5, 5.001, 5.001).coordinates],
    };
    const cleaned = removeTinyParts(mp, 100);
    expect(cleaned!.type).toBe('Polygon');
  });

  it('returns null when every part is below the threshold', () => {
    expect(removeTinyParts(rect(0, 0, 0.001, 0.001), 1000)).toBeNull();
  });

  it('reduces the vertex count when simplifying', () => {
    // A many-vertex circle simplifies to far fewer points.
    const coords: number[][] = [];
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      coords.push([Math.cos(a) * 5, Math.sin(a) * 5]);
    }
    coords.push(coords[0]);
    const circle: Polygon = { type: 'Polygon', coordinates: [coords] };
    const simplified = simplify(circle, 0.5) as Polygon;
    expect(simplified.coordinates[0].length).toBeLessThan(coords.length);
    expect(simplified.coordinates[0].length).toBeGreaterThan(3);
  });
});

describe('interiorPoint', () => {
  it('lands inside a convex shape', () => {
    const [x, y] = interiorPoint(rect(0, 0, 10, 10));
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(10);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(10);
  });

  it('lands inside a C-shape whose centroid falls outside it', () => {
    // A horseshoe: the centroid sits in the notch, so a naive centroid fails.
    const c: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10], [0, 0],
        ],
      ],
    };
    const [x, y] = interiorPoint(c);
    // Anywhere inside is acceptable; the notch spans x>3, 3<y<7.
    const inNotch = x > 3 && y > 3 && y < 7;
    expect(inNotch).toBe(false);
  });
});
