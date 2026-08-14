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

/** Coordinate precision. 4 dp is ~11 m — far finer than any of this data. */
const PRECISION = 4;

const DATASETS = [
  { src: 'ne_110m_lakes', out: 'lakes-110m.json', object: 'lakes', quantization: 1e4 },
  { src: 'ne_50m_lakes', out: 'lakes-50m.json', object: 'lakes', quantization: 1e5 },
  { src: 'ne_10m_lakes', out: 'lakes-10m.json', object: 'lakes', quantization: 1e5 },
  { src: 'ne_110m_rivers_lake_centerlines', out: 'rivers-110m.json', object: 'rivers', quantization: 1e4 },
  { src: 'ne_50m_rivers_lake_centerlines', out: 'rivers-50m.json', object: 'rivers', quantization: 1e5 },
  { src: 'ne_10m_rivers_lake_centerlines', out: 'rivers-10m.json', object: 'rivers', quantization: 1e5 },
  { src: 'ne_110m_populated_places', out: 'places-110m.json', object: 'places', quantization: 1e5 },
  { src: 'ne_50m_populated_places', out: 'places-50m.json', object: 'places', quantization: 1e5 },
  { src: 'ne_10m_populated_places', out: 'places-10m.json', object: 'places', quantization: 1e6 },
];

const round = (n) => Number(n.toFixed(PRECISION));

function roundCoords(c) {
  if (typeof c[0] === 'number') return c.slice(0, 2).map(round);
  return c.map(roundCoords);
}

function trim(feature) {
  const props = {};
  for (const key of KEEP) {
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

async function build({ src, out, object, quantization }) {
  const url = `${SOURCE}/${src}.geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  const raw = await res.json();

  const features = raw.features
    .filter((f) => f.geometry?.coordinates?.length)
    .map(trim)
    .filter(Boolean);
  const topo = topology({ [object]: { type: 'FeatureCollection', features } }, quantization);

  const target = path.join(OUT_DIR, out);
  fs.writeFileSync(target, JSON.stringify(topo));

  const before = JSON.stringify(raw).length;
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
