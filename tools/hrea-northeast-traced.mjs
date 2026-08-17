/**
 * Install the traced Holy Roman Empire north-east into the After the End map.
 *
 * The geometry in `tools/hrea-ne-traced.json` is the plate's own drawing:
 * every polity's outline was traced from the full-resolution raster — colour
 * segmentation, ink absorption, marching squares — and mapped to WGS84 through
 * the georeference. No county, state or any other administrative line is used;
 * the borders are the borders the author drew, risen seas included.
 *
 * The county mesh appears exactly once, to bound the ground being replaced: the
 * old map's realms are cleared from the same region the earlier county-based
 * build covered, so the seam with the untouched west and north is unchanged.
 *
 * Run against a dev server: `node tools/hrea-northeast-traced.mjs <port>`.
 * Writes `public/data/after-the-end.atfmap`.
 */

import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
import { readFileSync, writeFileSync } from 'fs';

const port = process.argv[2] ?? '4370';
const TRACED = JSON.parse(readFileSync('tools/hrea-ne-traced.json', 'utf8'));
const SPEC_COUNTIES = JSON.parse(readFileSync('tools/hrea-ne-spec.json', 'utf8'));

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('console', (m) => { if (/^NE/.test(m.text())) console.log('  ' + m.text()); });
page.on('pageerror', (e) => console.log('  PAGE ERROR', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 600; i++) {
  const t = await page.locator('.panel--right').innerText().catch(() => '');
  if (/\d+ territories/.test(t)) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(4000);

const serialized = await page.evaluate(async ({ TRACED, SPEC_COUNTIES }) => {
  const basemap = await import('/src/geo/basemap.ts');
  const ops = await import('/src/geo/operations.ts');
  const store = await import('/src/state/projectStore.ts');
  const commands = await import('/src/state/commands.ts');
  const defaults = await import('/src/model/defaults.ts');
  const file = await import('/src/persistence/projectFile.ts');
  const importers = await import('/src/io/importers.ts');
  const log = (m) => console.log('NE ' + m);

  await importers.coastlinePolygons();

  // --- the ground being replaced: the county-union region, as before --------
  const wanted = new Set(SPEC_COUNTIES.flatMap((p) => p.counties));
  const features = await basemap.loadBasemap('us-counties');
  const parts = [];
  for (const f of basemap.polygonsOf(features)) {
    const id = String(f.id).padStart(5, '0');
    if (!wanted.has(id)) continue;
    const g = ops.normalizePoly(f.geometry);
    if (g) parts.push(g);
  }
  const region = ops.dissolve(parts);
  if (!region) return 'ERROR: no region';
  log(`clearing region: ${Math.round(ops.areaKm2(region)).toLocaleString()} km²`);

  const project = structuredClone(store.getProject());
  const territoryLayer = Object.values(project.layers).find((l) => l.kind === 'territory');
  const countryLabels = Object.values(project.layers).find((l) => l.name === 'Country Labels');
  const regionLabels = Object.values(project.layers).find((l) => l.name === 'Region Labels');

  let removed = 0, trimmed = 0;
  const rb = ops.bbox(region);
  for (const t of Object.values(project.territories)) {
    const box = ops.bbox(t.geometry);
    if (box[0] > rb[2] || box[2] < rb[0] || box[1] > rb[3] || box[3] < rb[1]) continue;
    const held = ops.intersection(t.geometry, region);
    const share = held ? ops.areaKm2(held) / Math.max(1e-9, ops.areaKm2(t.geometry)) : 0;
    if (share >= 0.9) {
      delete project.territories[t.id];
      if (t.labelId) delete project.labels[t.labelId];
      removed++; continue;
    }
    if (share <= 0) continue;
    const cut = ops.difference(t.geometry, region);
    const left = cut && ops.removeTinyParts(cut, 25);
    if (!left || !(ops.areaKm2(left) > 25)) {
      delete project.territories[t.id];
      if (t.labelId) delete project.labels[t.labelId];
      removed++; continue;
    }
    project.territories[t.id] = { ...t, geometry: left };
    if (t.labelId && project.labels[t.labelId]) {
      project.labels[t.labelId] = { ...project.labels[t.labelId],
        anchor: { type: 'Point', coordinates: ops.interiorPoint(left) } };
    }
    trimmed++;
  }
  for (const t of Object.values(project.territories)) {
    if (t.parentId && !project.territories[t.parentId]) {
      project.territories[t.id] = { ...t, parentId: null, ...commands.membershipPatch('sovereign') };
    }
  }
  log(`cleared: ${removed} removed, ${trimmed} trimmed`);

  // --- the polities, exactly as traced --------------------------------------
  const put = (geometry, init, labelLayerId, labelKind) => {
    const t = store.makeTerritory(project, geometry, { layerId: territoryLayer.id, ...init });
    const label = store.makeLabel(project, { type: 'Point', coordinates: ops.interiorPoint(geometry) }, {
      layerId: labelLayerId, kind: labelKind, text: t.name, attachedToId: t.id,
      styleClassId: labelKind === 'country' ? defaults.STYLE_IDS.textCountry : defaults.STYLE_IDS.textRegion,
    });
    project.territories[t.id] = { ...t, labelId: label.id };
    project.labels[label.id] = label;
    return project.territories[t.id];
  };

  const byTemp = new Map();
  let made = 0;
  const order = [...TRACED.filter((p) => !p.parent), ...TRACED.filter((p) => p.parent)];
  for (const p of order) {
    let g = ops.normalizePoly(p.geometry);
    g = g && ops.makeValid(g);
    // Safety clip only: the traced coast is the plate's and lies inside the
    // map's land almost everywhere; the trim cannot widen anything.
    g = g && commands.trimToLand(g);
    if (!g || !(ops.areaKm2(g) > 0)) { log(`WARNING: ${p.name} traced to nothing`); continue; }
    const parent = p.parent ? byTemp.get(p.parent) : null;
    const small = ops.areaKm2(g) < 4000;
    const realm = put(g, {
      name: p.name, shortName: p.short, politicalType: p.type,
      relationship: p.parent ? 'vassal' : 'sovereign',
      parentId: parent ? parent.id : null,
      borderKind: p.parent ? 'subordinate' : 'international',
      styleOverrides: { fillColor: p.color },
      inheritParentColor: false,
      notes: p.notes ?? '',
    }, p.parent || small ? regionLabels.id : countryLabels.id, p.parent || small ? 'region' : 'country');
    byTemp.set(p.id, realm);
    made++;
  }
  for (const p of TRACED) {
    if (!p.liege) continue;
    const t = byTemp.get(p.id), l = byTemp.get(p.liege);
    if (t && l) project.territories[t.id] = { ...project.territories[t.id], liegeId: l.id };
  }
  log(`made ${made} polities (no county subdivisions — the lines are the plate's)`);
  log(`total territories: ${Object.keys(project.territories).length}`);

  for (const cls of Object.values(project.styles.line)) {
    if (cls.name === 'Subordinate-state border') Object.assign(cls.style, { width: 0.8, opacity: 0.75 });
  }
  return file.serializeProject(project);
}, { TRACED, SPEC_COUNTIES });

if (serialized.startsWith('ERROR')) { console.log(serialized); await b.close(); process.exit(1); }
writeFileSync('public/data/after-the-end.atfmap', JSON.stringify(JSON.parse(serialized)));
console.log('written:', (JSON.stringify(JSON.parse(serialized)).length / 1e6).toFixed(2), 'MB');
await b.close();
