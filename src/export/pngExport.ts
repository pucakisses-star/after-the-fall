/**
 * PNG export (spec §48).
 *
 * Rasterised *from the SVG export*, not from the live map canvas. Two reasons:
 *
 *   1. The PNG is then guaranteed to match the SVG — one renderer, one result.
 *   2. Output size is unbounded by the browser window, so 12000 × 8000 works the
 *      same way 800 × 600 does.
 *
 * Browsers cap canvas dimensions (Chrome and Safari at 16384 px per side and a
 * total area limit), so very large exports are rendered in horizontal bands and
 * stitched, which keeps peak memory to one band rather than the whole image.
 */

import { exportSvg, type SvgExportOptions } from './svgExport';
import type { MapProject } from '@/model/types';

export interface PngExportOptions extends SvgExportOptions {
  /** Metadata only — PNG has no real DPI field we can set from a canvas blob. */
  dpi: number;
  transparent: boolean;
}

/** Conservative ceiling that every current browser honours. */
const MAX_CANVAS_DIMENSION = 16000;
const MAX_CANVAS_AREA = 268_000_000; // ~16k × 16k

export interface RasterLimits {
  ok: boolean;
  message?: string;
}

export function checkRasterLimits(width: number, height: number): RasterLimits {
  if (width <= 0 || height <= 0) return { ok: false, message: 'Width and height must be positive.' };
  if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION) {
    return {
      ok: false,
      message: `Browsers cap images at ${MAX_CANVAS_DIMENSION.toLocaleString()} px per side. Export SVG for anything larger.`,
    };
  }
  if (width * height > MAX_CANVAS_AREA) {
    return {
      ok: false,
      message: 'That image is larger than a browser canvas can hold. Export SVG instead, or reduce the size.',
    };
  }
  return { ok: true };
}

/** Load an SVG string into an HTMLImageElement via a blob URL. */
function loadSvgImage(svg: string): Promise<{ image: HTMLImageElement; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ image, revoke: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The map could not be rasterised. Try exporting SVG instead.'));
    };
    image.src = url;
  });
}

export async function exportPng(
  project: MapProject,
  opts: PngExportOptions,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const limits = checkRasterLimits(opts.width, opts.height);
  if (!limits.ok) throw new Error(limits.message);

  const svg = await exportSvg(project, { ...opts, background: opts.transparent ? false : opts.background });
  onProgress?.(0.35);

  const { image, revoke } = await loadSvgImage(svg);
  onProgress?.(0.55);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Could not obtain a 2D canvas context.');

    if (!opts.transparent && opts.background) {
      ctx.fillStyle = project.oceanColor;
      ctx.fillRect(0, 0, opts.width, opts.height);
    }

    // Draw in bands so a huge image never needs a second full-size buffer.
    const bandHeight = Math.max(256, Math.floor(MAX_CANVAS_AREA / Math.max(1, opts.width) / 4));
    if (bandHeight >= opts.height) {
      ctx.drawImage(image, 0, 0, opts.width, opts.height);
    } else {
      for (let y = 0; y < opts.height; y += bandHeight) {
        const h = Math.min(bandHeight, opts.height - y);
        ctx.drawImage(image, 0, y, opts.width, h, 0, y, opts.width, h);
        onProgress?.(0.55 + 0.4 * (y / opts.height));
      }
    }
    onProgress?.(0.95);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The browser refused to encode the PNG.');
    onProgress?.(1);
    return blob;
  } finally {
    revoke();
  }
}

/** Suggested pixel size for a target print size, used by the export dialog. */
export function pixelsForPrint(widthInches: number, heightInches: number, dpi: number): [number, number] {
  return [Math.round(widthInches * dpi), Math.round(heightInches * dpi)];
}
