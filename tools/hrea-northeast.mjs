/**
 * Rebuild the north-east of the After the End map from the Holy Roman Empire of
 * America plate — this time from the plate itself.
 *
 * The spec this consumes (`hrea-ne-spec.json`, in the scratchpad) was produced
 * by georeferencing the full-resolution plate against the shipped county mesh,
 * sampling every county's fill colour, merging same-coloured neighbours into
 * polities, and reading each polity's name off the plate. Nothing here is
 * invented: the counties, the memberships, the colours and the titles are all
 * the plate's own.
 *
 * Run against a dev server: `node tools/hrea-northeast.mjs <port> <specPath>`.
 * Writes `public/data/after-the-end.atfmap`.
 */

import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
import { readFileSync, writeFileSync } from 'fs';

const port = process.argv[2] ?? '4370';
const SPEC = JSON.parse(readFileSync(process.argv[3], 'utf8'));

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

const serialized = await page.evaluate(async (SPEC) => {
  const basemap = await import('/src/geo/basemap.ts');
  const ops = await import('/src/geo/operations.ts');
  const store = await import('/src/state/projectStore.ts');
  const commands = await import('/src/state/commands.ts');
  const defaults = await import('/src/model/defaults.ts');
  const file = await import('/src/persistence/projectFile.ts');
  const importers = await import('/src/io/importers.ts');
  const log = (m) => console.log('NE ' + m);

  // --- the counties, trimmed to the map's own coastline ---------------------
  await importers.coastlinePolygons();
  const features = await basemap.loadBasemap('us-counties');
  const geom = new Map();
  const wanted = new Set(SPEC.flatMap((p) => p.counties));
  for (const f of basemap.polygonsOf(features)) {
    const id = String(f.id).padStart(5, '0');
    if (!wanted.has(id)) continue;
    const raw = ops.normalizePoly(f.geometry);
    if (!raw) continue;
    const g = commands.trimToLand(raw);
    if (g && ops.areaKm2(g) > 0) geom.set(id, { g, name: basemap.basemapFeatureName(f) || 'Unnamed' });
  }
  log(`counties with ground: ${geom.size} of ${wanted.size} wanted`);

  const region = ops.dissolve([...geom.values()].map((c) => c.g));
  if (!region) return 'ERROR: no region';
  log(`region: ${Math.round(ops.areaKm2(region)).toLocaleString()} km²`);

  const project = structuredClone(store.getProject());
  const territoryLayer = Object.values(project.layers).find((l) => l.kind === 'territory');
  const countryLabels = Object.values(project.layers).find((l) => l.name === 'Country Labels');
  const regionLabels = Object.values(project.layers).find((l) => l.name === 'Region Labels');

  // --- clear the ground -----------------------------------------------------
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

  // The plate's internal county divisions are faint grey dots, noticed only
  // when looked for. The app's default county border is a full dotted line,
  // and four hundred member counties drawn with it read as a Census atlas
  // laid over the realms rather than as the realms.
  for (const cls of Object.values(project.styles.line)) {
    if (cls.name === 'County border') Object.assign(cls.style, { width: 0.55, opacity: 0.4 });
    if (cls.name === 'Subordinate-state border') Object.assign(cls.style, { width: 0.8, opacity: 0.75 });
  }

  // --- the polities of the plate -------------------------------------------
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
  let made = 0, memberCount = 0;
  // Sovereigns first, then vassal polities, so parents exist when needed.
  const order = [...SPEC.filter((p) => !p.parent), ...SPEC.filter((p) => p.parent)];
  for (const p of order) {
    const parts = p.counties.map((k) => geom.get(k)?.g).filter(Boolean);
    if (!parts.length) { log(`WARNING: ${p.name} has no ground (drowned)`); continue; }
    const outline = ops.dissolve(parts);
    if (!outline) { log(`WARNING: ${p.name} would not union`); continue; }
    const parent = p.parent ? byTemp.get(p.parent) : null;
    const realm = put(outline, {
      name: p.name, shortName: p.short, politicalType: p.type,
      relationship: p.parent ? 'vassal' : 'sovereign',
      parentId: parent ? parent.id : null,
      borderKind: p.parent ? 'subordinate' : 'international',
      styleOverrides: { fillColor: p.color },
      inheritParentColor: false,
      notes: p.notes ?? '',
    }, p.parent ? regionLabels.id : countryLabels.id, p.parent ? 'region' : 'country');
    byTemp.set(p.id, realm);
    made++;
    // Its counties, as constituents — the plate draws these as dotted lines.
    if (p.counties.length > 1) {
      for (const k of p.counties) {
        const c = geom.get(k);
        if (!c) continue;
        put(c.g, {
          name: `County of ${c.name}`, shortName: c.name, politicalType: 'county',
          parentId: realm.id, ...commands.membershipPatch('constituent'),
          // The plate's counties wear their realm's colour exactly — dotted
          // internal borders on one flat fill. The app's inherited tinting
          // would give each county its own shade and wash the plate out.
          inheritParentColor: false,
          styleOverrides: { fillColor: p.color },
          borderKind: 'county',
        }, regionLabels.id, 'region');
        memberCount++;
      }
    }
  }
  // Lieges — personal unions the plate writes in parentheses.
  for (const p of SPEC) {
    if (!p.liege) continue;
    const t = byTemp.get(p.id), l = byTemp.get(p.liege);
    if (t && l) project.territories[t.id] = { ...project.territories[t.id], liegeId: l.id };
  }
  log(`made ${made} polities, ${memberCount} member counties`);
  log(`total territories: ${Object.keys(project.territories).length}`);
  return file.serializeProject(project);
}, SPEC);

if (serialized.startsWith('ERROR')) { console.log(serialized); await b.close(); process.exit(1); }
writeFileSync('public/data/after-the-end.atfmap', JSON.stringify(JSON.parse(serialized)));
console.log('written:', (serialized.length / 1e6).toFixed(1), 'MB pretty →',
  (JSON.stringify(JSON.parse(serialized)).length / 1e6).toFixed(2), 'MB minified');
await b.close();
