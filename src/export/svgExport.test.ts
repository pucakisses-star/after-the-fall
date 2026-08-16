/** SVG export (spec §64, §66). */

import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { createProject } from '@/model/project';
import { registerUserSource } from '@/geo/basemap';
import { makeLabel, makeSettlement, makeTerritory } from '@/state/projectStore';
import { DEFAULT_SVG_OPTIONS, exportSvg } from './svgExport';
import { elevationTint, roadRankStyle } from '@/render/olStyles';
import { STYLE_IDS } from '@/model/defaults';
import { resolveSymbolStyle } from '@/model/resolveStyle';
import type { MapProject } from '@/model/types';

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
  };
}

function sampleProject(): MapProject {
  const project = createProject({ title: 'Export Test' });
  // Equirectangular keeps the maths in the test trivially checkable.
  project.projection = {
    id: 'EPSG:4326',
    name: 'Equirectangular',
    proj4: '+proj=longlat +datum=WGS84 +no_defs',
    extent: [-180, -90, 180, 90],
    units: 'degrees',
  };
  project.basemap = [];

  const a = makeTerritory(project, rect(0, 0, 10, 10), {
    name: 'Kingdom of Alpha',
    politicalType: 'kingdom',
    borderKind: 'international',
    // Fully opaque so the exporter emits the hex verbatim rather than rgba().
    styleOverrides: { fillColor: '#aabbcc', fillOpacity: 1 },
  });
  const b = makeTerritory(project, rect(10, 0, 20, 10), {
    name: 'Duchy of Beta',
    politicalType: 'duchy',
    borderKind: 'provincial',
  });
  const disputed = makeTerritory(project, rect(0, 10, 10, 15), {
    name: 'Disputed Zone',
    styleClassId: STYLE_IDS.territoryDisputed,
    borderKind: 'disputed',
  });
  project.territories[a.id] = a;
  project.territories[b.id] = b;
  project.territories[disputed.id] = disputed;

  const city = makeSettlement(project, { type: 'Point', coordinates: [5, 5] }, {
    name: 'Alpha City',
    type: 'national-capital',
  });
  project.settlements[city.id] = city;

  const label = makeLabel(project, { type: 'Point', coordinates: [5, 8] }, {
    kind: 'country',
    text: 'ALPHA',
  });
  project.labels[label.id] = label;

  // A city name as well as a country name: the two are set differently on
  // purpose — a country's sits on its own fill and carries no halo, a city's
  // crosses whatever it lands on and carries one — so a fixture with only one
  // of them cannot check either rule.
  const cityLabel = makeLabel(project, { type: 'Point', coordinates: [5, 5] }, {
    kind: 'city',
    text: 'Alpha City',
    attachedToId: city.id,
    offset: [8, 0],
  });
  project.labels[cityLabel.id] = cityLabel;
  project.settlements[city.id] = { ...city, labelId: cityLabel.id };

  return project;
}

const OPTIONS = {
  ...DEFAULT_SVG_OPTIONS,
  width: 800,
  height: 600,
  extent: [-2, -2, 22, 17] as [number, number, number, number],
};

