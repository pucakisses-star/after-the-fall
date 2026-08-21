/**
 * Sweeping up the scraps that render as stray lines (spec §6).
 *
 * The thing under test is the *measure*. Every audit of this map that filtered
 * slivers on area declared it clean while the dashes were still on screen, so
 * the cases below are built to fail an area test and pass a width one: a real
 * island smaller than the ribbon it sits next to, and a ribbon whose area is
 * respectable because it is long.
 */

import { describe, expect, it } from 'vitest';
import { cleanHairlines, findHairlines, DEFAULT_HAIRLINE_KM } from './hairlines';
import { areaKm2, ringWidthKm } from './operations';
import type { Territory } from '@/model/types';
import type { Polygon, MultiPolygon, Position } from 'geojson';

/** A rectangle in degrees, given as lon/lat corners. */
const rect = (x0: number, y0: number, x1: number, y1: number): Position[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

const terr = (geometry: Polygon | MultiPolygon, extra: Partial<Territory> = {}): Territory =>
  ({
    id: extra.id ?? 't1',
    name: extra.name ?? 'Test',
    geometry,
    parentId: null,
    locked: false,
    ...extra,
  }) as Territory;

// ~111 km to the degree, so 0.005° is about 550 m — under the 750 m limit —
// and 0.02° is about 2.2 km, comfortably over it.
const THIN = 0.005;
const FAT = 0.02;

describe('the width measure', () => {
  it('separates a long thin ribbon from a small round island by width, not area', () => {
    const ribbon: Polygon = { type: 'Polygon', coordinates: [rect(0, 0, 2, THIN)] };
    const island: Polygon = { type: 'Polygon', coordinates: [rect(0, 0, FAT, FAT)] };

    // The trap: the ribbon is the LARGER of the two by area.
    expect(areaKm2(ribbon)).toBeGreaterThan(areaKm2(island));
    // ...and yet only the ribbon is a hairline.
    expect(ringWidthKm(ribbon.coordinates[0])).toBeLessThan(DEFAULT_HAIRLINE_KM);
    expect(ringWidthKm(island.coordinates[0])).toBeGreaterThan(DEFAULT_HAIRLINE_KM);
  });
});

/** A realm sitting where a scrap would be born against it. */
const neighbourAt = (x0: number, y0: number, x1: number, y1: number): Territory =>
  terr({ type: 'Polygon', coordinates: [rect(x0, y0, x1, y1)] }, { id: 'nb', name: 'Neighbour' });

describe('threads', () => {
  it('drops a hairline part that touches a neighbour, and keeps the body', () => {
    const g: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [[rect(0, 0, 1, 1)], [rect(2, 0, 4, THIN)]],
    };
    const { changes, found } = cleanHairlines([terr(g), neighbourAt(2.5, -1, 3.5, 0.001)]);

    expect(found.map((f) => f.kind)).toEqual(['thread']);
    const next = changes.get('t1')!;
    expect(next.type).toBe('Polygon');
    expect(areaKm2(next)).toBeCloseTo(areaKm2({ type: 'Polygon', coordinates: [rect(0, 0, 1, 1)] }), 3);
  });

  it('leaves a map with nothing wrong with it completely alone', () => {
    const g: Polygon = { type: 'Polygon', coordinates: [rect(0, 0, 1, 1)] };
    const result = cleanHairlines([terr(g)]);
    expect(result.found).toEqual([]);
    expect(result.changes.size).toBe(0);
    expect(result.log).toEqual(['No stray lines found.']);
  });

  it('never deletes a realm outright, even when all of it is thread', () => {
    // A whole territory that reads as a thread is a judgement call for a person.
    const g: Polygon = { type: 'Polygon', coordinates: [rect(0, 0, 2, THIN)] };
    const result = cleanHairlines([terr(g, { name: 'Threadland' }), neighbourAt(0.5, -1, 1.5, 0.001)]);

    expect(result.changes.size).toBe(0);
    expect(result.log.join(' ')).toContain('Threadland');
  });
});

describe('telling an island from a scrap', () => {
  // Width alone would delete the Florida Keys. What separates them is company:
  // a scrap lies against the boundary that produced it, an island sits alone.
  const withThinPart: MultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [[rect(0, 0, 1, 1)], [rect(2, 0, 4, THIN)]],
  };

  it('spares a narrow part that touches nothing', () => {
    const result = cleanHairlines([terr(withThinPart)]);
    expect(result.found).toEqual([]);
    expect(result.changes.size).toBe(0);
    expect(result.log.join(' ')).toContain('narrow island');
  });

  it('removes the very same shape once a neighbour is against it', () => {
    const result = cleanHairlines([terr(withThinPart), neighbourAt(2.5, -1, 3.5, 0.001)]);
    expect(result.found.map((f) => f.kind)).toEqual(['thread']);
    expect(result.changes.size).toBe(1);
  });

  it('can be told to sweep the archipelago anyway', () => {
    const result = cleanHairlines([terr(withThinPart)], { keepIslands: false });
    expect(result.found.map((f) => f.kind)).toEqual(['thread']);
  });

  it('does not let a realm shelter its own scrap by touching itself', () => {
    // The thin part belongs to the same realm as the body it sits against, so
    // "touches another realm" must not count contact with its own other parts.
    const g: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [[rect(0, 0, 1, 1)], [rect(0.5, 1, 2.5, 1 + THIN)]],
    };
    expect(cleanHairlines([terr(g)]).found).toEqual([]);
  });
});

