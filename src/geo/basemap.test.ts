/** Reference-geography helpers (spec §3). */

import { describe, expect, it } from 'vitest';
import type { Feature } from 'geojson';
import {
  BASEMAP_SIZES,
  BUILTIN_BASEMAPS,
  basemapFeatureName,
  clipToValidArea,
  isLineFeature,
  isPolygonFeature,
  linesOf,
  polygonsOf,
  stateNameToFips,
  type BasemapFeature,
} from './basemap';

const poly = (name?: string): Feature => ({
  type: 'Feature',
  properties: name ? { name } : {},
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
});

const line = (name?: string): Feature => ({
  type: 'Feature',
  properties: name ? { name } : {},
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
});

const point: Feature = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'Point', coordinates: [0, 0] },
};

describe('feature kind detection', () => {
  it('tells lakes (areas) from rivers (lines)', () => {
    expect(isPolygonFeature(poly())).toBe(true);
    expect(isLineFeature(poly())).toBe(false);
    expect(isLineFeature(line())).toBe(true);
    expect(isPolygonFeature(line())).toBe(false);
    expect(isPolygonFeature(point)).toBe(false);
    expect(isLineFeature(point)).toBe(false);
  });

  it('splits a mixed dataset into areas and lines', () => {
    const mixed = [poly('Lake Erie'), line('Hudson'), poly('Lake Ontario')] as BasemapFeature[];
    expect(polygonsOf(mixed)).toHaveLength(2);
    expect(linesOf(mixed)).toHaveLength(1);
    expect(basemapFeatureName(linesOf(mixed)[0])).toBe('Hudson');
  });
});

describe('bundled datasets', () => {
  it('ships lakes and rivers at every scale (§3)', () => {
    for (const role of ['land', 'countries', 'lakes', 'rivers'] as const) {
      const scales = BUILTIN_BASEMAPS.filter((b) => b.role === role);
      expect(scales.length, `${role} has no datasets`).toBe(3);
      for (const s of scales) {
        expect(s.url).toMatch(/^data\//);
        expect(s.objectName, `${s.id} has no TopoJSON object name`).toBeTruthy();
      }
    }
  });

  it('quotes a download size for every bundled dataset', () => {
    for (const b of BUILTIN_BASEMAPS) {
      expect(BASEMAP_SIZES[b.id], `${b.id} has no size`).toBeTruthy();
    }
  });

  it('has unique ids', () => {
    const ids = BUILTIN_BASEMAPS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('name lookup', () => {
  it('reads a name from the usual property spellings', () => {
    expect(basemapFeatureName(poly('Lake Chad') as BasemapFeature)).toBe('Lake Chad');
    expect(basemapFeatureName(poly() as BasemapFeature)).toBe('Unnamed');
  });

  it('maps state names to FIPS codes', () => {
    expect(stateNameToFips('Pennsylvania')).toBe('42');
    expect(stateNameToFips('  new york ')).toBe('36');
    expect(stateNameToFips('Atlantis')).toBeNull();
  });
});

describe('clipToValidArea — the reason the ocean stays blue (§4, §17)', () => {
  // Natural Earth ships all land as ONE feature holding a MultiPolygon of
  // thousands of landmasses. Antarctica is one part of it, and in a conic
  // projection centred on 39°N it projects to a ring 66,000 km across that fills
  // the whole canvas with land colour. Filtering by the *feature's* bounding box
  // cannot catch it — the feature spans the world — so this clips per part.
  const NORTHERN_CONIC: [number, number, number, number] = [-180, -60, 180, 89.9];

  const box = (w: number, s: number, e: number, n: number): number[][][] => [
    [[w, s], [e, s], [e, n], [w, n], [w, s]],
  ];

  const world: BasemapFeature = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        box(-180, -85, 180, -63), // Antarctica
        box(-125, 25, -66, 49), // continental US
        box(-10, 35, 30, 60), // Europe
      ],
    },
  } as BasemapFeature;

  it('drops the Antarctic part while keeping the rest', () => {
    const clipped = clipToValidArea(world, NORTHERN_CONIC);
    expect(clipped).not.toBeNull();
    const parts = (clipped!.geometry as { coordinates: unknown[] }).coordinates;
    expect(parts).toHaveLength(2);
    // The surviving parts are the two northern ones, in order.
    expect((parts[0] as number[][][])[0][0][1]).toBe(25);
    expect((parts[1] as number[][][])[0][0][1]).toBe(35);
  });

  it('returns the very same object when nothing needs removing', () => {
    // Identity matters: it lets the renderer skip a rebuild for untouched data.
    const clipped = clipToValidArea(world, [-180, -90, 180, 90]);
    expect(clipped).toBe(world);
  });

  it('returns null when every part is outside the domain', () => {
    const antarcticOnly: BasemapFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: [box(-180, -85, 180, -63)] },
    } as BasemapFeature;
    expect(clipToValidArea(antarcticOnly, NORTHERN_CONIC)).toBeNull();
  });

  it('keeps a part that merely straddles the boundary', () => {
    // South America reaches -55, below the -60 cut only in part; it must survive
    // whole rather than being trimmed to a fragment.
    const straddling: BasemapFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: [box(-80, -55, -35, 12)] },
    } as BasemapFeature;
    expect(clipToValidArea(straddling, NORTHERN_CONIC)).toBe(straddling);
  });

  it('handles single-part geometry and lines', () => {
    const polar: BasemapFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: box(-180, -85, 180, -70) },
    } as BasemapFeature;
    expect(clipToValidArea(polar, NORTHERN_CONIC)).toBeNull();

    const river: BasemapFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[-70, 40], [-71, 42]] },
    } as BasemapFeature;
    expect(clipToValidArea(river, NORTHERN_CONIC)).toBe(river);
  });
});
