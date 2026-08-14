#!/usr/bin/env node
/**
 * Rebuilds the bundled lake, river and populated-place datasets in
 * `public/data/world/`.
 *
 * Natural Earth publishes these as GeoJSON with ~60 localised name fields per
 * feature, which is most of the file size and none of the value here. This
 * fetches them, keeps the handful of properties the app actually reads, and
 * converts to quantized TopoJSON — typically a 5–10× reduction.
 *
 * The coastline and country files come from the `world-atlas` package instead
 * (see README); only these need this step, because world-atlas does not publish
 * lakes, rivers or cities.
 *
 *   node scripts/build-basemaps.mjs
 *
 * Data is Natural Earth, public domain. Re-run only when you want to refresh it;
 * the output is committed so a clone needs no network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { topology } from 'topojson-server';

const SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const OUT_DIR = path.resolve('public/data/world');

/**
 * Properties worth keeping. Everything else is dropped — Natural Earth carries
 * ~60 localised name fields per feature, which is most of the file size and none
 * of the value here. Populated places use SHOUTED keys, hence both spellings.
 */
const KEEP = [
  'name', 'name_en', 'featurecla', 'scalerank', 'min_zoom',
  'NAME', 'FEATURECLA', 'SCALERANK', 'LABELRANK', 'POP_MAX', 'ADM0NAME', 'ADM1NAME',
];

/**
 * Extra properties for the admin-1 files: which country a province belongs to,
 * and what that country calls the tier (state, province, territory,
 * departamento…). Kept per-dataset rather than globally, because `admin` also
 * exists on lakes and would quietly bloat every water file with it.
 */
const KEEP_ADMIN1 = ['iso_3166_2', 'adm0_a3', 'admin', 'type_en'];

/**
 * Extra properties for the roads file.
 *
 * `type` and `level` separate an interstate from a state route, which is the
 * whole basis for drawing one heavier than the other. `prefix` plus the `name`
 * already in KEEP is the route number a reader recognises: Natural Earth stores
 * "I" and "95" apart, and its own `label` field is null for every road in the
 * Americas, so the shield has to be assembled from the two. It also fills the
 * prefix in on only 96 of the 1,352 interstates, which is why `sov_a3` is here
 * — the country plus the level says "I" or "US" for the rest of them, and says
 * nothing for a Mexican federal route, which is the correct answer there.
 * `min_label` says how far in you have to be before the number is worth drawing.
 */
const KEEP_ROADS = ['type', 'level', 'prefix', 'sov_a3', 'min_label'];

/** Coordinate precision. 4 dp is ~11 m — far finer than any of this data. */
const PRECISION = 4;

/**
 * One scale only: 1:10m, the finest Natural Earth publishes. The 1:110m and
 * 1:50m editions used to be built here too and offered as separate overlays,
 * which meant three entries in the layer list for every kind of geography and
 * a choice nobody wanted to make. Bundling only the detailed files costs a few
 * megabytes and removes the decision.
 */
