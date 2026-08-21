/**
 * Tiling a plate too big for one image (spec §48).
 *
 * The property that matters is that the pieces *are* the plate: every pixel
 * covered once, nothing padded, nothing overlapping. A seam is not something to
 * check by eye afterwards — if the arithmetic below holds, there is nothing at
 * a seam to go wrong, because each tile is a crop of one drawing rather than a
 * drawing of its own.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TILE_PX, planTiles, retileSvg, stitchReadme, tileFilename } from './tileExport';

describe('dividing a plate', () => {
  it('covers every pixel exactly once, with no padding', () => {
    const plan = planTiles(10_000, 7_000, 4096);
    expect([plan.cols, plan.rows]).toEqual([3, 2]);

    // Total area of the tiles is the area of the plate — no overlap, no bleed.
    const area = plan.tiles.reduce((n, t) => n + t.w * t.h, 0);
    expect(area).toBe(10_000 * 7_000);
    expect(plan.totalPixels).toBe(10_000 * 7_000);

    // And the union reaches exactly the far corner.
    expect(Math.max(...plan.tiles.map((t) => t.x + t.w))).toBe(10_000);
    expect(Math.max(...plan.tiles.map((t) => t.y + t.h))).toBe(7_000);
  });

  it('makes the last column and row short rather than padding them', () => {
    const plan = planTiles(10_000, 7_000, 4096);
    const last = plan.tiles.find((t) => t.col === 2 && t.row === 1)!;
    expect(last.w).toBe(10_000 - 2 * 4096);
    expect(last.h).toBe(7_000 - 4096);
  });

  it('handles a plate smaller than one tile', () => {
    const plan = planTiles(500, 300, 4096);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]).toMatchObject({ x: 0, y: 0, w: 500, h: 300 });
  });

  it('walks the grid in reading order', () => {
    const plan = planTiles(9000, 9000, 4096);
    expect(plan.tiles.map((t) => `${t.row}${t.col}`)).toEqual([
      '00', '01', '02', '10', '11', '12', '20', '21', '22',
    ]);
  });

  it('scales the way the request does — half the ground scale is a quarter of the work', () => {
    const fine = planTiles(20_000, 20_000, DEFAULT_TILE_PX);
    const coarse = planTiles(10_000, 10_000, DEFAULT_TILE_PX);
    expect(fine.totalPixels).toBe(coarse.totalPixels * 4);
  });
});

describe('pointing a document at one tile', () => {
  const svg =
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="7000" ' +
    'viewBox="0 0 10000 7000">\n<g id="labels"><text x="9" y="9">Salem</text></g>\n</svg>';

  it('crops by viewBox and leaves the drawing untouched', () => {
    const plan = planTiles(10_000, 7_000, 4096);
    const tile = plan.tiles[4]; // row 1, col 1
    const out = retileSvg(svg, tile);

    expect(out).toContain(`viewBox="${tile.x} ${tile.y} ${tile.w} ${tile.h}"`);
    expect(out).toContain(`width="${tile.w}"`);
    expect(out).toContain(`height="${tile.h}"`);
    // The body is the same drawing — this is the whole reason the seams line up.
    expect(out).toContain('<g id="labels"><text x="9" y="9">Salem</text></g>');
    expect(out.slice(0, out.indexOf('<svg'))).toBe('<?xml version="1.0"?>\n');
  });

  it('draws every tile at 1:1, so the pieces are the same scale', () => {
    const plan = planTiles(10_000, 7_000, 4096);
    for (const tile of plan.tiles) {
      const out = retileSvg(svg, tile);
      const box = /viewBox="(\S+) (\S+) (\S+) (\S+)"/.exec(out)!;
      const w = /\swidth="(\d+)"/.exec(out)!;
      const h = /\sheight="(\d+)"/.exec(out)!;
      expect(Number(box[3])).toBe(Number(w[1]));
      expect(Number(box[4])).toBe(Number(h[1]));
    }
  });

  it('refuses something that is not an SVG', () => {
    expect(() => retileSvg('nope', planTiles(10, 10).tiles[0])).toThrow(/not an SVG/);
  });
});

describe('what lands in the folder', () => {
  it('names tiles so they sort into grid order', () => {
    const plan = planTiles(50_000, 50_000, 4096); // 13 × 13, so two digits
    const names = plan.tiles.map((t) => tileFilename('map', t, plan));
    expect(names[0]).toBe('map_r00_c00.png');
    expect(names[names.length - 1]).toBe('map_r12_c12.png');
    // Sorting the names must not shuffle the grid.
    expect([...names].sort()).toEqual(names);
  });

  it('writes a note that names the grid and how to rejoin it', () => {
    const plan = planTiles(10_000, 7_000, 4096);
    const readme = stitchReadme('map', plan, 45);
    expect(readme).toContain('3 × 2 tiles');
    expect(readme).toContain('10000 × 7000 px');
    expect(readme).toContain('45 m to the pixel');
    expect(readme).toContain('-tile 3x2');
  });
});
