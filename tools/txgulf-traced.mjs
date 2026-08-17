/**
 * Install the traced Texas & Western Gulfcoast realms into the After the End map.
 *
 * The geometry in `tools/txgulf-traced.json` is the plate's own drawing: every
 * realm outline was traced from the full-resolution raster — colour
 * segmentation guided by the previous build's footprints, ink absorption,
 * marching squares — and mapped to WGS84 through a graticule-fitted conic.
 *
 * The previous build's realm union bounds the ground being replaced, so the
 * seam with untouched neighbours is unchanged: the traced shapes are clipped
 * to that union, and where an old realm ran past the plate's frame the old
 * shape is kept beyond it.
 *
 * Run against a dev server: `node tools/txgulf-traced.mjs <port>`.
 * Writes `public/data/after-the-end.atfmap`.
 */

import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
import { readFileSync, writeFileSync } from 'fs';

const port = process.argv[2] ?? '4370';
const SPEC = JSON.parse(readFileSync('tools/txgulf-traced.json', 'utf8'));

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('console', (m) => { if (/^TX/.test(m.text())) console.log('  ' + m.text()); });
page.on('pageerror', (e) => console.log('  PAGE ERROR', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 600; i++) {
  const t = await page.locator('.panel--right').innerText().catch(() => '');
  if (/\d+ territories/.test(t)) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(4000);

const serialized = await page.evaluate(async (SPEC) => {
  const ops = await import('/src/geo/operations.ts');
  const store = await import('/src/state/projectStore.ts');
  const commands = await import('/src/state/commands.ts');
  const defaults = await import('/src/model/defaults.ts');
  const file = await import('/src/persistence/projectFile.ts');
  const importers = await import('/src/io/importers.ts');
  const log = (m) => console.log('TX ' + m);

  await importers.coastlinePolygons();

  const project = structuredClone(store.getProject());
  const territoryLayer = Object.values(project.layers).find((l) => l.kind === 'territory');
  const countryLabels = Object.values(project.layers).find((l) => l.name === 'Country Labels');
  const regionLabels = Object.values(project.layers).find((l) => l.name === 'Region Labels');

  // --- the ground being replaced: the union of the realms' current shapes ---
  const oldGeom = new Map();
  for (const r of SPEC.realms) {
    const t = Object.values(project.territories).find((t) => t.name === r.name);
    if (t) oldGeom.set(r.name, t.geometry);
    else log(`WARNING: ${r.name} not in current map`);
  }
  const region = ops.dissolve([...oldGeom.values()].map((g) => ops.normalizePoly(g)).filter(Boolean));
  if (!region) return 'ERROR: no region';
  log(`clearing region: ${Math.round(ops.areaKm2(region)).toLocaleString()} km²`);
  const frame = ops.normalizePoly({ type: 'Polygon', coordinates: [SPEC.frame] });

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

  // --- the realms, exactly as traced ---------------------------------------
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

  let made = 0;
  for (const r of SPEC.realms) {
    let g = ops.normalizePoly(r.geometry);
    g = g && ops.makeValid(g);
    g = g && ops.intersection(g, region);
    const old = oldGeom.get(r.name);
    if (old && frame) {
      // keep the old shape wherever it ran beyond the plate's mapped frame
      const beyond = ops.difference(ops.normalizePoly(old), frame);
      if (beyond && ops.areaKm2(beyond) > 25) g = g ? ops.dissolve([g, beyond]) : beyond;
    }
    g = g && ops.removeTinyParts(g, 25);
    g = g && commands.trimToLand(g);
    if (!g || !(ops.areaKm2(g) > 0)) { log(`WARNING: ${r.name} traced to nothing`); continue; }
    const small = ops.areaKm2(g) < 4000;
    put(g, {
      name: r.name, shortName: r.short, politicalType: r.type,
      relationship: 'sovereign', parentId: null,
      borderKind: 'international',
      styleOverrides: { fillColor: r.color },
      inheritParentColor: false,
      notes: r.notes ?? '',
    }, small ? regionLabels.id : countryLabels.id, small ? 'region' : 'country');
    made++;
  }
  log(`made ${made} realms (no subdivisions — the lines are the plate's)`);
  log(`total territories: ${Object.keys(project.territories).length}`);
  return file.serializeProject(project);
}, SPEC);

if (serialized.startsWith('ERROR')) { console.log(serialized); await b.close(); process.exit(1); }
writeFileSync('public/data/after-the-end.atfmap', JSON.stringify(JSON.parse(serialized)));
console.log('written:', (JSON.stringify(JSON.parse(serialized)).length / 1e6).toFixed(2), 'MB');
await b.close();
