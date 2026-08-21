/**
 * Exporting a plate too big for one image, as tiles (spec §48).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * "If I am zoomed in this far, the whole map should come out this detailed."
 * That is a reasonable thing to want and it does not fit in a PNG. Measured on
 * this map, at a zoom where the scale bar reads ten kilometres — about 45 m to
 * the pixel — the working extent comes to 149,857 × 329,905 px, which is 49.4
 * gigapixels. A browser canvas stops at 16,384 px a side, so the largest single
 * image that can be made of that extent works out at roughly 935 m to the
 * pixel: twenty times coarser than the screen it was asked to match. No amount
 * of tuning closes a gap of that shape. The picture has to come out in pieces.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PIECES LINE UP
 * ---------------------------------------------------------------------------
 * The obvious construction — render each tile as its own little map of its own
 * little extent — does not work, and the reasons are worth stating because they
 * all look like small problems and are not:
 *
 *   • a name is anchored at a point and spills a long way either side of it, so
 *     a name near a seam would be cut off in one tile and absent from the next;
 *   • which names are drawn at all depends on how much room a realm has on the
 *     plate, so a territory straddling a seam would be named differently in its
 *     two halves, or twice;
 *   • hatch patterns and dashes are laid out from the origin, so every tile
 *     would start its dash pattern afresh and the seams would show as a jump.
 *
 * So the SVG is built *once*, for the whole giant plate, and each tile is a
 * window onto it. An SVG is resolution-independent: the document can describe a
 * 150,000 px plate at no cost, because nothing is rasterised until a `viewBox`
 * says which part to draw and at what size. Every coordinate, every label
 * decision, every dash phase is computed once for the whole plate, and a tile
 * is a crop of that one answer. Nothing has to be lined up afterwards, because
 * nothing was ever computed twice — see `TILING_FIDELITY` for how close that
 * comes in practice.
 */

import { exportSvg, type SvgExportOptions } from './svgExport';
import type { MapProject } from '@/model/types';

/**
 * Default edge of one tile, in pixels.
 *
 * Comfortably inside every browser's canvas limit with room for the rasteriser's
 * own working copy, and big enough that a plate does not shatter into thousands
 * of files. 4096 is also the size most stitching tools are happiest with.
 */
export const DEFAULT_TILE_PX = 4096;

/** Above this, a tile run is worth a second thought rather than a click. */
export const MANY_TILES = 200;

/**
 * How closely the tiles reproduce a single-pass render, measured.
 *
 * A 2×2 run over a 3017 × 2074 plate was stitched and differenced against the
 * same plate exported as one image. 99.98% of pixels came out bit-identical;
 * the 1,052 that did not are a three-pixel line either side of the seam, and
 * only ten of those differ by more than 8/255 (worst case 19). The control
 * matters here: two single-pass renders of the same plate are byte-identical,
 * so that residue is genuinely the tiling and not rasteriser noise.
 *
 * It is the rasteriser anti-aliasing shapes against the window edge. Rendering
 * each tile with two, then eight, pixels of overspill and cropping it away
 * changed the result by not one pixel, so that explanation is incomplete and
 * the overspill is not in the code: a knob that does nothing is worse than no
 * knob. What is left is a hairline at the seams, well under the threshold of a
 * visible join, and it is recorded here rather than described as exact.
 */
const TILING_FIDELITY = '99.98% identical; seams differ by at most 19/255';

export interface Tile {
  col: number;
  row: number;
  /** Position and size of this tile's window on the plate, in plate px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TilePlan {
  cols: number;
  rows: number;
  tiles: Tile[];
  plateWidth: number;
  plateHeight: number;
  tilePx: number;
  totalPixels: number;
  /** Very rough, for a warning rather than a promise. */
  estimatedBytes: number;
}

/**
 * Divide a plate into tiles.
 *
 * The right and bottom tiles are short rather than padded, so the tiles
 * reassemble into exactly the plate and not a pixel more — a border of dead
 * pixels down two edges of a stitched image is the kind of thing that is only
 * noticed after the stitching.
 */
export function planTiles(plateWidth: number, plateHeight: number, tilePx = DEFAULT_TILE_PX): TilePlan {
  const w = Math.max(1, Math.floor(plateWidth));
  const h = Math.max(1, Math.floor(plateHeight));
  const size = Math.max(64, Math.floor(tilePx));
  const cols = Math.ceil(w / size);
  const rows = Math.ceil(h / size);
  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * size;
      const y = row * size;
      tiles.push({ col, row, x, y, w: Math.min(size, w - x), h: Math.min(size, h - y) });
    }
  }
  const totalPixels = w * h;
  return {
    cols,
    rows,
    tiles,
    plateWidth: w,
    plateHeight: h,
    tilePx: size,
    totalPixels,
    // Around a byte and a half a pixel for a map's flat colour at PNG's
    // compression — measured on this project's own exports, and only ever shown
    // as an order of magnitude.
    estimatedBytes: Math.round(totalPixels * 1.5),
  };
}

/**
 * Point one SVG document at one tile.
 *
 * Only the root element's `width`, `height` and `viewBox` change: the `viewBox`
 * says which part of the plate to look at and the size says how many pixels to
 * spend on it, and since they carry the same numbers the tile comes out at 1:1
 * with the plate. The document body is untouched, which is the whole point —
 * every tile is the same drawing, cropped.
 */
