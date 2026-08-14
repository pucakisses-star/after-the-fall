/**
 * Projection catalogue and registration (spec §4).
 *
 * The document always stores WGS84 lon/lat. A projection is purely a *view*
 * concern: switching it re-projects on the fly and never touches stored geometry,
 * which is what makes "changing projection should redraw the map while preserving
 * geographic data" true by construction.
 */

import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';
import { get as getOlProjection } from 'ol/proj';
import type { Projection } from 'ol/proj';
import { winkelTripel, naturalEarth } from './winkelTripel';
import type { ProjectionSettings } from '@/model/types';

const R = 6378137; // sphere radius used for the whole-world projections

export interface ProjectionPreset extends ProjectionSettings {
  description: string;
  /** Whole-world projections cannot be tiled or wrapped; used to disable wrapX. */
  global: boolean;
}

/**
 * Build a preset. Extents are the projected bounds of the full graticule,
 * computed lazily on registration so we never hand OpenLayers a stale number.
 */
export const PROJECTION_PRESETS: ProjectionPreset[] = [
  {
    id: 'EPSG:3857',
    name: 'Web Mercator',
    proj4: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
    extent: [-20037508.34, -20048966.1, 20037508.34, 20048966.1],
    units: 'm',
    description: 'Conformal, familiar, wildly distorts high latitudes.',
    global: true,
  },
  {
    id: 'EPSG:4326',
    name: 'Equirectangular (Plate Carrée)',
    proj4: '+proj=longlat +datum=WGS84 +no_defs',
    extent: [-180, -90, 180, 90],
    units: 'degrees',
    description: 'Lat/lon plotted directly. Simple, common in atlases.',
    global: true,
  },
  {
    id: 'ATF:ROBINSON',
    name: 'Robinson',
    proj4: `+proj=robin +lon_0=0 +x_0=0 +y_0=0 +a=${R} +b=${R} +units=m +no_defs`,
    extent: null,
    units: 'm',
    description: 'Compromise world projection. The classic 20th-century atlas look.',
    global: true,
  },
  {
    id: 'ATF:WINKEL3',
    name: 'Winkel Tripel',
    proj4: `+proj=wintri +lon_0=0 +x_0=0 +y_0=0 +a=${R} +b=${R} +units=m +no_defs`,
    extent: null,
    units: 'm',
    description: 'Low overall distortion. Standard for modern reference world maps.',
    global: true,
  },
  {
    id: 'ATF:NATURALEARTH',
    name: 'Natural Earth',
    proj4: `+proj=natearth +lon_0=0 +x_0=0 +y_0=0 +a=${R} +b=${R} +units=m +no_defs`,
    extent: null,
    units: 'm',
    description: 'Rounded pseudocylindrical, gentle on continent shapes.',
    global: true,
  },
  {
    id: 'ATF:MOLLWEIDE',
    name: 'Mollweide',
    proj4: `+proj=moll +lon_0=0 +x_0=0 +y_0=0 +a=${R} +b=${R} +units=m +no_defs`,
    extent: null,
    units: 'm',
    description: 'Equal-area ellipse. Good for distribution maps.',
    global: true,
  },
  {
    id: 'ATF:LCC',
    name: 'Lambert Conformal Conic (N. America)',
    proj4: `+proj=lcc +lat_1=33 +lat_2=45 +lat_0=39 +lon_0=-96 +x_0=0 +y_0=0 +a=${R} +b=${R} +units=m +no_defs`,
    extent: null,
    units: 'm',
    description: 'Conformal conic. The standard choice for mid-latitude regions.',
    global: false,
  },
  {
    id: 'ATF:ALBERS',
    name: 'Albers Equal Area (N. America)',
    proj4: `+proj=aea +lat_1=29.5 +lat_2=45.5 +lat_0=37.5 +lon_0=-96 +x_0=0 +y_0=0 +a=${R} +b=${R} +units=m +no_defs`,
    extent: null,
    units: 'm',
    description: 'Equal-area conic. Areas comparable, angles slightly off.',
    global: false,
  },
  {
    id: 'ATF:ORTHOGRAPHIC',
    name: 'Orthographic (Globe)',
    proj4: `+proj=ortho +lat_0=30 +lon_0=-40 +x_0=0 +y_0=0 +a=${R} +b=${R} +units=m +no_defs`,
    extent: [-R, -R, R, R],
    units: 'm',
    description: 'View from infinity. Shows one hemisphere as a disc.',
    global: false,
  },
];

