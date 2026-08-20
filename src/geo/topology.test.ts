/** Shared-border and topology behaviour (spec §6, §64). */

import { describe, expect, it } from 'vitest';
import type { Polygon, Position } from 'geojson';
import {
  applyVertexMoves,
  buildSnapIndex,
  deriveBorders,
  diffVertexMoves,
  mergeBorderSegments,
  propagateVertexEdit,
  repairTopology,
  snapPosition,
  validateTopology,
} from './topology';
import { areaKm2 } from './operations';
import type { Territory } from '@/model/types';

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

function territory(id: string, geometry: Polygon, over: Partial<Territory> = {}): Territory {
  return {
    id,
    layerId: 'layer',
    name: id,
    shortName: '',
    politicalType: 'kingdom',
    relationship: 'sovereign',
    parentId: null,
    liegeId: null,
    capitalId: null,
    notes: '',
    locked: false,
    hidden: false,
    timeline: { start: null, end: null },
    geometry,
    styleClassId: 'style',
    styleOverrides: {},
    inheritParentColor: false,
    borderKind: 'international',
    labelId: null,
    ...over,
  };
}

describe('diffVertexMoves', () => {
  it('finds a single moved vertex', () => {
    const before = rect(0, 0, 10, 10);
    const after: Polygon = JSON.parse(JSON.stringify(before));
    after.coordinates[0][1] = [12, 0]; // move the second corner

    const moves = diffVertexMoves(before, after);
    expect(moves).not.toBeNull();
    expect(moves).toHaveLength(1);
    expect(moves![0].from).toEqual([10, 0]);
    expect(moves![0].to).toEqual([12, 0]);
  });

  it('reports no moves for identical geometry', () => {
    expect(diffVertexMoves(rect(0, 0, 1, 1), rect(0, 0, 1, 1))).toEqual([]);
  });

  it('reports no move when a vertex was only inserted', () => {
    const before = rect(0, 0, 10, 10);
    const after: Polygon = JSON.parse(JSON.stringify(before));
    after.coordinates[0].splice(1, 0, [5, 0]);
    // Nothing left its place: the outline is where it was, with one more point
    // on it, and a neighbour has nothing to follow.
    expect(diffVertexMoves(before, after)).toEqual([]);
  });

  /**
   * The vertex tool writes its result through a GeoJSON writer set to the
   * right-hand rule, and the map's rings are wound the other way, so a ring
   * that was not touched at all comes back reversed. Read positionally that
   * looks like every vertex jumping to the mirror of its place — which is
   * exactly what used to be propagated into the neighbours.
   */
  it('sees no movement in a ring that came back reversed', () => {
    const before = rect(0, 0, 10, 10);
    const after: Polygon = { type: 'Polygon', coordinates: [[...before.coordinates[0]].reverse()] };
    expect(diffVertexMoves(before, after)).toEqual([]);
  });

  it('finds the moved vertex even when the ring also came back reversed', () => {
    const before = rect(0, 0, 10, 10);
    const ring = [...before.coordinates[0]].reverse().map((v) => [...v]);
    const corner = ring.findIndex((v) => v[0] === 10 && v[1] === 0);
    ring[corner] = [12, 0];
    const moves = diffVertexMoves(before, { type: 'Polygon', coordinates: [ring] });
    expect(moves).toHaveLength(1);
    expect(moves![0].from).toEqual([10, 0]);
    expect(moves![0].to).toEqual([12, 0]);
  });

  it('reports no move when a vertex was deleted', () => {
    const before = rect(0, 0, 10, 10);
    const after: Polygon = JSON.parse(JSON.stringify(before));
    after.coordinates[0].splice(1, 1);
    // A neighbour cannot follow a deletion by moving one of its own vertices.
    expect(diffVertexMoves(before, after)).toEqual([]);
  });

  it('reads a whole polygon dragged bodily as one translation', () => {
    const dense: Polygon = {
      type: 'Polygon',
      coordinates: [Array.from({ length: 200 }, (_, i) => [i / 20, Math.sin(i) + 20] as Position)],
    };
    dense.coordinates[0].push(dense.coordinates[0][0]);
    const shifted: Polygon = {
      type: 'Polygon',
      coordinates: [dense.coordinates[0].map(([x, y]) => [x + 3, y + 1] as Position)],
    };
    const moves = diffVertexMoves(dense, shifted);
    expect(moves).not.toBeNull();
    expect(moves!.length).toBeGreaterThan(100);
    expect(moves!.every((m) => Math.abs(m.to[0] - m.from[0] - 3) < 1e-9)).toBe(true);
  });
});

describe('applyVertexMoves', () => {
  it('moves only vertices sitting at a `from` position', () => {
    const g = rect(10, 0, 20, 10);
    const moved = applyVertexMoves(g, [{ from: [10, 0], to: [11, 1] }]);
    expect(moved).not.toBeNull();
    const ring = (moved as Polygon).coordinates[0];
    // First and last vertex are the same corner in a closed ring — both move.
    expect(ring[0]).toEqual([11, 1]);
    expect(ring[ring.length - 1]).toEqual([11, 1]);
    expect(ring[1]).toEqual([20, 0]);
  });

  it('returns null when nothing matched', () => {
    expect(applyVertexMoves(rect(0, 0, 1, 1), [{ from: [99, 99], to: [98, 98] }])).toBeNull();
  });
});

