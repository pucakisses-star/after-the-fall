/** Reference-geography helpers (spec §3). */

import { describe, expect, it } from 'vitest';
import type { Feature } from 'geojson';
import {
  BASEMAP_SIZES,
  BUILTIN_BASEMAPS,
  basemapFeatureName,
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
