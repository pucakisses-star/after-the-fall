/**
 * Bending a name along an arc (spec §10).
 *
 * The slider promises three things and they are all geometry: nothing at zero,
 * upwards on one side and downwards on the other, and a name that keeps the
 * length it would have had straight so bending it does not also stretch it.
 */

import { describe, expect, it } from 'vitest';
import { arcPoints } from './textRenderer';

/** Straight-line distance from the first point to the last. */
function chord(points: { x: number; y: number }[]): number {
  const a = points[0];
  const b = points[points.length - 1];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** How far the middle of the run sits from the line joining its ends. */
function bulge(points: { x: number; y: number }[]): number {
  const mid = points[Math.floor(points.length / 2)];
  return (points[0].y + points[points.length - 1].y) / 2 - mid.y;
}

describe('arcPoints', () => {
  it('is a straight line at zero', () => {
    const pts = arcPoints(200, 0);
    expect(pts).toHaveLength(2);
    expect(pts[0].y).toBeCloseTo(0, 9);
    expect(pts[1].y).toBeCloseTo(0, 9);
    expect(chord(pts)).toBeCloseTo(200, 6);
  });

  it('arches upwards for a positive curve and cups downwards for a negative one', () => {
    // Screen y grows downwards, so an upward arch puts its middle above the ends.
    expect(bulge(arcPoints(200, 0.6))).toBeGreaterThan(10);
    expect(bulge(arcPoints(200, -0.6))).toBeLessThan(-10);
  });

  it('bends further the further the dial goes', () => {
    expect(bulge(arcPoints(200, 1))).toBeGreaterThan(bulge(arcPoints(200, 0.5)));
    expect(bulge(arcPoints(200, 0.5))).toBeGreaterThan(bulge(arcPoints(200, 0.1)));
  });

  it('keeps the run the width it was given, whatever the bend', () => {
    // The chord is the width: a bent name spans the same ground as a straight
    // one, so turning the dial does not also move the ends apart.
    for (const curve of [-1, -0.5, 0.25, 1]) {
      expect(chord(arcPoints(300, curve))).toBeCloseTo(300, 3);
    }
  });

  it('turns the whole arc with the label rotation', () => {
    const flat = arcPoints(200, 0.5, 0);
    const turned = arcPoints(200, 0.5, 90);
    // A quarter turn takes the run from horizontal to vertical, same length.
    expect(chord(turned)).toBeCloseTo(chord(flat), 6);
    expect(Math.abs(turned[turned.length - 1].y - turned[0].y)).toBeCloseTo(200, 3);
    expect(Math.abs(turned[turned.length - 1].x - turned[0].x)).toBeCloseTo(0, 6);
  });

  it('gives a usable polyline rather than a single point for a tiny run', () => {
    expect(arcPoints(0, 1).length).toBeGreaterThanOrEqual(2);
  });
});
