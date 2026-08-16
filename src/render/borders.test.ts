/**
 * Telling a coast from a frontier (spec §8).
 *
 * A one-sided border — a territory with nobody on the other side — is two
 * different things in one line: where it runs along the sea it is a coast,
 * which nobody drew and which the coastline already renders, and where it runs
 * inland it is a frontier, which is a real political line. The bug this pins:
 * the two arrive merged into one run, so any whole-run answer strokes the coast
 * or silences the frontier, whichever is longer.
 */

import { describe, expect, it } from 'vitest';
import type { LineString, Position } from 'geojson';
import { indexCoastVertices, splitByCoast } from './borders';

/**
 * A square island from (0,0) to (10,10), traced at every unit — the coastline
 * a territory clipped to it would inherit its own edge vertices from.
 */
const shoreRing = (): Position[] => {
  const out: Position[] = [];
  for (let x = 0; x <= 10; x++) out.push([x, 0]);
  for (let y = 1; y <= 10; y++) out.push([10, y]);
  for (let x = 9; x >= 0; x--) out.push([x, 10]);
  for (let y = 9; y >= 0; y--) out.push([0, y]);
  return out;
};
const ISLAND = indexCoastVertices([{ type: 'Polygon', coordinates: [shoreRing()] }]);

const line = (coords: Position[]): LineString => ({ type: 'LineString', coordinates: coords });

/** A run along the island's west edge, vertex every unit. */
const along = (x: number, y0: number, y1: number): Position[] => {
  const out: Position[] = [];
  const step = y1 > y0 ? 1 : -1;
  for (let y = y0; y !== y1 + step; y += step) out.push([x, y]);
  return out;
};

describe('splitByCoast', () => {
  it('calls a run on the shore a coast', () => {
    const pieces = splitByCoast(line(along(0, 1, 9)), ISLAND);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].coastal).toBe(true);
  });

  it('calls a run inland a frontier', () => {
    const pieces = splitByCoast(line(along(5, 1, 9)), ISLAND);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].coastal).toBe(false);
  });

  it('splits a run that is each in turn, losing no ground', () => {
    // Up the coast, then a right angle inland across the island: one line, two
    // natures. This is Baja in miniature — measured there, one 778-point run
    // carried the whole peninsula's coast and its frontier together.
    const run = [...along(0, 1, 9), ...along(1, 9, 9), [2, 9], [3, 9], [4, 9], [5, 9], [6, 9]] as Position[];
    const pieces = splitByCoast(line(run), ISLAND);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces[0].coastal).toBe(true);
    expect(pieces[pieces.length - 1].coastal).toBe(false);
    // Adjacent pieces share their joint vertex, so nothing is left undrawn.
    const total = pieces.reduce((n, p) => n + p.geometry.coordinates.length - 1, 0);
    expect(total).toBe(run.length - 1);
  });

  it('does not let a creek dash the coast', () => {
    // One segment reading "land both sides" in the middle of a shore run is
    // noise, and without smoothing it draws as an isolated dash of border.
    const shore = along(0, 1, 9);
    const pieces = splitByCoast(line(shore), ISLAND);
    expect(pieces.every((p) => p.coastal)).toBe(true);
  });
});
