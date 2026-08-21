/**
 * Where the printed sheet is cut (spec §48).
 *
 * "Everything you have drawn" and "the map you want to print" are not the same
 * extent, and on this project they are a long way apart: the document runs from
 * Panama to the high Arctic and from the Aleutians to the mid-Atlantic, which
 * framed as one sheet leaves the part anyone is looking at small in the middle
 * of a great deal of ocean and ice. So the plate is cut at four landmarks, one
 * on each edge.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE POINTS HERE AND NOT JUST FOUR NUMBERS
 * ---------------------------------------------------------------------------
 * A sheet is a rectangle in *projected* space, and this map is drawn on an
 * equal-area azimuthal projection, which bends both the parallels and the
 * meridians into arcs. Cut the document to a latitude/longitude box and the
 * rectangle that holds that box is bounded by its corners, which sit outside
 * the middle of every arc — measured here, 240 km above Anticosti Island and
 * 70 km below Cabo Falso. A sheet asked to stop in the Gulf of St Lawrence
 * printed the southern shore of Hudson Bay instead.
 *
 * Latitude and longitude decide what is *drawn*; these four points decide where
 * the paper is *cut*, by their own projected positions. That is what makes "no
 * further north than Anticosti" true across the whole width of the sheet rather
 * than only at its corners.
 */

/** Cabo Falso, the southern tip of Baja California Sur. */
export const PLATE_SOUTH_POINT: [number, number] = [-109.9, 22.87];

/** The north shore of Anticosti Island, in the Gulf of St Lawrence. */
export const PLATE_NORTH_POINT: [number, number] = [-63.0, 49.95];

/** Cape Mendocino, the westernmost headland of the California coast. */
export const PLATE_WEST_POINT: [number, number] = [-124.41, 40.44];

/** Cape Spear, Newfoundland — the eastern edge of the continent. */
export const PLATE_EAST_POINT: [number, number] = [-52.62, 47.52];

/**
 * A little water past each landmark, as a fraction of the cut span.
 *
 * Cutting exactly on the capes puts Cape Mendocino and Cape Spear onto the
 * frame itself, which reads as a mistake rather than a margin. Two and a half
 * per cent is a strip of ocean wide enough to look deliberate and narrow enough
 * that nobody would call it "far off the coast".
 */
export const PLATE_EDGE_MARGIN = 0.025;

export const PLATE_BOUNDS = {
  south: PLATE_SOUTH_POINT[1],
  north: PLATE_NORTH_POINT[1],
  west: PLATE_WEST_POINT[0],
  east: PLATE_EAST_POINT[0],
};

export interface ProjectedBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Squeeze a projected box down to the four landmarks, plus a margin.
 *
 * `toXY` projects a lon/lat into whatever units the caller is working in, with
 * x increasing east and y increasing north — true of the map view and of the
 * exporter's own projection alike, which is why both can share this. A box
 * already inside a landmark is left where it is: this only ever cuts.
 */
export function clampToPlate(box: ProjectedBox, toXY: (lon: number, lat: number) => [number, number]): ProjectedBox {
  const at = (p: [number, number]) => {
    try {
      const q = toXY(p[0], p[1]);
      return Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
    } catch {
      return null;
    }
  };
  const north = at(PLATE_NORTH_POINT);
  const south = at(PLATE_SOUTH_POINT);
  const west = at(PLATE_WEST_POINT);
  const east = at(PLATE_EAST_POINT);
  if (!north || !south || !west || !east) return box;

  // Which of a pair is the upper bound is a question about the projection, not
  // something to assume from the names.
  const top = Math.max(north[1], south[1]);
  const bottom = Math.min(north[1], south[1]);
  const right = Math.max(west[0], east[0]);
  const left = Math.min(west[0], east[0]);

  const padY = (top - bottom) * PLATE_EDGE_MARGIN;
  const padX = (right - left) * PLATE_EDGE_MARGIN;

  return {
    minX: Math.max(box.minX, left - padX),
    maxX: Math.min(box.maxX, right + padX),
    minY: Math.max(box.minY, bottom - padY),
    maxY: Math.min(box.maxY, top + padY),
  };
}