export function retileSvg(svg: string, tile: Tile): string {
  const open = svg.indexOf('<svg');
  if (open < 0) throw new Error('That is not an SVG document.');
  const close = svg.indexOf('>', open);
  if (close < 0) throw new Error('The SVG root element is unterminated.');

  const head = svg
    .slice(open, close)
    .replace(/\swidth="[^"]*"/, ` width="${tile.w}"`)
    .replace(/\sheight="[^"]*"/, ` height="${tile.h}"`)
    .replace(/\sviewBox="[^"]*"/, ` viewBox="${tile.x} ${tile.y} ${tile.w} ${tile.h}"`);

  return svg.slice(0, open) + head + svg.slice(close);
}

/** `map_r003_c012.png` — zero-padded so the files sort into their grid order. */
export function tileFilename(base: string, tile: Tile, plan: TilePlan): string {
  const pad = (n: number, of: number) => String(n).padStart(String(of - 1).length, '0');
  return `${base}_r${pad(tile.row, plan.rows)}_c${pad(tile.col, plan.cols)}.png`;
}

/**
 * What to put beside the tiles so they can be put back together.
 *
 * A folder of eight hundred PNGs is not self-explanatory, and the one thing its
 * owner will want is the command that turns it back into a map.
 */
export function stitchReadme(base: string, plan: TilePlan, metresPerPixel: number | null): string {
  const gp = (plan.totalPixels / 1e9).toFixed(2);
  return [
    `${plan.cols} × ${plan.rows} tiles — ${plan.plateWidth} × ${plan.plateHeight} px in total (${gp} gigapixels).`,
    metresPerPixel ? `About ${metresPerPixel.toFixed(0)} m to the pixel.` : '',
    '',
    'Files are named _r<row>_c<column>, numbered from the top-left, so they sort',
    'into reading order. The right-hand and bottom tiles are narrower and shorter',
    'than the rest: together the tiles are exactly the plate, with no padding.',
    '',
    'To put them back together with ImageMagick:',
    '',
    `  magick montage ${base}_r*_c*.png -tile ${plan.cols}x${plan.rows} -geometry +0+0 ${base}.png`,
    '',
    'ImageMagick will want a lot of memory at this size. libvips is far lighter:',
    '',
    `  vips arrayjoin "$(ls ${base}_r*_c*.png | tr '\\n' ' ')" ${base}.tif --across ${plan.cols}`,
    '',
    'Most image tools cannot open a single file this large. A tiled TIFF, or a',
    'viewer that pages tiles in, is usually a better destination than one PNG.',
    '',
    `Fidelity against a single-pass render of the same plate: ${TILING_FIDELITY}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Rendering (browser only)
// ---------------------------------------------------------------------------

/** Where each finished tile goes. Returning a promise back-pressures the run. */
export type TileSink = (tile: Tile, blob: Blob, filename: string) => Promise<void>;

export interface TileRunOptions {
  base: string;
  plan: TilePlan;
  transparent?: boolean;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

function loadSvgImage(svg: string): Promise<{ image: HTMLImageElement; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const revoke = () => URL.revokeObjectURL(url);
    image.onload = () => resolve({ image, revoke });
    image.onerror = () => {
      revoke();
      reject(new Error('The browser could not read the exported SVG.'));
    };
    image.src = url;
  });
}

/**
 * Render every tile of a plate, handing each one to `sink` as it is finished.
 *
 * Tiles are produced and disposed of one at a time. A run of this size cannot
 * be held in memory — eight hundred tiles is tens of gigabytes — so nothing is
 * accumulated here and the sink is awaited before the next tile starts.
 */
export async function exportTiles(
  project: MapProject,
  opts: SvgExportOptions,
  sink: TileSink,
  run: TileRunOptions,
): Promise<number> {
  const { plan, base, signal } = run;
  // One document for the whole plate. Built once, cropped many times — see the
  // note at the top of this file for why this is not per-tile rendering.
  const svg = await exportSvg(project, { ...opts, width: plan.plateWidth, height: plan.plateHeight });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Could not obtain a 2D canvas context.');

  let done = 0;
  for (const tile of plan.tiles) {
    if (signal?.aborted) break;
    const { image, revoke } = await loadSvgImage(retileSvg(svg, tile));
    try {
      canvas.width = tile.w;
      canvas.height = tile.h;
      ctx.clearRect(0, 0, tile.w, tile.h);
      if (!run.transparent) {
        ctx.fillStyle = project.oceanColor;
        ctx.fillRect(0, 0, tile.w, tile.h);
      }
      ctx.drawImage(image, 0, 0, tile.w, tile.h);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The browser refused to encode a tile.');
      await sink(tile, blob, tileFilename(base, tile, plan));
    } finally {
      revoke();
    }
    done++;
    run.onProgress?.(done, plan.tiles.length);
  }

  // Releasing the backing store matters after a run this long.
  canvas.width = 0;
  canvas.height = 0;
  return done;
}

/** Whether this browser can be handed a folder to write into. */
export function canWriteFolder(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * A sink that writes into a folder the user picks.
 *
 * The alternative — one download per tile — is what the fallback does, and it
 * is only tolerable for a handful of tiles: a browser asked to save eight
 * hundred files in a row will start blocking them.
 */
export async function folderSink(): Promise<{ sink: TileSink; write: (name: string, text: string) => Promise<void> } | null> {
  if (!canWriteFolder()) return null;
  const dir = await (
    window as unknown as { showDirectoryPicker: (o?: unknown) => Promise<FileSystemDirectoryHandle> }
  ).showDirectoryPicker({ mode: 'readwrite' });

  const put = async (name: string, data: Blob | string) => {
    const handle = await dir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    await stream.write(data);
    await stream.close();
  };

  return {
    sink: async (_tile, blob, filename) => put(filename, blob),
    write: async (name, text) => put(name, text),
  };
}
