/**
 * Working extent: what reference geography is clipped to, and how a WGS84 box
 * becomes a view constraint (spec §4, §64).
 */

import { describe, expect, it } from 'vitest';
import { clipToValidArea } from './basemap';
import { projectExtent, renderExtentFor, validAreaFor } from './projections';
import type { BasemapFeature } from './basemap';

const AMERICAS: [number, number, number, number] = [-172, -58, -28, 74];

function point(lon: number, lat: number, name: string): BasemapFeature {
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

describe('renderExtentFor', () => {
  it('is the projection\'s own domain when the map is about everywhere', () => {
    expect(renderExtentFor('ATF:LCC', null)).toEqual(validAreaFor('ATF:LCC'));
    expect(renderExtentFor('ATF:LCC', undefined)).toEqual(validAreaFor('ATF:LCC'));
  });

  it('narrows to the working extent, never widens past the projection', () => {
    // The conic is only usable north of 60°S; asking for the whole globe must
    // not undo that, or Antarctica comes back as a 66,000 km ring.
    const whole: [number, number, number, number] = [-180, -90, 180, 90];
    expect(renderExtentFor('ATF:LCC', whole)).toEqual(validAreaFor('ATF:LCC'));

    const cropped = renderExtentFor('ATF:LCC', AMERICAS);
    expect(cropped[0]).toBe(-172);
    expect(cropped[2]).toBe(-28);
    expect(cropped[3]).toBeLessThanOrEqual(validAreaFor('ATF:LCC')[3]);
  });
});

describe('clipToValidArea with a working extent', () => {
  const window = renderExtentFor('ATF:LCC', AMERICAS);

  it('keeps cities inside the region and drops the rest', () => {
    expect(clipToValidArea(point(-74, 40.7, 'New York'), window)).not.toBeNull();
    expect(clipToValidArea(point(-58.4, -34.6, 'Buenos Aires'), window)).not.toBeNull();
    expect(clipToValidArea(point(2.35, 48.9, 'Paris'), window)).toBeNull();
    expect(clipToValidArea(point(139.7, 35.7, 'Tokyo'), window)).toBeNull();
  });

  it('keeps only the parts of a multi-part landmass that reach the region', () => {
    // Natural Earth ships all land as one feature holding thousands of parts, so
    // dropping whole features would drop everything or nothing.
    const land: BasemapFeature = {
      type: 'Feature',
      properties: { name: 'land' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[-80, 30], [-70, 30], [-70, 40], [-80, 40], [-80, 30]]], // Americas
          [[[100, 30], [110, 30], [110, 40], [100, 40], [100, 30]]], // Asia
        ],
      },
    };
    const clipped = clipToValidArea(land, window);
    expect(clipped).not.toBeNull();
    expect(clipped!.geometry.type).toBe('Polygon');
    expect((clipped!.geometry as { coordinates: number[][][] }).coordinates[0][0][0]).toBeLessThan(0);
  });

  it('cuts a polygon that straddles the edge rather than admitting all of it', () => {
    // Russia's bounding box reaches −180° because of Chukotka, so a
    // bounding-box test alone lets the whole of Eurasia into a map of the
    // Americas. Only the sliver west of the antimeridian belongs.
    const straddler: BasemapFeature = {
      type: 'Feature',
      properties: { name: 'Chukotka and everything behind it' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-179, 60], [-160, 60], [-160, 70], [-179, 70], [-179, 60]]],
      },
    };
    const clipped = clipToValidArea(straddler, window);
    expect(clipped).not.toBeNull();
    const box = (clipped!.geometry as { coordinates: number[][][] }).coordinates[0];
    // The window starts at −172, so nothing west of it may survive.
    expect(Math.min(...box.map((c) => c[0]))).toBeGreaterThanOrEqual(-172.001);
    expect(Math.max(...box.map((c) => c[0]))).toBeCloseTo(-160, 3);
  });

  it('does not admit a continent just because it wraps the antimeridian', () => {
    // Afro-Eurasia is one part of Natural Earth's 1:10m land file whose ring
    // steps from +180° to −180°, so its plain bounding box is the whole globe.
    // Measured against the real file: it has zero vertices in the Americas.
    const eurasia: BasemapFeature = {
      type: 'Feature',
      properties: { name: 'Afro-Eurasia' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[170, 60], [180, 60], [-180, 60], [-175, 20], [30, 10], [170, 60]]],
      },
    };
    // Every vertex is east of the window or west of its far edge; nothing of it
    // is in the Americas, so nothing of it should be drawn there.
    expect(clipToValidArea(eurasia, [-100, 10, -60, 50])).toBeNull();
  });

  it('keeps a wrapping part whole when it genuinely reaches the region', () => {
    const chukotka: BasemapFeature = {
      type: 'Feature',
      properties: { name: 'wraps and reaches' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[175, 64], [-179, 64], [-170, 66], [175, 66], [175, 64]]],
      },
    };
    const clipped = clipToValidArea(chukotka, window);
    expect(clipped).not.toBeNull();
    // Kept whole, not cut: a planar clip of a wrapping ring smears it into a
    // band across the window.
    expect(clipped).toBe(chukotka);
  });

  it('drops a part whose box overlaps the region but whose land does not', () => {
    const elbow: BasemapFeature = {
      type: 'Feature',
      properties: { name: 'far side' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-20, 40], [-5, 40], [-5, 50], [-20, 50], [-20, 40]]],
      },
    };
    expect(clipToValidArea(elbow, window)).toBeNull();
  });
});

describe('projectExtent', () => {
  it('passes lat/lon straight through for an equirectangular map', () => {
    expect(projectExtent('EPSG:4326', AMERICAS)).toEqual(AMERICAS);
  });

  it('produces a finite projected box for a conic', () => {
    const box = projectExtent('ATF:LCC', [-130, 12, -50, 62]);
    expect(box).not.toBeNull();
    expect(box!.every(Number.isFinite)).toBe(true);
    expect(box![2]).toBeGreaterThan(box![0]);
    expect(box![3]).toBeGreaterThan(box![1]);
    // Sanity: North America is thousands of kilometres across, not millions.
    expect(box![2] - box![0]).toBeGreaterThan(3_000_000);
    expect(box![2] - box![0]).toBeLessThan(20_000_000);
  });

  it('samples the edges, not just the corners', () => {
    // A conic bends the parallels into arcs, so a box's projected bounds reach
    // past its four corners — here the southern edge dips lowest at the central
    // meridian, between the corners. Cropping to the corners would cut off
    // geography the map plainly shows.
    const box = projectExtent('ATF:LCC', [-130, 12, -50, 62])!;
    const corner = ([lon, lat]: [number, number]) =>
      projectExtent('ATF:LCC', [lon, lat, lon, lat])!;
    const corners = ([[-130, 12], [-50, 12], [-130, 62], [-50, 62]] as [number, number][]).map(corner);
    const cornerBottom = Math.min(...corners.map((c) => c[1]));

    expect(box[1]).toBeLessThan(cornerBottom);
  });
});
