/**
 * The bundled palettes (spec §21, §22).
 *
 * The graph colourer only promises that *neighbours* differ, so a palette's job
 * is to have enough distinct, well-separated colours that a map of a hundred
 * states does not read as a dozen repeated blocs. These check that property
 * rather than any particular colour.
 */

import { describe, expect, it } from 'vitest';
import { PALETTES, type PaletteMode } from './defaults';
import { colorDistance } from './color';

const MODES = Object.keys(PALETTES) as Exclude<PaletteMode, 'random' | 'monochromatic'>[];

describe('PALETTES', () => {
  it('gives every mode enough colours to go round', () => {
    for (const mode of MODES) {
      expect(PALETTES[mode].length, `${mode} is short`).toBeGreaterThanOrEqual(12);
    }
  });

  it('never repeats a colour within a palette', () => {
    for (const mode of MODES) {
      const seen = new Set(PALETTES[mode].map((c) => c.toLowerCase()));
      expect(seen.size, `${mode} repeats a colour`).toBe(PALETTES[mode].length);
    }
  });

  it('keeps every pair far enough apart to tell two realms apart', () => {
    // Two colours closer than this are one colour to a reader looking at a
    // plate, which defeats the point of carrying both. This caught a genuine
    // pair in `muted` that had been shipping since the palettes were written.
    //
    // `sepia` is held to a lower bar deliberately: it is one ink in many washes,
    // so its colours are separated by lightness alone and cannot be as far apart
    // as a palette that is free to move around the wheel.
    for (const mode of MODES) {
      const floor = mode === 'sepia' ? 11 : 18;
      const p = PALETTES[mode];
      for (let i = 0; i < p.length; i++) {
        for (let j = i + 1; j < p.length; j++) {
          expect(
            colorDistance(p[i], p[j]),
            `${mode}: ${p[i]} and ${p[j]} are indistinguishable`,
          ).toBeGreaterThan(floor);
        }
      }
    }
  });

  it('writes every colour as a six-digit hex', () => {
    for (const mode of MODES) {
      for (const c of PALETTES[mode]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
