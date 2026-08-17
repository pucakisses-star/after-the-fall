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
import { lakePolygons } from '@/io/importers';
import { layerEffective } from '@/model/hierarchy';
import { normalizePoly } from './operations';
import type { Poly } from './operations';
import type { MapProject, UUID } from '@/model/types';
import type { Position } from 'geojson';

/**
 * Reference layers whose geometry is a boundary worth stopping at.
 *
 * Water and administrative divisions, not roads or places: a road network runs
 * through every territory it serves and would shatter each fill into the blocks
 * between junctions, which is not a political boundary anybody has ever drawn.
 * Lakes are listed so the panel names them among the barriers, but they are
 * consumed as water rather than as lines — `barrierWaters` below — because a
 * lake bounds a fill the way the sea does, not the way a river does.
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
 *
 * Lakes are deliberately absent: a lake is not a line but water, and a fill
 * treats it the way it treats the sea — `barrierWaters` below is its half.
 * Cutting a shoreline as a line taught us why: the fill's pocket-healing pass,
 * which repairs the scraps where two barrier lines cross, sees the severed lake
 * as ground that was solid before the cut and quietly pastes it back.
 */
export async function barrierLines(project: MapProject, selection: UUID[] = []): Promise<Position[][]> {
  const own = projectLines(project, selection);
  // An explicit selection is the whole answer: the user pointed at the line they
  // meant, and adding every river on the continent to it would ignore them.
  if (selection.some((id) => project.linearFeatures[id])) return own;

  const lines = [...own];
  for (const source of barrierSources(project)) {
    const role = findBasemapSource(source.id)?.role;
    if (role === 'lakes') continue;
    try {
      for (const f of await loadBasemap(source.id)) lines.push(...linesOf(f.geometry));
    } catch {
      // Reported by the layer panel already; a missing barrier is not a reason
      // to refuse the fill.
    }
  }
  return lines;
}

/**
 * The standing water the fill may not pour over, in WGS84.
 *
 * Lake polygons, subtracted from the fill region the same way the sea already
 * is: a fill clicked on one bank stops at the shore, the far bank is reached
 * only around the ends of the lake — real land connectivity — and the water
 * itself belongs to nobody. Unlike the line barriers this is not a visibility
 * gesture: a lake does not stop being a lake because the layer showing it is
 * hidden, any more than the sea stops being the sea — the same bundled lakes
 * the trim subtracts on every commit.
 */
export async function barrierWaters(): Promise<Poly[]> {
  try {
    const waters: Poly[] = [];
    for (const g of await lakePolygons()) {
      const p = normalizePoly(g as Poly);
      if (p) waters.push(p);
    }
    return waters;
  } catch {
    // Same bargain as above: a missing lake is a fill that goes further.
    return [];
  }
}
