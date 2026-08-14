/**
 * Putting a frontier onto the river it runs beside (spec §6, §16, §64).
 */

import { describe, expect, it } from 'vitest';
import { indexRivers, snapToRivers } from './riverSnap';
import type { Position } from 'geojson';

/** A meandering river running west to east — nothing straight can imitate it. */
function meander(): Position[] {
  const pts: Position[] = [];
  for (let i = 0; i <= 60; i++) {
    const x = i * 0.1;
    pts.push([x, 5 + Math.sin(i * 0.7) * 0.25]);
  }
  return pts;
}

/** A straight frontier alongside it, of the kind the lattice produces. */
function straightArc(y: number, from = 0, to = 6, steps = 30): Position[] {
  const pts: Position[] = [];
  for (let i = 0; i <= steps; i++) pts.push([from + ((to - from) * i) / steps, y]);
  return pts;
}

const river = meander();
const index = indexRivers([river], 0.2);

/** Distance from a point to the river, for judging how well an arc sits on it. */
function distanceToRiver(p: Position): number {
  let best = Infinity;
  for (let i = 0; i < river.length - 1; i++) {
    const [ax, ay] = river[i];
    const [bx, by] = river[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

const furthest = (arc: Position[]) => Math.max(...arc.map(distanceToRiver));

describe('snapToRivers', () => {
  it('puts a frontier running beside a river onto it', () => {
    const arc = straightArc(5.1);
    expect(furthest(arc)).toBeGreaterThan(0.2);

    const snapped = snapToRivers(arc, index, 0.4);
    // Every interior vertex now sits on the river itself, not merely near it.
    const interior = snapped.slice(1, -1);
    // Within the five decimal places the whole outline is rounded to.
    expect(furthest(interior)).toBeLessThan(2e-5);
    // And it picked up the meander rather than cutting across it.
    expect(snapped.length).toBeGreaterThan(arc.length / 2);
  });

  it('never moves the ends, which are junctions three realms agree on', () => {
    const arc = straightArc(5.1);
    const snapped = snapToRivers(arc, index, 0.4);
    expect(snapped[0]).toEqual(arc[0]);
    expect(snapped[snapped.length - 1]).toEqual(arc[arc.length - 1]);
  });

  it('gives the same border from either side (§6)', () => {
    // The whole point: two realms hold the same frontier, one of them reversed,
    // and must come back with the same line or the map grows a seam.
    const arc = straightArc(5.1);
    const forward = snapToRivers(arc, index, 0.4);
    const backward = snapToRivers([...arc].reverse(), index, 0.4).reverse();
    expect(forward).toEqual(backward);
  });

  it('leaves a frontier that is nowhere near a river alone', () => {
    const far = straightArc(8);
    expect(snapToRivers(far, index, 0.4)).toBe(far);
  });

  it('ignores a river the frontier merely crosses', () => {
    // A frontier cutting across a river at right angles has several vertices
    // within tolerance of it, all projecting onto much the same point. Snapping
    // there would swing the border along the bank and straight back.
    const straightRiver: Position[] = [];
    for (let i = 0; i <= 60; i++) straightRiver.push([i * 0.1, 5]);
    const straightIndex = indexRivers([straightRiver], 0.2);

    const crossing: Position[] = [[3, 4.2], [3, 4.6], [3, 5.0], [3, 5.4], [3, 5.9]];
    expect(snapToRivers(crossing, straightIndex, 0.5)).toBe(crossing);

    // While a frontier running *along* the same river is snapped onto it.
    const along = straightArc(5.2, 1, 5, 20);
    expect(snapToRivers(along, straightIndex, 0.5)).not.toBe(along);
  });

  it('does not double back when the frontier crosses a meander', () => {
    // Positions along the river must advance in one direction; without that a
    // border cutting across a loop is snapped to a course that reverses.
    const arc = straightArc(5.1, 0, 6, 30);
    const snapped = snapToRivers(arc, index, 0.4);
    let backwards = 0;
    for (let i = 1; i < snapped.length; i++) if (snapped[i][0] < snapped[i - 1][0] - 1e-9) backwards++;
    // A meander does run back on itself in x, but the border should not unwind
    // the whole way; a broken direction test shows up as dozens of reversals.
    expect(backwards).toBeLessThan(snapped.length / 4);
  });

  it('refuses a course that wanders off the line it replaces', () => {
    // A river that dives away and comes back stays within tolerance at the
    // vertices the frontier happens to sample, but its course between them
    // swings far off. Taking it would cross the neighbouring arcs of the same
    // ring, and a self-crossing ring resolves differently for the realm on each
    // side — which is what tore unclaimed slivers along every snapped river.
    const detour: Position[] = [
      [1, 5], [1.5, 5], [2, 5],
      [2.2, 3.5], [2.6, 3.5],            // a long excursion south
      [2.8, 5], [3.3, 5], [3.8, 5],
    ];
    const detourIndex = indexRivers([detour], 0.2);
    const arc = straightArc(5.05, 1, 3.8, 14);
    const snapped = snapToRivers(arc, detourIndex, 0.3);
    // Whatever it does, it must not drag the border a degree and a half south.
    const southmost = Math.min(...snapped.map((p) => p[1]));
    expect(southmost).toBeGreaterThan(4.5);
  });

  it('handles arcs too short to snap without complaint', () => {
    const tiny: Position[] = [[1, 5.1], [1.1, 5.1]];
    expect(snapToRivers(tiny, index, 0.4)).toBe(tiny);
    expect(snapToRivers([], index, 0.4)).toEqual([]);
  });

  it('does nothing when snapping is switched off', () => {
    const arc = straightArc(5.1);
    expect(snapToRivers(arc, index, 0)).toBe(arc);
  });

  it('measures distance in real ground, not raw degrees', () => {
    // A degree of longitude at 70°N is a third of one at the equator, so a
    // tolerance in raw degrees would reach three times further across the
    // Arctic than across the tropics.
    const arctic: Position[] = [];
    for (let i = 0; i <= 40; i++) arctic.push([i * 0.1, 70]);
    const arcticIndex = indexRivers([arctic], 0.2);
    // 0.5° of longitude at 70°N is about 19 km — inside a 25 km tolerance.
    const near = straightArc(70, 0, 4, 20).map(([x]) => [x + 0.5, 70] as Position);
    const snapped = snapToRivers(near, arcticIndex, 0.25);
    expect(snapped).not.toBe(near);
  });
});
