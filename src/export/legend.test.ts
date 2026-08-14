/**
 * Legend and compass rose (spec §26, §28, §64).
 *
 * The property that matters is that the key tells the truth: it lists what the
 * map contains and nothing else, and every swatch is drawn from the same style
 * class the map draws from, so restyling the map restyles the key.
 */

import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { createProject } from '@/model/project';
import { makeSettlement, makeTerritory } from '@/state/projectStore';
import { STYLE_IDS } from '@/model/defaults';
import { DEFAULT_SVG_OPTIONS, exportSvg } from './svgExport';
import { compassToSvg, deriveLegendEntries, legendToSvg } from './legend';
import type { MapProject } from '@/model/types';

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
}

function sample(): MapProject {
  const project = createProject({ title: 'Key Test' });
  project.projection = {
    id: 'EPSG:4326',
    name: 'Equirectangular',
    proj4: '+proj=longlat +datum=WGS84 +no_defs',
    extent: [-180, -90, 180, 90],
    units: 'degrees',
  };
  project.basemap = [];

  const kingdom = makeTerritory(project, rect(0, 0, 10, 10), {
    name: 'Alpha',
    borderKind: 'international',
  });
  const disputed = makeTerritory(project, rect(10, 0, 20, 10), {
    name: 'Contested',
    borderKind: 'disputed',
    styleClassId: STYLE_IDS.territoryDisputed,
  });
  project.territories[kingdom.id] = kingdom;
  project.territories[disputed.id] = disputed;

  const capital = makeSettlement(project, { type: 'Point', coordinates: [5, 5] }, {
    name: 'Alpha City',
    type: 'national-capital',
  });
  project.settlements[capital.id] = capital;
  return project;
}

const OPTIONS = {
  ...DEFAULT_SVG_OPTIONS,
  width: 800,
  height: 600,
  extent: [-2, -2, 22, 12] as [number, number, number, number],
};

describe('deriveLegendEntries', () => {
  it('lists what the map contains', () => {
    const rows = deriveLegendEntries(sample());
    const texts = rows.map((r) => r.text);
    expect(texts).toContain('National capital');
    expect(texts).toContain('International border');
    expect(texts).toContain('Disputed border');
  });

  it('does not list what the map does not contain', () => {
    // The whole point of deriving rather than hard-coding a key.
    const rows = deriveLegendEntries(sample()).map((r) => r.text);
    expect(rows).not.toContain('Fortress');
    expect(rows).not.toContain('Monastery');
    expect(rows).not.toContain('Trade route');
  });

  it('gains a row when the map gains the thing', () => {
    const project = sample();
    const before = deriveLegendEntries(project).length;
    const fort = makeSettlement(project, { type: 'Point', coordinates: [3, 3] }, {
      name: 'The Redoubt',
      type: 'fortress',
      styleClassId: STYLE_IDS.symbolFortress,
    });
    project.settlements[fort.id] = fort;
    const after = deriveLegendEntries(project);
    expect(after.length).toBe(before + 1);
    expect(after.map((r) => r.text)).toContain('Fortress');
  });

  it('explains a hatched fill, which is the one thing a reader cannot guess', () => {
    expect(deriveLegendEntries(sample()).some((r) => r.kind === 'fill')).toBe(true);
  });

  it('gives a row the same id every time, so toggling one does not disturb the rest', () => {
    const project = sample();
    const a = deriveLegendEntries(project);
    const b = deriveLegendEntries(project);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});

describe('legendToSvg', () => {
  it('draws nothing when it is switched off', () => {
    const project = sample();
    expect(legendToSvg(project, { x: 0, y: 0, w: 800, h: 600 }, 1).markup).toEqual([]);
  });

  it('draws a swatch and a caption for every row', () => {
    const project = sample();
    project.legend = { ...project.legend, enabled: true };
    const { markup } = legendToSvg(project, { x: 0, y: 0, w: 800, h: 600 }, 1);
    const svg = markup.join('');
    expect(svg).toContain('National capital');
    expect(svg).toContain('<line'); // the border rules
    expect(svg).toContain('<circle'); // the capital's symbol
  });

  it('reports the pattern its hatched swatch needs, so the def is emitted', () => {
    const project = sample();
    project.legend = { ...project.legend, enabled: true };
    const { markup, patterns } = legendToSvg(project, { x: 0, y: 0, w: 800, h: 600 }, 1);
    expect(patterns.size).toBeGreaterThan(0);
    for (const id of patterns.keys()) expect(markup.join('')).toContain(`url(#${id})`);
  });

  it('takes its swatch from the style class, so restyling the map restyles the key', () => {
    const project = sample();
    project.legend = { ...project.legend, enabled: true };
    const before = legendToSvg(project, { x: 0, y: 0, w: 800, h: 600 }, 1).markup.join('');

    const cls = project.styles.line[STYLE_IDS.lineInternational];
    project.styles = {
      ...project.styles,
      line: {
        ...project.styles.line,
        [STYLE_IDS.lineInternational]: { ...cls, style: { ...cls.style, color: '#ff00aa' } },
      },
    };
    const after = legendToSvg(project, { x: 0, y: 0, w: 800, h: 600 }, 1).markup.join('');

    expect(before).not.toContain('#ff00aa');
    expect(after).toContain('#ff00aa');
  });

  it('honours the user\'s own arrangement once they have taken over', () => {
    const project = sample();
    project.legend = {
      ...project.legend,
      enabled: true,
      auto: false,
      entries: [
        { id: 'a', kind: 'symbol', styleId: STYLE_IDS.symbolCity, text: 'A place', hidden: false },
        { id: 'b', kind: 'symbol', styleId: STYLE_IDS.symbolTown, text: 'Hidden', hidden: true },
      ],
    };
    const svg = legendToSvg(project, { x: 0, y: 0, w: 800, h: 600 }, 1).markup.join('');
    expect(svg).toContain('A place');
    expect(svg).not.toContain('Hidden');
    // The map's own capital is no longer listed, because the list is theirs now.
    expect(svg).not.toContain('National capital');
  });

  it('stays inside the frame in every corner', () => {
    const project = sample();
    const frame = { x: 30, y: 30, w: 740, h: 540 };
    for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      project.legend = { ...project.legend, enabled: true, position };
      const svg = legendToSvg(project, frame, 1).markup.join('');
      const [, x, y, w, h] = /x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg)!.map(Number);
      expect(x, position).toBeGreaterThanOrEqual(frame.x);
      expect(y, position).toBeGreaterThanOrEqual(frame.y);
      expect(x + w, position).toBeLessThanOrEqual(frame.x + frame.w);
      expect(y + h, position).toBeLessThanOrEqual(frame.y + frame.h);
    }
  });
});

