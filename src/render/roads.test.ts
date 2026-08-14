/**
 * Reference highways: scale thinning, weight hierarchy and route shields
 * (spec §14, §64).
 *
 * Like the places helpers next door, these are shared by the screen renderer and
 * the SVG exporter, so testing them once covers both — which is the point of
 * their existing.
 */

import { describe, expect, it } from 'vitest';
import {
  metersPerUnit,
  roadClass,
  roadLabelVisible,
  roadRankStyle,
  roadVisible,
  routeShield,
} from './olStyles';

/**
 * Metres per pixel at the three scales that matter, taken from the app's own
 * readout: a 96 dpi pixel is 0.000265 m, so 1:N is N × that.
 */
const CONTINENTAL = 43_000_000 * 0.000264583; // both Americas on one screen
const REGIONAL = 5_400_000 * 0.000264583; // the mid-Atlantic states
const LOCAL = 800_000 * 0.000264583; // one state

describe('roadVisible', () => {
  it('keeps only the trunk system when zoomed out', () => {
    // Natural Earth's min_zoom: 3 is an interstate, 7.1 a state route.
    expect(roadVisible(3, CONTINENTAL)).toBe(true);
    expect(roadVisible(7.1, CONTINENTAL)).toBe(false);
  });

  it('lets the secondary network in as you zoom', () => {
    expect(roadVisible(7.1, REGIONAL)).toBe(false);
    expect(roadVisible(7.1, LOCAL)).toBe(true);
  });

  it('is monotonic in both arguments', () => {
    // A more important road never disappears while a less important one shows,
    // and zooming in never removes a road that was already drawn.
    for (const mpp of [CONTINENTAL, REGIONAL, LOCAL]) {
      for (const z of [3, 4, 5, 6, 7, 7.1]) {
        if (roadVisible(z, mpp)) expect(roadVisible(z - 1, mpp)).toBe(true);
        if (roadVisible(z, mpp)) expect(roadVisible(z, mpp / 2)).toBe(true);
      }
    }
  });

  it('treats a road with no hint as minor rather than always-on', () => {
    // A hand-made file can carry anything at all, including nothing. The wrong
    // answer here floods a world view with every road in it.
    for (const missing of [NaN, Infinity, undefined as unknown as number]) {
      expect(roadVisible(missing, CONTINENTAL)).toBe(false);
      expect(roadVisible(missing, LOCAL)).toBe(true);
    }
  });

  it('gives the same answer in degrees as in metres', () => {
    // An equirectangular project measures in degrees; without the conversion a
    // lat/lon map would draw every road at every scale.
    const degrees = 0.05;
    expect(roadVisible(7.1, degrees * metersPerUnit('degrees'))).toBe(
      roadVisible(7.1, 0.05 * 111319.49079327358),
    );
    expect(roadVisible(7.1, degrees * metersPerUnit('degrees'))).toBe(false);
  });
});

describe('roadLabelVisible', () => {
  it('draws the line well before the number', () => {
    // Same order the reference cities earn their names in: a mark first, the
    // name once there is room to write it.
    const props = { min_zoom: 3, min_label: 8.5 };
    expect(roadVisible(props.min_zoom, REGIONAL)).toBe(true);
    expect(roadLabelVisible(props.min_label, REGIONAL)).toBe(false);
    expect(roadLabelVisible(props.min_label, LOCAL)).toBe(true);
  });

  it('treats a road with no hint as the least labellable', () => {
    expect(roadLabelVisible(NaN, REGIONAL)).toBe(false);
  });
});

describe('roadClass', () => {
  it('trusts level over type where Natural Earth set one', () => {
    // A US federal route typed "Secondary Highway" is still a trunk road; two
    // thirds of the file is typed but not levelled, hence the fallback.
    expect(roadClass({ type: 'Secondary Highway', level: 'Federal' })).toBe('trunk');
    expect(roadClass({ type: 'Major Highway', level: 'Interstate' })).toBe('trunk');
    expect(roadClass({ type: 'Major Highway' })).toBe('trunk');
    expect(roadClass({ type: 'Secondary Highway' })).toBe('minor');
    expect(roadClass({ type: 'Beltway' })).toBe('major');
    expect(roadClass({})).toBe('minor');
  });
});

describe('roadRankStyle', () => {
  it('draws trunk routes heavier than the rest', () => {
    expect(roadRankStyle('trunk').width).toBeGreaterThan(roadRankStyle('major').width);
    expect(roadRankStyle('major').width).toBeGreaterThan(roadRankStyle('minor').width);
  });
});

describe('routeShield', () => {
  it('reassembles the route number from its two halves', () => {
    // Natural Earth stores prefix and number apart and leaves `label` null for
    // every road in the Americas, so the shield has to be built here.
    expect(routeShield({ prefix: 'I', name: '95' })).toBe('I-95');
    expect(routeShield({ prefix: 'US', name: '1' })).toBe('US-1');
  });

  it('recovers the prefix Natural Earth left off', () => {
    // Only 96 of the 1,352 US interstates carry a prefix in the file; the rest
    // would read as a bare "95" without this.
    expect(routeShield({ name: '95', level: 'Interstate', sov_a3: 'USA' })).toBe('I-95');
    expect(routeShield({ name: '1', level: 'Federal', sov_a3: 'USA' })).toBe('US-1');
  });

  it('uses the bare number where there is no prefix to be had', () => {
    // A Mexican federal highway is not a US route, a state route belongs to a
    // state this file does not name, and outside the US a bare number is what
    // the road is signed with anyway.
    expect(routeShield({ name: '15', level: 'Federal', sov_a3: 'MEX' })).toBe('15');
    expect(routeShield({ name: '401', level: 'State', sov_a3: 'CAN' })).toBe('401');
    expect(routeShield({ name: '9', level: 'State', sov_a3: 'USA' })).toBe('9');
    expect(routeShield({ name: '401' })).toBe('401');
    expect(routeShield({ name: '401', prefix: '' })).toBe('401');
  });

  it('is empty for an unnamed road rather than a stray prefix', () => {
    expect(routeShield({})).toBe('');
    expect(routeShield({ prefix: 'I' })).toBe('');
    expect(routeShield({ name: '  ' })).toBe('');
  });
});