describe('propagateVertexEdit — the shared border requirement (§6)', () => {
  it('moves the neighbour that shares the edited vertices', () => {
    // Two kingdoms meeting along x = 10.
    const a = territory('A', rect(0, 0, 10, 10));
    const b = territory('B', rect(10, 0, 20, 10));

    // Drag the shared corner (10,10) east to (12,10).
    const after: Polygon = JSON.parse(JSON.stringify(a.geometry));
    const ring = after.coordinates[0];
    for (const v of ring) if (v[0] === 10 && v[1] === 10) [v[0], v[1]] = [12, 10];

    const updates = propagateVertexEdit([a, b], 'A', a.geometry, after);

    expect(updates.has('B')).toBe(true);
    const bRing = (updates.get('B') as Polygon).coordinates[0];
    // B's copy of the corner moved with it — no gap opened.
    expect(bRing.some((v) => v[0] === 12 && v[1] === 10)).toBe(true);
    expect(bRing.some((v) => v[0] === 10 && v[1] === 10)).toBe(false);
  });

  it('leaves territories that do not share the vertex alone', () => {
    const a = territory('A', rect(0, 0, 10, 10));
    const far = territory('Far', rect(50, 50, 60, 60));

    const after: Polygon = JSON.parse(JSON.stringify(a.geometry));
    after.coordinates[0][1] = [11, 0];

    const updates = propagateVertexEdit([a, far], 'A', a.geometry, after);
    expect(updates.has('Far')).toBe(false);
  });

  it('never modifies a locked neighbour', () => {
    const a = territory('A', rect(0, 0, 10, 10));
    const b = territory('B', rect(10, 0, 20, 10), { locked: true });

    const after: Polygon = JSON.parse(JSON.stringify(a.geometry));
    for (const v of after.coordinates[0]) if (v[0] === 10 && v[1] === 10) v[0] = 12;

    expect(propagateVertexEdit([a, b], 'A', a.geometry, after).has('B')).toBe(false);
  });
});

describe('snapping (§35)', () => {
  const index = buildSnapIndex([territory('A', rect(0, 0, 10, 10))]);

  it('latches onto a nearby vertex', () => {
    const hit = snapPosition(index, [10.02, 0.02], 0.1);
    expect(hit?.kind).toBe('vertex');
    expect(hit?.position).toEqual([10, 0]);
  });

  it('falls back to the nearest point on an edge', () => {
    const hit = snapPosition(index, [5, 0.03], 0.1);
    expect(hit?.kind).toBe('edge');
    expect(hit?.position[1]).toBeCloseTo(0, 6);
  });

  it('returns nothing beyond the radius', () => {
    expect(snapPosition(index, [50, 50], 0.1)).toBeNull();
  });

  it('honours the exclusion id so a shape does not snap to itself', () => {
    expect(snapPosition(index, [10.01, 0.01], 0.1, 'A')).toBeNull();
  });
});

describe('validateTopology', () => {
  it('finds an overlap between two territories', () => {
    const issues = validateTopology([
      territory('A', rect(0, 0, 10, 10)),
      territory('B', rect(9, 0, 20, 10)),
    ]);
    const overlaps = issues.filter((i) => i.kind === 'overlap' || i.kind === 'sliver');
    expect(overlaps.length).toBe(1);
    expect(overlaps[0].featureIds.sort()).toEqual(['A', 'B']);
  });

  it('finds a gap enclosed by neighbours', () => {
    // A ring of four rectangles leaving a hole in the middle.
    const issues = validateTopology([
      territory('N', rect(0, 2, 3, 3)),
      territory('S', rect(0, 0, 3, 1)),
      territory('W', rect(0, 0, 1, 3)),
      territory('E', rect(2, 0, 3, 3)),
    ]);
    expect(issues.some((i) => i.kind === 'gap')).toBe(true);
  });

  it('does not report a parent covering its own subdivisions (§7)', () => {
    // A Kingdom whose footprint is the union of its two Duchies. That is
    // containment, not an overlap, and must never be flagged.
    const kingdom = territory('K', rect(0, 0, 20, 10));
    const west = territory('W', rect(0, 0, 10, 10), { parentId: 'K' });
    const east = territory('E', rect(10, 0, 20, 10), { parentId: 'K' });

    const issues = validateTopology([kingdom, west, east]);
    expect(issues.filter((i) => i.kind === 'overlap' || i.kind === 'sliver')).toHaveLength(0);
  });

  it('still reports an overlap between two siblings under one parent', () => {
    const kingdom = territory('K', rect(0, 0, 20, 10));
    const west = territory('W', rect(0, 0, 11, 10), { parentId: 'K' });
    const east = territory('E', rect(10, 0, 20, 10), { parentId: 'K' });

    const issues = validateTopology([kingdom, west, east]);
    const overlaps = issues.filter((i) => i.kind === 'overlap' || i.kind === 'sliver');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].featureIds.sort()).toEqual(['E', 'W']);
  });

  it('reports nothing for a clean mesh', () => {
    const issues = validateTopology([
      territory('A', rect(0, 0, 10, 10)),
      territory('B', rect(10, 0, 20, 10)),
    ]);
    expect(issues).toHaveLength(0);
  });
});