describe('slits', () => {
  it('fills a hairline hole and keeps a real enclave hole', () => {
    const g: Polygon = {
      type: 'Polygon',
      coordinates: [
        rect(0, 0, 1, 1),
        rect(0.1, 0.1, 0.9, 0.1 + THIN), // slit
        rect(0.2, 0.5, 0.2 + FAT, 0.5 + FAT), // genuine enclave
      ],
    };
    const { changes, found } = cleanHairlines([terr(g)]);

    expect(found.map((f) => f.kind)).toEqual(['slit']);
    const next = changes.get('t1') as Polygon;
    expect(next.coordinates).toHaveLength(2); // outer + the enclave
  });

  it('is what an area test misses — the slit here is larger than the enclave', () => {
    const slit: Polygon = { type: 'Polygon', coordinates: [rect(0.1, 0.1, 0.9, 0.1 + THIN)] };
    const enclave: Polygon = { type: 'Polygon', coordinates: [rect(0.2, 0.5, 0.2 + FAT, 0.5 + FAT)] };
    expect(areaKm2(slit)).toBeGreaterThan(areaKm2(enclave));
  });
});

describe('spikes', () => {
  it('files off a needle that doubles back on itself', () => {
    // A square with one vertex flung far out and straight back.
    const g: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 0.5],
          [3, 0.5000001], // the needle tip
          [1, 0.5000002],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    const { changes, found } = cleanHairlines([terr(g)]);

    expect(found.some((f) => f.kind === 'spike')).toBe(true);
    const next = changes.get('t1') as Polygon;
    // The tip is gone and the square's own corners all survive.
    expect(next.coordinates[0].some((p) => p[0] > 2)).toBe(false);
    for (const corner of [
      [0, 0],
      [1, 0],
      [0, 1],
    ]) {
      expect(next.coordinates[0].some((p) => p[0] === corner[0] && p[1] === corner[1])).toBe(true);
    }
  });

  it('leaves a genuine sharp cape standing', () => {
    // Same excursion, but wide enough at the base to be real ground: 0.02° is
    // over 2 km, so it is a cape, not a needle.
    const g: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 0.4],
          [3, 0.5],
          [1, 0.6],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    const { changes, found } = cleanHairlines([terr(g)]);
    expect(found).toEqual([]);
    expect(changes.size).toBe(0);
  });
});

describe('what the sweep refuses to touch', () => {
  it('reports a locked realm but does not change it', () => {
    const g: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [[rect(0, 0, 1, 1)], [rect(2, 0, 4, THIN)]],
    };
    const { changes, found } = cleanHairlines([
      terr(g, { locked: true }),
      neighbourAt(2.5, -1, 3.5, 0.001),
    ]);

    expect(found.map((f) => f.kind)).toEqual(['thread']);
    expect(changes.size).toBe(0);
  });

  it('honours the threshold it is given', () => {
    const g: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [[rect(0, 0, 1, 1)], [rect(2, 0, 4, FAT)]],
    };
    // 2.2 km wide: a hairline only if you say hairlines go up to 5 km.
    const scene = [terr(g), neighbourAt(2.5, -1, 3.5, 0.001)];
    expect(cleanHairlines(scene, { maxWidthKm: 0.75 }).found).toEqual([]);
    expect(cleanHairlines(scene, { maxWidthKm: 5 }).found).toHaveLength(1);
  });

  it('can be asked for one kind of scrap at a time', () => {
    const g: Polygon = {
      type: 'Polygon',
      coordinates: [rect(0, 0, 1, 1), rect(0.1, 0.1, 0.9, 0.1 + THIN)],
    };
    expect(cleanHairlines([terr(g)], { removeSlits: false }).changes.size).toBe(0);
    expect(cleanHairlines([terr(g)], { removeSlits: true }).changes.size).toBe(1);
  });
});

describe('previewing', () => {
  it('reports exactly what the sweep would remove', () => {
    const g: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [[rect(0, 0, 1, 1), rect(0.1, 0.1, 0.9, 0.1 + THIN)], [rect(2, 0, 4, THIN)]],
    };
    const scene = [terr(g), neighbourAt(2.5, -1, 3.5, 0.001)];
    const preview = findHairlines(scene);
    const swept = cleanHairlines(scene).found;
    expect(preview.map((h) => `${h.kind}`)).toEqual(swept.map((h) => `${h.kind}`));
    expect(preview.map((h) => h.kind).sort()).toEqual(['slit', 'thread']);
  });
});