describe('exportSvg', () => {
  it('produces a well-formed SVG document', async () => {
    const svg = await exportSvg(sampleProject(), OPTIONS);
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="600"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('emits every group named in §66, in order', async () => {
    const svg = await exportSvg(sampleProject(), OPTIONS);
    const expected = [
      'water', 'terrain', 'territories', 'internal-borders', 'international-borders',
      'rivers', 'roads', 'settlements', 'labels', 'graticule', 'legend', 'frame',
    ];
    const positions = expected.map((id) => svg.indexOf(`<g id="${id}"`));
    for (let i = 0; i < expected.length; i++) {
      expect(positions[i], `missing group "${expected[i]}"`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], `group "${expected[i]}" out of order`).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('keeps text as text rather than outlines', async () => {
    const svg = await exportSvg(sampleProject(), OPTIONS);
    expect(svg).toContain('<text');
    expect(svg).toContain('ALPHA');
    // Tracking must survive as a real SVG attribute (§42, §43).
    expect(svg).toContain('letter-spacing=');
    // And where there is a halo it must be painted behind the glyph, not over
    // it — which is the city name, the country name having none.
    expect(svg).toContain('paint-order="stroke"');
  });

  it('writes territories as paths carrying their identity', async () => {
    const project = sampleProject();
    const svg = await exportSvg(project, OPTIONS);
    expect(svg).toContain('data-name="Kingdom of Alpha"');
    expect(svg).toContain('data-type="kingdom"');
    expect(svg).toContain('#aabbcc');
    expect(svg).toContain('<path d="M');
  });

  it('emits a pattern def and references it for hatched territories (§9, §45)', async () => {
    const svg = await exportSvg(sampleProject(), OPTIONS);
    expect(svg).toContain('<defs>');
    expect(svg).toContain('<pattern id="hatch');
    expect(svg).toMatch(/fill="url\(#hatch[^)]*\)"/);
  });

  it('sorts sovereign borders into a different group from internal ones (§8)', async () => {
    const svg = await exportSvg(sampleProject(), OPTIONS);
    const internal = svg.slice(svg.indexOf('<g id="internal-borders"'), svg.indexOf('<g id="international-borders"'));
    const international = svg.slice(
      svg.indexOf('<g id="international-borders"'),
      svg.indexOf('<g id="rivers"'),
    );
    expect(internal).toContain('<path');
    expect(international).toContain('<path');
  });

  it('sets a settlement name clear of its symbol, as the screen does', async () => {
    // The name and the dot are one object, and the export has to agree with the
    // canvas about where the join is or the exported map is not the map you
    // were looking at. SVG needs no measuring — anchoring the start of the run
    // at the symbol's edge is the same statement.
    const project = sampleProject();
    const city = Object.values(project.settlements)[0];
    const label = Object.values(project.labels).find((l) => l.attachedToId === city.id)!;
    const symbol = resolveSymbolStyle(project, city);

    const svg = await exportSvg(project, OPTIONS);
    const element = svg.match(new RegExp(`<text id="label-${label.id}".*?</text>`, 's'))![0];
    expect(element).toContain('text-anchor="start"');

    // And the run starts outside the symbol rather than under it.
    const group = svg.slice(svg.indexOf('<g id="settlements"'), svg.indexOf('<g id="labels"'));
    const symbolX = Number(group.match(/cx="([-\d.]+)"/)![1]);
    const textX = Number(element.match(/<tspan x="([-\d.]+)"/)![1]);
    expect(textX).toBeGreaterThan(symbolX + symbol.size / 2);
  });

  it('draws settlement symbols as real shapes', async () => {
    const svg = await exportSvg(sampleProject(), OPTIONS);
    const settlements = svg.slice(svg.indexOf('<g id="settlements"'), svg.indexOf('<g id="labels"'));
    expect(settlements).toContain('data-name="Alpha City"');
    expect(settlements).toContain('<circle');
  });

  it('includes the graticule only when asked', async () => {
    const without = await exportSvg(sampleProject(), OPTIONS);
    expect(without).toContain('<g id="graticule"></g>');

    const withGrid = await exportSvg(sampleProject(), {
      ...OPTIONS,
      includeGraticule: true,
      graticuleInterval: 5,
    });
    const block = withGrid.slice(withGrid.indexOf('<g id="graticule"'), withGrid.indexOf('<g id="legend"'));
    expect(block).toContain('<path');
    expect(block).toMatch(/\d+°[NSEW]/);
  });

  it('draws a frame and title block when requested', async () => {
    const svg = await exportSvg(sampleProject(), { ...OPTIONS, includeFrame: true, includeTitle: true });
    const frame = svg.slice(svg.indexOf('<g id="frame"'));
    expect(frame).toContain('<rect');
    expect(frame).toContain('EXPORT TEST');
  });

  it('respects the style scale', async () => {
    const small = await exportSvg(sampleProject(), { ...OPTIONS, styleScale: 1 });
    const large = await exportSvg(sampleProject(), { ...OPTIONS, styleScale: 4 });
    const sizeOf = (svg: string) => Number(/font-size="([\d.]+)"/.exec(svg)?.[1] ?? 0);
    expect(sizeOf(large)).toBeGreaterThan(sizeOf(small));
  });

  it('escapes names that would otherwise break the markup', async () => {
    const project = sampleProject();
    const first = Object.values(project.territories)[0];
    project.territories[first.id] = { ...first, name: 'A & B <"tricky">' };
    const svg = await exportSvg(project, OPTIONS);
    expect(svg).toContain('A &amp; B &lt;&quot;tricky&quot;&gt;');
    expect(svg).not.toContain('<"tricky">');
  });

  it('omits features the timeline excludes (§30)', async () => {
    const project = sampleProject();
    project.timeline = { enabled: true, currentYear: 1500, minYear: 1000, maxYear: 1900, step: 1 };
    const first = Object.values(project.territories)[0];
    project.territories[first.id] = { ...first, timeline: { start: 1000, end: 1200 } };

    const svg = await exportSvg(project, OPTIONS);
    expect(svg).not.toContain(`data-name="${first.name}"`);
  });

  it('puts inland water above the political fills, not under them (§17)', async () => {
    // Lakes drawn beneath a territory fill would be invisible; the group order is
    // what guarantees they read as water on a coloured map.
    const project = sampleProject();
    project.basemap = [{ sourceId: 'world-lakes-10m', visible: true, opacity: 1 }];
    const svg = await exportSvg(project, { ...OPTIONS, includeBasemap: true });

    const territories = svg.indexOf('<g id="territories"');
    const water = svg.indexOf('<g id="water-bodies"');
    const borders = svg.indexOf('<g id="internal-borders"');
    // The dataset only loads in a browser, so tolerate it being absent here —
    // but when present it must sit between the fills and the borders.
    if (water > -1) {
      expect(water).toBeGreaterThan(territories);
      expect(water).toBeLessThan(borders);
    }
  });

  it('exports reference cities under the document\'s own settlements (§14, §66)', async () => {
    // Registered in memory: the bundled Natural Earth files only load in a
    // browser, and this is about the export path, not about the fetch.
    registerUserSource(
      {
        id: 'test-places',
        name: 'Test cities',
        url: 'memory://test-places',
        format: 'geojson',
        role: 'places',
      },
      [
        {
          type: 'Feature',
          properties: { name: 'Referenceville', scalerank: 1, labelrank: 1 },
          geometry: { type: 'Point', coordinates: [15, 5] },
        },
      ],
    );
    const project = sampleProject();
    project.basemap = [{ sourceId: 'test-places', visible: true, opacity: 1 }];
    const svg = await exportSvg(project, { ...OPTIONS, includeBasemap: true });

    // The dot, the name as real text, and both inside the settlements group.
    expect(svg).toContain('id="basemap-test-places"');
    expect(svg).toContain('>Referenceville</text>');
    const group = svg.slice(svg.indexOf('<g id="settlements"'), svg.indexOf('<g id="labels"'));
    expect(group).toContain('Referenceville');
    expect(group).toContain('<circle');
    // Reference cities go first so the map's own settlements draw over them.
    expect(group.indexOf('basemap-test-places')).toBeLessThan(group.indexOf('Alpha City'));
  });

  it('drops the names of minor reference cities when zoomed out', async () => {
    registerUserSource(
      {
        id: 'test-places-minor',
        name: 'Test hamlets',
        url: 'memory://test-places-minor',
        format: 'geojson',
        role: 'places',
      },
      [
        {
          type: 'Feature',
          // Well down Natural Earth's hierarchy: scaleranks run 0–10 in the
          // bundled file and labelranks 0–8, so this is a small regional town.
          properties: { name: 'Hamletton', scalerank: 10, labelrank: 5 },
          geometry: { type: 'Point', coordinates: [15, 5] },
        },
      ],
    );
    const project = sampleProject();
    project.basemap = [{ sourceId: 'test-places-minor', visible: true, opacity: 1 }];
    // A whole hemisphere in 400 px: nothing this minor earns a name — or, at
    // this scale, a mark at all.
    const wide = await exportSvg(project, {
      ...OPTIONS,
      width: 400,
      height: 300,
      extent: [-180, -80, 0, 80],
      includeBasemap: true,
    });
    expect(wide).not.toContain('Hamletton');
    expect(wide).not.toContain('id="basemap-test-places-minor"');

    // The same town on a sheet forty kilometres across: marked, and named.
    const close = await exportSvg(project, {
      ...OPTIONS,
      extent: [14.8, 4.8, 15.2, 5.2],
      includeBasemap: true,
    });
    expect(close).toContain('id="basemap-test-places-minor"');
    expect(close).toContain('>Hamletton</text>');
  });

  it('exports reference highways weighted, and thinned by scale (§66)', async () => {
    registerUserSource(
      {
        id: 'test-roads',
        name: 'Test highways',
        url: 'memory://test-roads',
        format: 'geojson',
        role: 'roads',
      },
      [
        {
          type: 'Feature',
          // A trunk route: Natural Earth draws these from zoom 3 out.
          properties: { name: '95', level: 'Interstate', sov_a3: 'USA', min_zoom: 3 },
          geometry: { type: 'LineString', coordinates: [[14.8, 4.8], [15.2, 5.2]] },
        },
        {
          type: 'Feature',
          // A state route: not drawn until you are well in.
          properties: { name: '9', level: 'State', sov_a3: 'USA', min_zoom: 7.1 },
          geometry: { type: 'LineString', coordinates: [[14.9, 4.8], [14.9, 5.2]] },
        },
      ],
    );
    const project = sampleProject();
    project.basemap = [{ sourceId: 'test-roads', visible: true, opacity: 1 }];

    // A sheet forty kilometres across: both roads, and the trunk one heavier.
    const close = await exportSvg(project, {
      ...OPTIONS,
      extent: [14.8, 4.8, 15.2, 5.2],
      includeBasemap: true,
    });
    expect(close).toContain('id="basemap-test-roads"');
    const roads = close.slice(close.indexOf('<g id="roads"'), close.indexOf('<g id="settlements"'));
    const trunk = roadRankStyle('trunk');
    const minor = roadRankStyle('minor');
    expect(roads).toContain(`stroke="${trunk.color}"`);
    expect(roads).toContain(`stroke="${minor.color}"`);
    // Minor first, so trunk routes land on top where they meet.
    expect(roads.indexOf(minor.color)).toBeLessThan(roads.indexOf(trunk.color));

    // A whole hemisphere in 400 px: the interstate survives, the state route
    // does not — otherwise a printed world map carries every road in the file.
    const wide = await exportSvg(project, {
      ...OPTIONS,
      width: 400,
      height: 300,
      extent: [-180, -80, 0, 80],
      includeBasemap: true,
    });
    expect(wide).toContain(`stroke="${trunk.color}"`);
    expect(wide).not.toContain(`stroke="${minor.color}"`);
  });

  it('exports elevation bands lowest-first, under the territories (§66)', async () => {
    registerUserSource(
      {
        id: 'test-elevation',
        name: 'Test relief',
        url: 'memory://test-elevation',
        format: 'geojson',
        role: 'elevation',
      },
      [
        {
          type: 'Feature',
          properties: { band: 2000 },
          geometry: { type: 'Polygon', coordinates: [[[14.9, 4.9], [15.1, 4.9], [15.1, 5.1], [14.9, 5.1], [14.9, 4.9]]] },
        },
        {
          type: 'Feature',
          properties: { band: 200 },
          geometry: { type: 'Polygon', coordinates: [[[14, 4], [16, 4], [16, 6], [14, 6], [14, 4]]] },
        },
      ],
    );
    const project = sampleProject();
    project.basemap = [{ sourceId: 'test-elevation', visible: true, opacity: 1 }];
    const svg = await exportSvg(project, { ...OPTIONS, includeBasemap: true });

    expect(svg).toContain('<g id="elevation">');
    expect(svg).toContain('id="basemap-test-elevation"');
    expect(svg).toContain(`fill="${elevationTint(200)}"`);
    expect(svg).toContain(`fill="${elevationTint(2000)}"`);
    // Lowest band first, so the higher tint paints over it — the same order the
    // screen draws them in, and the reason a band is "at or above" rather than a
    // slice between two thresholds.
    expect(svg.indexOf('data-band="200"')).toBeLessThan(svg.indexOf('data-band="2000"'));
    // And the whole group sits under the political fills.
    expect(svg.indexOf('<g id="elevation">')).toBeLessThan(svg.indexOf('<g id="territories">'));
  });

  it('handles an empty project without throwing', async () => {
    const empty = createProject({ title: 'Empty' });
    empty.basemap = [];
    const svg = await exportSvg(empty, OPTIONS);
    expect(svg).toContain('<g id="territories"></g>');
  });
});
