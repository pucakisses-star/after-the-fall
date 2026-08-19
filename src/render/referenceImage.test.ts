/** Placing, dragging and resizing a reference image (spec §32). */

import { describe, expect, it } from 'vitest';
import {
  MAX_FACTOR,
  MIN_FACTOR,
  movedBy,
  placementContains,
  placementExtent,
  placementFromExtent,
  resized,
} from './referenceImage';

const placed = () => placementFromExtent([-100, 30, -90, 40]);

describe('placement', () => {
  it('starts centred on where the image was dropped, at the size it landed', () => {
    const p = placed();
    expect(p.centre).toEqual([-95, 35]);
    expect(p.base).toEqual([10, 10]);
    expect(placementExtent(p)).toEqual([-100, 30, -90, 40]);
  });

  it('moves by a drag without changing size', () => {
    const p = movedBy(placed(), 2, -1);
    expect(placementExtent(p)).toEqual([-98, 29, -88, 39]);
  });

  it('ignores a drag that carries no number', () => {
    const p = placed();
    expect(movedBy(p, Number.NaN, 1)).toBe(p);
  });

  it('grows about its centre, so the part being traced stays put', () => {
    const p = resized(placed(), { scale: 2 });
    expect(placementExtent(p)).toEqual([-105, 25, -85, 45]);
    // The centre is where it was.
    expect(p.centre).toEqual([-95, 35]);
  });

  it('stretches width and height on their own', () => {
    const wide = resized(placed(), { stretchX: 2 });
    expect(placementExtent(wide)).toEqual([-105, 30, -85, 40]);
    const tall = resized(placed(), { stretchY: 1.5 });
    expect(placementExtent(tall)).toEqual([-100, 27.5, -90, 42.5]);
  });

  it('multiplies a stretch by the uniform size', () => {
    const p = resized(placed(), { scale: 2, stretchX: 1.5 });
    const [w, s, e, n] = placementExtent(p);
    expect(e - w).toBeCloseTo(30, 6); // 10 × 2 × 1.5
    expect(n - s).toBeCloseTo(20, 6); // 10 × 2
  });

  it('keeps every factor inside what a slider offers', () => {
    expect(resized(placed(), { scale: 99 }).scale).toBe(MAX_FACTOR);
    expect(resized(placed(), { stretchY: 0 }).stretchY).toBe(MIN_FACTOR);
    expect(resized(placed(), { scale: Number.NaN }).scale).toBe(1);
  });

  it('knows whether a point is on the image, so a drag can grab it', () => {
    const p = placed();
    expect(placementContains(p, -95, 35)).toBe(true);
    expect(placementContains(p, -101, 35)).toBe(false);
    // And it follows the image as that image is moved and grown.
    const moved = resized(movedBy(p, 20, 0), { scale: 2 });
    expect(placementContains(moved, -75, 35)).toBe(true);
    expect(placementContains(moved, -95, 35)).toBe(false);
  });
});
