/**
 * Both custom projections are inverted numerically, so round-tripping a grid of
 * control points is the only honest way to show the inverses are correct.
 */

import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import { naturalEarth, winkelTripel } from './winkelTripel';
import { PROJECTION_PRESETS, registerProjections } from './projections';

registerProjections();

const CONTROL_POINTS: [number, number][] = [
  [0, 0],
  [10, 10],
  [-45, 30],
  [120, -25],
  [-170, 60],
  [179, -60],
  [30, 75],
  [-120, -75],
  [90, 0],
  [-90, 45],
  [15, -45],
  [160, 15],
];

describe.each([
  ['Winkel Tripel', 'ATF:WINKEL3'],
  ['Natural Earth', 'ATF:NATURALEARTH'],
  ['Robinson', 'ATF:ROBINSON'],
  ['Mollweide', 'ATF:MOLLWEIDE'],
])('%s round-trip', (_name, code) => {
  it('recovers the original lon/lat to within a metre', () => {
    const forward = proj4('EPSG:4326', code);
    for (const [lon, lat] of CONTROL_POINTS) {
      const projected = forward.forward([lon, lat]) as [number, number];
      expect(Number.isFinite(projected[0])).toBe(true);
      expect(Number.isFinite(projected[1])).toBe(true);

      const back = forward.inverse(projected) as [number, number];
      // 1e-5 degrees is roughly a metre.
      expect(back[0]).toBeCloseTo(lon, 4);
      expect(back[1]).toBeCloseTo(lat, 4);
    }
  });
});

describe('Winkel Tripel forward', () => {
  it('maps the origin to the origin', () => {
    const p = proj4('EPSG:4326', 'ATF:WINKEL3').forward([0, 0]) as [number, number];
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(0, 6);
  });

  it('is symmetric about the equator and the central meridian', () => {
    const f = proj4('EPSG:4326', 'ATF:WINKEL3');
    const a = f.forward([40, 30]) as [number, number];
    const b = f.forward([-40, 30]) as [number, number];
    const c = f.forward([40, -30]) as [number, number];
    expect(a[0]).toBeCloseTo(-b[0], 3);
    expect(a[1]).toBeCloseTo(b[1], 3);
    expect(a[0]).toBeCloseTo(c[0], 3);
    expect(a[1]).toBeCloseTo(-c[1], 3);
  });

  it('narrows the parallels towards the poles, unlike a cylindrical projection', () => {
    const f = proj4('EPSG:4326', 'ATF:WINKEL3');
    const equator = (f.forward([180, 0]) as [number, number])[0];
    const high = (f.forward([180, 70]) as [number, number])[0];
    expect(Math.abs(high)).toBeLessThan(Math.abs(equator));
  });

  it('exposes the names proj4 needs to resolve +proj=wintri', () => {
    expect(winkelTripel.names).toContain('wintri');
    expect(naturalEarth.names).toContain('natearth');
  });
});

describe('Natural Earth forward', () => {
  it('keeps the central meridian straight', () => {
    const f = proj4('EPSG:4326', 'ATF:NATURALEARTH');
    for (const lat of [-80, -40, 0, 40, 80]) {
      const p = f.forward([0, lat]) as [number, number];
      expect(p[0]).toBeCloseTo(0, 6);
    }
  });

  it('keeps parallels horizontal, as a pseudocylindrical must', () => {
    const f = proj4('EPSG:4326', 'ATF:NATURALEARTH');
    const a = f.forward([-100, 45]) as [number, number];
    const b = f.forward([100, 45]) as [number, number];
    expect(a[1]).toBeCloseTo(b[1], 6);
  });
});

describe('projection registry', () => {
  it('measures a finite extent for every preset', () => {
    for (const preset of PROJECTION_PRESETS) {
      expect(preset.extent, `${preset.name} has no extent`).not.toBeNull();
      expect(preset.extent!.every(Number.isFinite), `${preset.name} extent is not finite`).toBe(true);
      expect(preset.extent![2]).toBeGreaterThan(preset.extent![0]);
      expect(preset.extent![3]).toBeGreaterThan(preset.extent![1]);
    }
  });

  it('offers every projection the spec asks for (§4)', () => {
    const names = PROJECTION_PRESETS.map((p) => p.name.toLowerCase());
    for (const required of ['mercator', 'robinson', 'winkel', 'equirectangular', 'lambert', 'albers', 'orthographic', 'natural earth']) {
      expect(names.some((n) => n.includes(required)), `missing ${required}`).toBe(true);
    }
  });
});