const DATASETS = [
  // Lakes, plus the two regional supplements.
  //
  // Natural Earth's main lakes file stops at scalerank 9, which is a bigger lake
  // than it sounds: Atitlán, Tahoe and most of the Adirondacks are not in it. The
  // supplements are ranks 10–12 and nothing else — 1,162 more in North America
  // and 767 in Europe, with no `ne_id` shared with the main file and no lake
  // appearing twice. They are separate downloads rather than separate layers,
  // because "small lakes" is not a kind of geography anyone wants to toggle
  // independently of lakes.
  {
    src: ['ne_10m_lakes', 'ne_10m_lakes_north_america', 'ne_10m_lakes_europe'],
    out: 'lakes-10m.json',
    object: 'lakes',
    quantization: 1e5,
  },
  { src: 'ne_10m_rivers_lake_centerlines', out: 'rivers-10m.json', object: 'rivers', quantization: 1e5 },
  { src: 'ne_10m_populated_places', out: 'places-10m.json', object: 'places', quantization: 1e6 },
  // The highway network, cut to the trunk system of the Americas.
  //
  // Natural Earth's roads file is 56,600 features and 14 MB of TopoJSON, most of
  // it Eurasia and most of the rest classed "Unknown" or plain "Road" — local
  // lanes that no political map draws. Interstates, national highways, the
  // beltways round the big cities and their equivalents in Canada, Mexico and
  // South America come to a tenth of that, and are the level a map at this scale
  // actually wants.
  {
    src: 'ne_10m_roads',
    out: 'roads-10m.json',
    object: 'roads',
    quantization: 1e5,
    roads: true,
    continents: ['North America', 'North America x-fade', 'South America'],
    types: ['Major Highway', 'Secondary Highway', 'Beltway', 'Bypass'],
  },
  // Provinces, states and territories — the only way to build a realm out of
  // real administrative units anywhere but the United States, which is the one
  // place the Census files already cover. Filtered to the Americas: the whole
  // world at 1:10m is 4,596 subdivisions and close to 5 MB, which is too much
  // to bundle for a map of one hemisphere. Anyone mapping provinces of
  // somewhere else can import the Natural Earth file directly.
  {
    src: 'ne_10m_admin_1_states_provinces',
    out: 'admin1-na-10m.json',
    object: 'admin1',
    quantization: 1e5,
    admin1: true,
    countries: [
      'USA', 'CAN', 'MEX', 'GRL',
      'GTM', 'BLZ', 'HND', 'SLV', 'NIC', 'CRI', 'PAN',
      'CUB', 'DOM', 'HTI', 'JAM', 'BHS', 'PRI', 'TTO',
    ],
  },
];

const round = (n) => Number(n.toFixed(PRECISION));

function roundCoords(c) {
  if (typeof c[0] === 'number') return c.slice(0, 2).map(round);
  return c.map(roundCoords);
}

function trim(feature, keep) {
  const props = {};
  for (const key of keep) {
    const v = feature.properties?.[key];
    if (v !== null && v !== undefined && v !== '') props[key.toLowerCase()] = v;
  }
  // Natural Earth leaves the English name off when it matches `name`.
  if (props.name_en === props.name) delete props.name_en;
  // Scientific stations and one lone "historic place" are not settlements.
  if (props.featurecla === 'Scientific station') return null;
  return {
    type: 'Feature',
    properties: props,
    geometry: { ...feature.geometry, coordinates: roundCoords(feature.geometry.coordinates) },
  };
}

async function build({ src, out, object, quantization, countries, admin1, roads, continents, types }) {
  const keep = [...KEEP, ...(admin1 ? KEEP_ADMIN1 : []), ...(roads ? KEEP_ROADS : [])];
  // One output file may be built from several Natural Earth ones — the lakes
  // supplements are published apart but belong in the same layer.
  const sources = Array.isArray(src) ? src : [src];

  const wanted = countries ? new Set(countries) : null;
  const onlyIn = continents ? new Set(continents) : null;
  const onlyKind = types ? new Set(types) : null;

  let before = 0;
  const features = [];
  for (const name of sources) {
    const res = await fetch(`${SOURCE}/${name}.geojson`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const raw = await res.json();
    before += JSON.stringify(raw).length;
    features.push(
      ...raw.features
        .filter((f) => f.geometry?.coordinates?.length)
        .filter((f) => !wanted || wanted.has(f.properties?.adm0_a3))
        .filter((f) => !onlyIn || onlyIn.has(f.properties?.continent))
        .filter((f) => !onlyKind || onlyKind.has(f.properties?.type))
        .map((f) => trim(f, keep))
        .filter(Boolean),
    );
  }
  const topo = topology({ [object]: { type: 'FeatureCollection', features } }, quantization);

  const target = path.join(OUT_DIR, out);
  fs.writeFileSync(target, JSON.stringify(topo));

  const after = fs.statSync(target).size;
  console.log(
    `${out.padEnd(18)} ${String(features.length).padStart(5)} features  ` +
      `${(before / 1048576).toFixed(1)} MB → ${(after / 1024).toFixed(0)} KB  ` +
      `(${(before / after).toFixed(1)}× smaller)`,
  );
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const d of DATASETS) await build(d);
console.log('\nDone. Commit public/data/world/ to keep clones offline-capable.');