describe('the legend in an exported map', () => {
  it('lands in the §66 legend group, not loose in the file', async () => {
    const project = sample();
    project.legend = { ...project.legend, enabled: true };
    const svg = await exportSvg(project, { ...OPTIONS, includeLegend: true });
    const group = svg.slice(svg.indexOf('<g id="legend"'), svg.indexOf('<g id="frame"'));
    expect(group).toContain('National capital');
  });

  it('leaves the group empty when it is not asked for', async () => {
    const svg = await exportSvg(sample(), OPTIONS);
    expect(svg).toContain('<g id="legend"></g>');
  });

  it('emits the pattern def its swatch references', async () => {
    const project = sample();
    project.legend = { ...project.legend, enabled: true };
    const svg = await exportSvg(project, { ...OPTIONS, includeLegend: true });
    const used = [...svg.matchAll(/url\(#(hatch[^)]*)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const id of new Set(used)) expect(svg).toContain(`<pattern id="${id}"`);
  });
});

describe('compassToSvg', () => {
  it('draws nothing when it is switched off', () => {
    expect(compassToSvg({ enabled: false, style: 'star', position: 'top-right', size: 40 }, { x: 0, y: 0, w: 100, h: 100 }, 1)).toEqual([]);
  });

  it('marks north for every style', () => {
    for (const style of ['star', 'rose', 'arrow'] as const) {
      const svg = compassToSvg({ enabled: true, style, position: 'top-right', size: 40 }, { x: 0, y: 0, w: 400, h: 400 }, 1).join('');
      expect(svg, style).toContain('>N</text>');
      expect(svg, style).toContain('<path');
    }
  });

  it('goes into the frame group of an export', async () => {
    const project = sample();
    project.compass = { ...project.compass, enabled: true };
    const svg = await exportSvg(project, { ...OPTIONS, includeCompass: true });
    const frame = svg.slice(svg.indexOf('<g id="frame"'));
    expect(frame).toContain('id="compass"');
  });
});

describe('reference geography in the key', () => {
  it('explains the water it draws from the reference layers', () => {
    const project = sample();
    project.basemap = [
      { sourceId: 'world-rivers-10m', visible: true, opacity: 1 },
      { sourceId: 'world-lakes-10m', visible: true, opacity: 1 },
    ];
    const rows = deriveLegendEntries(project).map((r) => r.text);
    expect(rows).toContain('River');
    expect(rows).toContain('Lake');
  });

  it('says nothing about layers that are switched off', () => {
    const project = sample();
    project.basemap = [{ sourceId: 'world-rivers-10m', visible: false, opacity: 1 }];
    expect(deriveLegendEntries(project).map((r) => r.text)).not.toContain('River');
  });
});
