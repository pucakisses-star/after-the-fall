/**
 * The lines a fill may not cross (spec §6, §57).
 *
 * A frontier on a real map follows something: a river, the crest of a range, the
 * boundary of the county it was carved out of. The paint bucket is how that gets
 * drawn here — click one side of a river and the realm takes everything up to
 * it — and this is where "a river" stops being a picture and becomes geometry
 * the fill can be stopped by.
 *
 * What counts is what the user can see and has said they mean. A selection is
 * the strongest statement: select a river and it is the only wall. With nothing
 * selected, every line the map is currently drawing counts — the document's own
 * rivers and roads on visible layers, and the reference layers left switched on.
 * Turning a layer off takes it out of the fill, which is the same gesture as
 * taking it off the plate.
 */

import { findBasemapSource, loadBasemap } from './basemap';
import { layerEffective } from '@/model/hierarchy';
import type { MapProject, UUID } from '@/model/types';
import type { Position } from 'geojson';

/**
 * Reference layers whose geometry is a boundary worth stopping at.
 *
 * Water and administrative divisions, not roads or places: a road network runs
 * through every territory it serves and would shatter each fill into the blocks
 * between junctions, which is not a political boundary anybody has ever drawn.
 * Lakes count the same way rivers do — a shoreline is as real a frontier as a
 * channel, and a fill clicked on one bank of a great lake should not swallow
 * the far shore. A lake is a polygon, but `linesOf` reads its rings as the
 * lines they are.
 */
export const BARRIER_ROLES = ['rivers', 'lakes', 'counties', 'states', 'countries'] as const;

/** One human-readable name per barrier layer in play, for the panel and the toast. */
export function barrierSources(project: MapProject): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const entry of project.basemap) {
    if (!entry.visible) continue;
    const source = findBasemapSource(entry.sourceId);
    if (!source?.role) continue;
    if (!(BARRIER_ROLES as readonly string[]).includes(source.role)) continue;
    out.push({ id: source.id, name: source.name });
  }
  return out;
}

/** Every ring and line of a geometry, as bare coordinate arrays. */
function linesOf(geometry: { type: string; coordinates: unknown }): Position[][] {
  switch (geometry.type) {
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates as Position[][];
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat();
    default:
      return [];
  }
}

/**
 * The document's own lines: rivers, roads and coastlines the user has drawn.
 *
 * Label paths are excluded — they are invisible carriers for text, and a name
 * curving through a realm is not a claim about where it ends.
 */
function projectLines(project: MapProject, selection: UUID[]): Position[][] {
  const selected = selection.filter((id) => project.linearFeatures[id]);
  const chosen = selected.length
    ? selected.map((id) => project.linearFeatures[id])
    : Object.values(project.linearFeatures).filter(
        (f) => !f.hidden && layerEffective(project, f.layerId).visible,
      );

  const out: Position[][] = [];
  for (const f of chosen) {
    if (f.kind === 'label-path') continue;
    out.push(...linesOf(f.geometry));
  }
  return out;
}

/**
 * Every line the fill should stop at, in WGS84.
 *
 * Asynchronous because the reference layers are fetched, and memoised by
 * `loadBasemap` — so the first fill of a session pays for the rivers and the
 * rest are immediate. A layer that fails to load is skipped rather than failing
 * the fill: a barrier that is not there is a fill that goes further, which the
 * user can see and undo.
 */
export async function barrierLines(project: MapProject, selection: UUID[] = []): Promise<Position[][]> {
  const own = projectLines(project, selection);
  // An explicit selection is the whole answer: the user pointed at the line they
  // meant, and adding every river on the continent to it would ignore them.
  if (selection.some((id) => project.linearFeatures[id])) return own;

  const lines = [...own];
  for (const source of barrierSources(project)) {
    try {
      for (const f of await loadBasemap(source.id)) lines.push(...linesOf(f.geometry));
    } catch {
      // Reported by the layer panel already; a missing barrier is not a reason
      // to refuse the fill.
    }
  }
  return lines;
}
