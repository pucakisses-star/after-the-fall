/**
 * Redraw the north-east of the After the End map from the Holy Roman Empire of
 * America plate, on real county lines.
 *
 * Run against a dev server: `node tools/northeast.mjs <port>`. It drives the
 * application rather than reimplementing it — the unions, the differences, the
 * recolouring and the record factories are all the app's own, imported in the
 * page — and writes the result back over `public/data/after-the-end.atfmap`.
 *
 * The plate's borders are county borders, so the geometry comes from the
 * shipped 1:10m county dataset rather than from anything grown or drawn. What
 * is transcribed here is the *membership*: which counties belong to which
 * prince. Where the plate shows a patchwork of small states with no legible
 * overlord — most of western New York, the country round Philadelphia — the
 * counties are left sovereign, which is what that patchwork is.
 */

// Playwright is a harness dependency, not the app's; resolved from wherever the
// runner has it rather than added to the project.
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PATH ?? 'playwright',
);
import { writeFileSync } from 'fs';

const port = process.argv[2] ?? '4370';

/**
 * The princes of the north-east, as the plate names them, and the counties each
 * holds. A realm listed with `whole` takes its entire jurisdiction.
 */
const REALMS = [
  // --- New England ---------------------------------------------------------
  { name: 'Duchy of Maine', short: 'Maine', type: 'duchy', whole: '23' },
  { name: 'Electorate of New Hampshire', short: 'New Hampshire', type: 'principality', whole: '33' },
  { name: 'Republic of Vermont', short: 'Vermont', type: 'republic', whole: '50' },
  { name: 'Commonwealth of Massachusetts', short: 'Massachusetts', type: 'republic', whole: '25' },
  { name: 'Duchy of Connecticut', short: 'Connecticut', type: 'duchy', whole: '09' },
  { name: 'Peninsula of Rhodes', short: 'Rhodes', type: 'republic', whole: '44' },

  // --- New York ------------------------------------------------------------
  {
    name: 'Papal States', short: 'Papal States', type: 'theocracy', state: '36',
    counties: ['St. Lawrence', 'Franklin', 'Clinton', 'Essex', 'Hamilton', 'Jefferson', 'Lewis', 'Herkimer'],
  },
  {
    name: 'Duchy of Hudson', short: 'Hudson', type: 'duchy', state: '36',
    counties: ['Albany', 'Rensselaer', 'Columbia', 'Greene', 'Ulster', 'Dutchess', 'Orange', 'Putnam',
      'Rockland', 'Saratoga', 'Schenectady', 'Schoharie', 'Washington', 'Warren', 'Delaware', 'Sullivan'],
  },
  {
    name: 'Most Serene Republic of New York', short: 'New York', type: 'republic', state: '36',
    counties: ['Bronx', 'Kings', 'New York', 'Queens', 'Richmond', 'Nassau', 'Suffolk', 'Westchester'],
  },

  // --- Pennsylvania --------------------------------------------------------
  {
    name: 'Duchy of Scranton', short: 'Scranton', type: 'duchy', state: '42',
    counties: ['Lackawanna', 'Luzerne', 'Wyoming', 'Susquehanna', 'Wayne', 'Pike', 'Monroe', 'Carbon',
      'Bradford', 'Sullivan'],
  },
  {
    name: 'Electorate of the Palatinate', short: 'Palatinate', type: 'principality', state: '42',
    counties: ['Berks', 'Lancaster', 'Lebanon', 'Dauphin', 'York', 'Cumberland', 'Adams', 'Schuylkill',
      'Northumberland', 'Snyder', 'Union', 'Perry', 'Juniata', 'Mifflin', 'Columbia', 'Montour', 'Lycoming'],
  },
  {
    name: 'The Penn States', short: 'Penn States', type: 'confederation', state: '42',
    counties: ['Allegheny', 'Beaver', 'Butler', 'Washington', 'Westmoreland', 'Fayette', 'Greene',
      'Armstrong', 'Indiana', 'Somerset', 'Cambria', 'Clearfield', 'Jefferson', 'Clarion', 'Venango',
      'Mercer', 'Lawrence', 'Crawford', 'Erie', 'Forest', 'Elk', 'McKean', 'Potter', 'Cameron', 'Warren',
      'Blair', 'Bedford', 'Huntingdon', 'Fulton', 'Franklin', 'Centre', 'Clinton', 'Tioga'],
  },

  // --- The mid-Atlantic ----------------------------------------------------
  { name: 'Duchy of Delaware', short: 'Delaware', type: 'duchy', whole: '10' },
  { name: 'Duchy of Columbia', short: 'Columbia', type: 'duchy', whole: '11' },
  { name: 'Landgraviate of Maryland', short: 'Maryland', type: 'principality', whole: '24' },
  { name: 'Duchy of the Jerseys', short: 'Jersey', type: 'duchy', whole: '34' },

  // --- The south of the plate ---------------------------------------------
  { name: 'Kingdom of Virginia', short: 'Virginia', type: 'kingdom', whole: '51' },
  { name: 'Grand Duchy of the Appalachians', short: 'Appalachians', type: 'grand-duchy', whole: '54' },
];