describe('repairTopology (§6 "Repair Territory Topology")', () => {
  it('welds vertices that are near-coincident but not equal', () => {
    // B's left edge is 0.000002° off from A's right edge — an invisible sliver.
    const a = territory('A', rect(0, 0, 10, 10));
    const b = territory('B', {
      type: 'Polygon',
      coordinates: [
        [
          [10.000002, 0.000002],
          [20, 0],
          [20, 10],
          [10.000002, 10.000002],
          [10.000002, 0.000002],
        ],
      ],
    });

    const result = repairTopology([a, b], { tolerance: 1e-4, fillGaps: false, fixOverlaps: false });
    expect(result.weldedVertices).toBeGreaterThan(0);
    expect(result.changes.size).toBeGreaterThan(0);
  });

  it('removes a small overlap from the smaller territory', () => {
    const big = territory('Big', rect(0, 0, 10, 10));
    // A narrow strip overlapping Big by a sliver.
    const small = territory('Small', rect(9.99, 0, 12, 10));

    const before = areaKm2(small.geometry);
    const result = repairTopology([big, small], {
      weldVertices: false,
      fillGaps: false,
      maxSliverKm2: 1e9,
    });

    expect(result.overlapsFixed).toBe(1);
    const trimmed = result.changes.get('Small');
    expect(trimmed).toBeDefined();
    expect(areaKm2(trimmed!)).toBeLessThan(before);
  });

  it('never modifies a locked territory', () => {
    const a = territory('A', rect(0, 0, 10, 10));
    const b = territory('B', rect(9, 0, 20, 10));
    const result = repairTopology([a, b], {
      weldVertices: false,
      fillGaps: false,
      maxSliverKm2: 1e9,
      lockedIds: new Set(['A', 'B']),
    });
    expect(result.changes.size).toBe(0);
  });

  it('leaves a parent/child pair alone rather than trimming the child', () => {
    const kingdom = territory('K', rect(0, 0, 20, 10));
    const duchy = territory('D', rect(0, 0, 10, 10), { parentId: 'K' });
    const result = repairTopology([kingdom, duchy], {
      weldVertices: false,
      fillGaps: false,
      maxSliverKm2: 1e9,
    });
    expect(result.overlapsFixed).toBe(0);
    expect(result.changes.size).toBe(0);
  });

  it('explains what it deliberately skipped instead of claiming all is well', () => {
    // Two unrelated territories overlapping far more than the sliver limit.
    const a = territory('A', rect(0, 0, 10, 10));
    const b = territory('B', rect(5, 0, 15, 10));
    const result = repairTopology([a, b], { maxSliverKm2: 0.001 });
    expect(result.changes.size).toBe(0);
    expect(result.log.join(' ')).toMatch(/larger than the .* sliver limit/);
  });

  it('reports cleanly when there is nothing to do', () => {
    const result = repairTopology([territory('A', rect(0, 0, 10, 10))]);
    expect(result.changes.size).toBe(0);
    expect(result.log[0]).toContain('No topology problems');
  });
});

describe('deriveBorders (§8, §57)', () => {
  it('identifies the segment two neighbours share', () => {
    const a = territory('A', rect(0, 0, 10, 10));
    const b = territory('B', rect(10, 0, 20, 10));
    const borders = deriveBorders([a, b]);

    const shared = borders.filter((x) => x.right !== null);
    expect(shared.length).toBeGreaterThan(0);
    for (const s of shared) {
      // The shared edge runs along x = 10.
      expect(s.geometry.coordinates.every((c) => Math.abs(c[0] - 10) < 1e-9)).toBe(true);
      expect([s.left, s.right].sort()).toEqual(['A', 'B']);
    }
  });

  it('marks outer frontier segments as having no neighbour', () => {
    const borders = deriveBorders([territory('A', rect(0, 0, 10, 10))]);
    expect(borders.length).toBe(4);
    expect(borders.every((b) => b.right === null)).toBe(true);
  });

  it('merges consecutive segments between the same pair into runs', () => {
    // Split the shared edge into two segments so there is something to merge.
    const a = territory('A', {
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 5], [10, 10], [0, 10], [0, 0]]],
    });
    const b = territory('B', {
      type: 'Polygon',
      coordinates: [[[10, 0], [20, 0], [20, 10], [10, 10], [10, 5], [10, 0]]],
    });
    const merged = mergeBorderSegments(deriveBorders([a, b]));
    const shared = merged.filter((x) => x.right !== null);
    expect(shared).toHaveLength(1);
    expect(shared[0].geometry.coordinates.length).toBe(3);
  });
});
