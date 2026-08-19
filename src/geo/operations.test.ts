/** Critical geographic operations (spec §64). */

import { describe, expect, it } from 'vitest';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import {
  areaKm2,
  difference,
  dissolve,
  dropSlivers,
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

  it('drops a ring that goes out along a line and comes back', () => {
    // What a boolean leaves where two edges cancel: four points, closed, and
    // enclosing nothing. Invisible as a region and loud as a line — the
    // renderer strokes a realm's rings, so this draws as a border dash across
    // open country, which is how it was found.
    const spur: Polygon = {
      type: 'Polygon',
      coordinates: [[[-97, 37], [-94, 37], [-97, 37], [-97, 37]]],
    };
    expect(normalizePoly(spur)).toBeNull();
  });

  it('drops such a spur without touching the realm it is attached to', () => {
    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [rect(0, 0, 1, 1).coordinates, [[[5, 5], [8, 5], [5, 5], [5, 5]]]],
    };
    const out = normalizePoly(mp);
    expect(out?.type).toBe('Polygon');
    expect((out as Polygon).coordinates).toEqual(rect(0, 0, 1, 1).coordinates);
  });

  it('drops a zero-area hole and keeps a real one', () => {
    const holed: Polygon = {
      type: 'Polygon',
      coordinates: [
        rect(0, 0, 10, 10).coordinates[0],
        rect(2, 2, 4, 4).coordinates[0],
        [[6, 6], [9, 6], [6, 6], [6, 6]],
      ],
    };
    expect(normalizePoly(holed)?.coordinates).toHaveLength(2);
  });

  it('drops a ribbon part but keeps the realm it hangs off', () => {
    // What a subtraction leaves where two edges nearly coincide: a part 10 km
    // long and 10 m across. It survives the zero-area rule and draws as a line.
    const ribbon: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rect(0, 0, 1, 1).coordinates,
        rect(-123.4, 47.3, -123.3, 47.30009).coordinates,
      ],
    };
    const out = normalizePoly(ribbon);
    expect(out?.type).toBe('Polygon');
    expect((out as Polygon).coordinates).toEqual(rect(0, 0, 1, 1).coordinates);
  });

  it('keeps a narrow part that is most of what the realm is', () => {
    // The rule is about crumbs hanging off a realm, not about realms that
    // happen to be narrow: a spit with a small island beside it keeps both.
    const spit: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rect(-70, 41, -69.5, 41.0004).coordinates,
        rect(-69.4, 41.1, -69.399, 41.101).coordinates,
      ],
    };
    expect(normalizePoly(spit)?.type).toBe('MultiPolygon');
  });

  it('keeps a real island, however small a map draws it', () => {
    // The floor is a square metre; the smallest thing anyone would draw is
    // orders of magnitude bigger, and losing an islet to a cleanup is worse
    // than the dash it was meant to stop.
    const islet = rect(-70, 41, -70 + 0.0005, 41 + 0.0005); // ~55 m a side
    expect(normalizePoly(islet)).not.toBeNull();
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

  it('merges neighbours whose shared frontier disagrees in the last decimal', () => {
    // What "could not merge those shapes" was: two realms traced along the same
    // line, differing by a rounding error the clipper cannot resolve. Measured
    // on the shipped map, eighteen pairs of neighbours failed this way — every
    // one of them a valid polygon. The merge has to survive it.
    const west: Polygon = {
      type: 'Polygon',
      coordinates: [[
        [0, 0], [1.0000000001, 0.0000000003], [0.9999999998, 0.5],
        [1.0000000002, 1], [0, 1], [0, 0],
      ]],
    };
    const east: Polygon = {
      type: 'Polygon',
      coordinates: [[
        [1, 0], [2, 0], [2, 1], [0.9999999999, 1.0000000002],
        [1.0000000003, 0.5], [1, 0],
      ]],
    };
    const merged = union([west, east]);
    expect(merged).not.toBeNull();
    // Nothing lost and nothing counted twice: the pair covers 0..2 by 0..1.
    expect(areaKm2(merged!)).toBeGreaterThan(areaKm2(rect(0, 0, 2, 1)) * 0.999);
    expect(areaKm2(merged!)).toBeLessThan(areaKm2(rect(0, 0, 2, 1)) * 1.001);
  });

  it('never loses a shape it cannot cleanly merge', () => {
    // The promise the paint bucket and the merge command rest on: whatever the
    // clipper says, the ground the user selected comes back.
    const parts = [rect(0, 0, 1, 1), rect(1, 0, 2, 1), rect(5, 5, 6, 6)];
    const merged = union(parts);
    expect(merged).not.toBeNull();
    const total = parts.reduce((n, p) => n + areaKm2(p), 0);
    expect(areaKm2(merged!)).toBeCloseTo(total, 3);
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

  it('drops a thread but keeps a small island of the same area', () => {
    // The distinction area alone cannot make. Both of these are about a tenth
    // of a square kilometre: one is a scrap of land, the other is a metre-wide
    // hair four degrees long, which is what a boolean leaves when two
    // boundaries almost coincide and what the map draws as a black line lying
    // across a country.
    const islet = rect(0, 0, 0.00631, 0.00631);
    const thread = rect(5, 5, 9, 5.00001);
    expect(areaKm2(islet)).toBeCloseTo(areaKm2(thread), 1);

    const both: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [islet.coordinates, thread.coordinates],
    };
    const kept = dropSlivers(both, 0.03) as Polygon;
    expect(kept.type).toBe('Polygon');
    expect(kept.coordinates[0][0][0]).toBeLessThan(1);
  });

  it('keeps a realm drawn all the way round an enclave', () => {
    // Holes have to stay out of the measurement. A ring-shaped country has a
    // perimeter twice the length its outline suggests, and counting the inner
    // ring would call the whole realm a thread.
    const ring: Polygon = {
      type: 'Polygon',
      coordinates: [rect(0, 0, 4, 4).coordinates[0], rect(1, 1, 3, 3).coordinates[0]],
    };
    expect(dropSlivers(ring, 0.03)).not.toBeNull();
  });

  it('returns null when the whole shape is thread', () => {
    expect(dropSlivers(rect(0, 0, 4, 0.00001), 0.03)).toBeNull();
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