let registered = false;

/**
 * Install the custom projection algorithms into proj4, define every preset,
 * then hand the whole proj4 registry to OpenLayers.
 *
 * Safe to call repeatedly (the dev server's HMR will).
 */
export function registerProjections(): void {
  if (registered) return;
  registered = true;

  // proj4js exposes `Proj.projections.add` for third-party algorithms.
  const projections = (proj4 as unknown as { Proj: { projections: { add: (p: unknown) => void } } })
    .Proj.projections;
  projections.add(winkelTripel);
  projections.add(naturalEarth);

  for (const preset of PROJECTION_PRESETS) {
    if (preset.id === 'EPSG:3857' || preset.id === 'EPSG:4326') continue; // OL built-ins
    proj4.defs(preset.id, preset.proj4);
  }
  register(proj4);

  // Extents for the pseudocylindricals have to be measured, not guessed, because
  // each one has a different aspect ratio. Sample the outline of the graticule.
  for (const preset of PROJECTION_PRESETS) {
    if (preset.extent) continue;
    preset.extent = measureExtent(preset.id);
    const olProj = getOlProjection(preset.id);
    if (olProj) {
      olProj.setExtent(preset.extent);
      olProj.setGlobal(preset.global);
    }
  }
}

/** Project the boundary of the lon/lat domain and take its bounding box. */
function measureExtent(id: string): [number, number, number, number] {
  const to = proj4('EPSG:4326', id);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (lon: number, lat: number) => {
    try {
      const [x, y] = to.forward([lon, lat]) as [number, number];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    } catch {
      /* points outside the projection domain simply do not contribute */
    }
  };
  for (let lon = -180; lon <= 180; lon += 2) {
    consider(lon, -89.9);
    consider(lon, 89.9);
    consider(lon, 0);
  }
  for (let lat = -89.9; lat <= 89.9; lat += 2) {
    consider(-179.9, lat);
    consider(179.9, lat);
  }
  if (!Number.isFinite(minX)) return [-R, -R, R, R];
  return [minX, minY, maxX, maxY];
}

export function findPreset(id: string): ProjectionPreset | undefined {
  return PROJECTION_PRESETS.find((p) => p.id === id);
}

export function defaultProjection(): ProjectionSettings {
  const p = PROJECTION_PRESETS.find((x) => x.id === 'ATF:LCC')!;
  return { id: p.id, name: p.name, proj4: p.proj4, extent: p.extent, units: p.units };
}

/** Register a user-supplied proj4 string (spec §4: "custom proj4 definitions"). */
export function registerCustomProjection(name: string, def: string): ProjectionSettings {
  const id = `ATF:CUSTOM:${name.replace(/\s+/g, '-').toUpperCase()}`;
  proj4.defs(id, def);
  register(proj4);
  const extent = measureExtent(id);
  const olProj = getOlProjection(id);
  if (olProj) olProj.setExtent(extent);
  return {
    id,
    name,
    proj4: def,
    extent,
    units: /\+units=m\b|\+proj=(merc|lcc|aea|utm|tmerc|stere|laea|ortho|robin|moll|natearth|wintri)/.test(def)
      ? 'm'
      : 'degrees',
  };
}

export function olProjectionFor(settings: ProjectionSettings): Projection {
  registerProjections();
  const p = getOlProjection(settings.id);
  if (!p) {
    // Unknown id in a loaded project — define it from the stored proj4 string.
    proj4.defs(settings.id, settings.proj4);
    register(proj4);
    const retry = getOlProjection(settings.id);
    if (retry) {
      if (settings.extent) retry.setExtent(settings.extent);
      return retry;
    }
    return getOlProjection('EPSG:3857')!;
  }
  if (settings.extent) p.setExtent(settings.extent);
  return p;
}