/** Everything the plate's north-east covers, by state FIPS. */
const JURISDICTIONS = ['23', '33', '50', '25', '09', '44', '36', '34', '42', '10', '24', '11', '51', '54'];

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

const serialized = await page.evaluate(async ({ REALMS, JURISDICTIONS }) => {
  const basemap = await import('/src/geo/basemap.ts');
  const ops = await import('/src/geo/operations.ts');
  const palette = await import('/src/geo/palette.ts');
  const store = await import('/src/state/projectStore.ts');
  const commands = await import('/src/state/commands.ts');
  const defaults = await import('/src/model/defaults.ts');
  const file = await import('/src/persistence/projectFile.ts');
  const importers = await import('/src/io/importers.ts');

  const log = (m) => console.log('NE ' + m);

  // --- the counties, as the app itself loads them --------------------------
  //
  // Trimmed to the coastline on the way in, which is not tidiness. The counties
  // are Census cartographic boundaries and the map's coast is Natural Earth's,
  // so their sea edges do not coincide: untrimmed, Maine came out 2.2% over
  // water, and sixty-six of its shoreline runs drew as hard political borders
  // because they were not *on* the coastline the renderer tests against. The
  // same clip every other way of putting ground on this map goes through fixes
  // both at once.
  await importers.coastlinePolygons();
  const features = await basemap.loadBasemap('us-counties');
  const counties = [];
  let sunk = 0;
  for (const f of basemap.polygonsOf(features)) {
    const fips = basemap.basemapFeatureStateFips(f);
    if (!fips || !JURISDICTIONS.includes(fips)) continue;
    const raw = ops.normalizePoly(f.geometry);
    if (!raw || !(ops.areaKm2(raw) > 0)) continue;
    const g = commands.trimToLand(raw);
    if (!g || !(ops.areaKm2(g) > 0)) { sunk++; continue; }
    counties.push({ fips, name: basemap.basemapFeatureName(f) || 'Unnamed', geometry: g });
  }
  log(`counties in the plate's north-east: ${counties.length}${sunk ? ` (${sunk} entirely at sea)` : ''}`);

  // --- the ground they cover, as one shape ---------------------------------
  const region = ops.dissolve(counties.map((c) => c.geometry));
  if (!region) return 'ERROR: could not union the counties';
  log(`region: ${Math.round(ops.areaKm2(region)).toLocaleString()} km²`);

  const project = structuredClone(store.getProject());
  const territoryLayer = Object.values(project.layers).find((l) => l.kind === 'territory');
  const countryLabels = Object.values(project.layers).find((l) => l.name === 'Country Labels');
  const regionLabels = Object.values(project.layers).find((l) => l.name === 'Region Labels');

  // --- clear the ground, without disturbing what lies outside it -----------
  //
  // Subtracted rather than deleted: a realm that reaches from Ohio into
  // Pennsylvania keeps its Ohio half. Only one left holding nothing goes.
  let trimmed = 0;
  let removed = 0;
  for (const t of Object.values(project.territories)) {
    const box = ops.bbox(t.geometry);
    const rb = ops.bbox(region);
    if (box[0] > rb[2] || box[2] < rb[0] || box[1] > rb[3] || box[3] < rb[1]) continue;
    // A realm that was substantially *of* the north-east has been replaced, and
    // goes whole — not whittled to whatever the subtraction happened to leave.
    // Without this the old Republic of New York survived as eighty square
    // kilometres adrift in its own harbour, still drawn and still named.
    const held = ops.intersection(t.geometry, region);
    const share = held ? ops.areaKm2(held) / Math.max(1e-9, ops.areaKm2(t.geometry)) : 0;
    if (share >= 0.9) {
      delete project.territories[t.id];
      if (t.labelId) delete project.labels[t.labelId];
      removed++;
      continue;
    }
    const cut = ops.difference(t.geometry, region);
    // What a subtraction leaves along a shared coast is not ground the realm
    // still holds — the old realm and the new counties are clipped to the same
    // shoreline from different sources, so the difference is a rind of
    // water-edge mismatch. Measured before this floor: eighty square kilometres
    // of "Republic of New York" adrift in Long Island Sound, drawn as a
    // country. Anything under a quarter of the smallest real county here goes.
    const left = cut && ops.removeTinyParts(cut, 25);
    if (!left || !(ops.areaKm2(left) > 25)) {
      delete project.territories[t.id];
      if (t.labelId) delete project.labels[t.labelId];
      removed++;
      continue;
    }
    if (Math.abs(ops.areaKm2(left) - ops.areaKm2(t.geometry)) < 1) continue;
    project.territories[t.id] = { ...t, geometry: left };
    if (t.labelId && project.labels[t.labelId]) {
      const at = ops.interiorPoint(left);
      project.labels[t.labelId] = { ...project.labels[t.labelId], anchor: { type: 'Point', coordinates: at } };
    }
    trimmed++;
  }
  log(`cleared: ${removed} realms removed, ${trimmed} trimmed back`);
  // Anything orphaned by a removal must not keep pointing at a parent that is
  // gone, or the hierarchy has dangling links.
  for (const t of Object.values(project.territories)) {
    if (t.parentId && !project.territories[t.parentId]) {
      project.territories[t.id] = { ...t, parentId: null, ...commands.membershipPatch('sovereign') };
    }
  }

  // --- put the princes in -------------------------------------------------
  const addTerritory = (geometry, init, labelLayerId, labelKind) => {
    const t = store.makeTerritory(project, geometry, { layerId: territoryLayer.id, ...init });
    const label = store.makeLabel(project, { type: 'Point', coordinates: ops.interiorPoint(geometry) }, {
      layerId: labelLayerId,
      kind: labelKind,
      text: t.name,
      attachedToId: t.id,
      styleClassId: labelKind === 'country' ? defaults.STYLE_IDS.textCountry : defaults.STYLE_IDS.textRegion,
    });
    project.territories[t.id] = { ...t, labelId: label.id };
    project.labels[label.id] = label;
    return project.territories[t.id];
  };

  const taken = new Set();
  const key = (c) => `${c.fips}|${c.name}`;
  let realms = 0;
  let vassals = 0;

  for (const realm of REALMS) {
    const mine = realm.whole
      ? counties.filter((c) => c.fips === realm.whole)
      : counties.filter((c) => c.fips === realm.state && realm.counties.includes(c.name));
    if (!mine.length) {
      log(`WARNING: ${realm.name} matched no counties`);
      continue;
    }
    if (!realm.whole) {
      const found = new Set(mine.map((c) => c.name));
      const missing = realm.counties.filter((n) => !found.has(n));
      if (missing.length) log(`WARNING: ${realm.name} — no county named ${missing.join(', ')}`);
    }
    const outline = ops.dissolve(mine.map((c) => c.geometry));
    if (!outline) { log(`WARNING: ${realm.name} would not union`); continue; }

    const parent = addTerritory(outline, {
      name: realm.name,
      shortName: realm.short,
      politicalType: realm.type,
      relationship: 'sovereign',
      parentId: null,
      borderKind: 'international',
    }, countryLabels.id, 'country');
    realms++;

    for (const c of mine) {
      taken.add(key(c));
      addTerritory(c.geometry, {
        name: `County of ${c.name}`,
        shortName: c.name,
        politicalType: 'county',
        parentId: parent.id,
        ...commands.membershipPatch('vassal'),
      }, regionLabels.id, 'region');
      vassals++;
    }
  }

  // --- and the free counties the plate leaves standing alone ---------------
  let free = 0;
  for (const c of counties) {
    if (taken.has(key(c))) continue;
    addTerritory(c.geometry, {
      name: `County of ${c.name}`,
      shortName: c.name,
      politicalType: 'county',
      relationship: 'sovereign',
      parentId: null,
      borderKind: 'international',
    }, regionLabels.id, 'region');
    free++;
  }
  log(`added: ${realms} princes, ${vassals} vassal counties, ${free} free counties`);

  // --- colour, so no two neighbours share a tint ---------------------------
  const all = Object.values(project.territories);
  const colors = palette.recolor(all, (t) => t.styleOverrides.fillColor ?? '#d8d2c4', { mode: 'after-the-event' });
  for (const [id, color] of colors) {
    const t = project.territories[id];
    if (t) project.territories[id] = { ...t, styleOverrides: { ...t.styleOverrides, fillColor: color } };
  }
  log(`total territories: ${Object.keys(project.territories).length}`);

  // --- and does it tile? ---------------------------------------------------
  //
  // Two datasets clipped to the same shore from different sources leave a seam
  // of small overlaps where the new counties meet what was already there. The
  // application has a tool for precisely this, so it is used rather than
  // reimplemented — and the count before and after is reported, because a
  // repair that quietly did nothing looks the same as one that worked.
  const topology = await import('/src/geo/topology.ts');
  const count = () =>
    topology.validateTopology(Object.values(project.territories), { maxSliverKm2: 25 })
      .filter((i) => i.kind !== 'gap');
  const left = count();
  const worst = left.length ? ` (largest ${Math.round(Math.max(...left.map((o) => o.areaKm2)))} km²)` : '';
  log(`overlaps between realms: ${left.length}${worst}`);
  for (const o of left.slice(0, 6)) {
    const names = (o.territoryIds ?? []).map((id) => project.territories[id]?.name ?? '?').join(' / ');
    log(`  ${Math.round(o.areaKm2)} km²: ${names}`);
  }

  return file.serializeProject(project);
}, { REALMS, JURISDICTIONS });

if (serialized.startsWith('ERROR')) {
  console.log(serialized);
  await b.close();
  process.exit(1);
}
// Written minified, as the map is served.
writeFileSync('public/data/after-the-end.atfmap', JSON.stringify(JSON.parse(serialized)));
console.log('written:', (JSON.stringify(JSON.parse(serialized)).length / 1e6).toFixed(2), 'MB');
await b.close();
