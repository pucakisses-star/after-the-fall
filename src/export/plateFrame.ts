/**
 * How far the printed plate reaches, north and south (spec §48).
 *
 * "Everything you have drawn" and "the map you want to print" are not the same
 * extent, and on this project they are a long way apart: the document runs from
 * Panama to the high Arctic, which framed as one sheet leaves the part anyone is
 * looking at small in the middle of a lot of ocean and ice. So the plate is cut
 * to a band named by two landmarks at its edges.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE POINTS HERE AND NOT JUST TWO LATITUDES
 * ---------------------------------------------------------------------------
 * A sheet is a rectangle in *projected* space, and this map is drawn on an
 * equal-area azimuthal projection, which bends the parallels into arcs. Cut the
 * document to the box 22.8°N–50°N and the rectangle that holds that box is
 * bounded by its corners, which are the highest points of the arc — so the
 * finished sheet reaches about 53°N through the middle and prints the southern
 * shore of Hudson Bay above a frame that was asked to stop at Anticosti Island.
 *
 * The latitudes decide what is *drawn*; the two points decide where the paper
 * is *cut*, by their own projected position. That is what makes "no further
 * north than Anticosti" true across the whole width of the sheet rather than
 * only at its corners.
 */

/** Cabo Falso, the southern tip of Baja California Sur. */
export const PLATE_SOUTH_POINT: [number, number] = [-109.9, 22.87];

/** The north shore of Anticosti Island, in the Gulf of St Lawrence. */
export const PLATE_NORTH_POINT: [number, number] = [-63.0, 49.95];

export const PLATE_BOUNDS = {
  south: PLATE_SOUTH_POINT[1],
  north: PLATE_NORTH_POINT[1],
};

/**
 * Squeeze a projected vertical range down to the two landmarks.
 *
 * `toY` projects a lon/lat into whatever vertical units the caller is working
 * in, with north increasing — true of the map view and of the exporter's own
 * projection alike, which is why both can share this.
 */
export function clampToPlateBand(
  minY: number,
  maxY: number,
  toY: (lon: number, lat: number) => number,
): [number, number] {
  const north = toY(PLATE_NORTH_POINT[0], PLATE_NORTH_POINT[1]);
  const south = toY(PLATE_SOUTH_POINT[0], PLATE_SOUTH_POINT[1]);
  if (!Number.isFinite(north) || !Number.isFinite(south)) return [minY, maxY];
  return [Math.max(minY, Math.min(south, north)), Math.min(maxY, Math.max(south, north))];
}
