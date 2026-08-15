/**
 * Dividing a realm into the states it is made of (spec §7, §57).
 *
 * A political map of a feudal world is two things at once: a realm you perceive
 * at a glance, and a dense internal geography you discover on looking closer.
 * The growth engine gives the first — realms spreading from their capitals until
 * they meet — and on its own it stops there, so a kingdom is one enormous
 * polygon with a small name on it and nothing inside. That reads as a country on
 * a modern political map, not as a crown holding duchies.
 *
 * This grows the inside. It is the same engine, run again with the *realm* as
 * its world: pass a parent's own outline as the land and its towns as the seats,
 * and the members fill it exactly, stopping on its frontier because there is
 * nowhere else for them to go.
 *
 * Reusing the engine rather than cutting the polygon up is the whole point.
 * Members come out with organic frontiers that bend around terrain and settle
 * onto rivers, because that is what the cost field does — where any scheme that
 * partitions a shape directly (a Voronoi diagram of its towns, a k-means split,
 * a recursive bisection) produces exactly the long straight modern-looking edges
 * this is meant to avoid.
 */

import { DEFAULT_GROWTH, growRealms, type LandPolygon, type RealmSeed } from './realmGrowth';
import { areaKm2, bbox } from './operations';
import type { MultiPolygon, Polygon, Position } from 'geojson';

export interface SubdivisionSeat {
  /** What the member is called after — usually its chief town. */
  name: string;
  point: [number, number];
  /** Natural Earth's scalerank, or any measure where lower means more important. */
  rank: number;
}

export interface Subdivision {
  name: string;
  seat: SubdivisionSeat;
  geometry: Polygon | MultiPolygon;
  /** Rank within the parent, 0 being the largest member. */
  order: number;
}

export interface SubdivideOptions {
  /** Lattice spacing in degrees. Finer than the parent's, since the ground is smaller. */
  cellSize?: number;
  /** Rivers, so members settle onto them exactly as realms do. */
  rivers?: Position[][];
  /** Never make more than this many members, however many towns are available. */
  maxMembers?: number;
  /** A member this small is not worth drawing, in km². */
  minAreaKm2?: number;
}

/**
 * How many members a realm of a given size should have.
 *
 * Sub-linear in area on purpose: a realm four times the size gets about twice
 * the members, not four times, because what should grow with a realm is both
 * the number of its divisions *and* their size. Making it linear produces a map
 * of uniformly sized counties everywhere, which is a modern administrative grid
 * rather than a feudal one.
 */
export function memberCountFor(areaKm2Value: number, max = 8): number {
  if (areaKm2Value < 20_000) return 0; // too small to hold anything
  return Math.max(2, Math.min(max, Math.round(Math.sqrt(areaKm2Value / 26_000))));
}

/**
 * Choose which towns become the seats of a realm's members.
 *
 * Two things matter and pull against each other. Important towns make better
 * capitals, and spread-out towns make better-shaped members — take the top N by
 * rank alone and a realm with a cluster of cities in one corner comes out as one
 * huge member and a handful of slivers. So the pick is greedy on rank but
 * refuses any candidate sitting on top of one already chosen, with the exclusion
 * radius set from the realm's own size rather than a fixed distance.
 */
export function pickSeats(
  candidates: SubdivisionSeat[],
  count: number,
  shape: Polygon | MultiPolygon,
): SubdivisionSeat[] {
  if (count <= 0 || !candidates.length) return [];
  const [w, s, e, n] = bbox(shape);
  // A realm split into `count` members has members about this far apart.
  const spacing = Math.max(0.25, Math.min(e - w, n - s) / Math.sqrt(count) / 1.6);

  const byRank = [...candidates].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const chosen: SubdivisionSeat[] = [];
  for (const c of byRank) {
    if (chosen.length >= count) break;
    const lonScale = Math.max(0.2, Math.cos((c.point[1] * Math.PI) / 180));
    const clash = chosen.some((o) => {
      const dx = (o.point[0] - c.point[0]) * lonScale;
      const dy = o.point[1] - c.point[1];
      return Math.hypot(dx, dy) < spacing;
    });
    if (!clash) chosen.push(c);
  }
  // If spacing was too greedy to fill the quota, top up with whatever is left
  // rather than returning a realm with two members because its towns cluster.
  if (chosen.length < Math.min(count, byRank.length)) {
    for (const c of byRank) {
      if (chosen.length >= count) break;
      if (!chosen.includes(c)) chosen.push(c);
    }
  }
  return chosen;
}

/**
 * Grow a realm's members inside it.
 *
 * Returns them largest-first, which is the order the caller wants for handing
 * out ranks: the biggest member of a kingdom is its premier duchy.
 */
export function subdivideRealm(
  shape: Polygon | MultiPolygon,
  seats: SubdivisionSeat[],
  opts: SubdivideOptions = {},
): Subdivision[] {
  if (seats.length < 2) return [];

  const [w, s, e, n] = bbox(shape);
  // Pad so a seat on the very edge still has lattice around it.
  const extent: [number, number, number, number] = [w - 0.2, s - 0.2, e + 0.2, n + 0.2];
  // Coarser than the realm lattice, and on purpose: a member is a fraction of
  // its parent's size, so the same cell count covers it at a larger cell — and
  // this runs once per realm, two hundred times over, where the realm growth
  // runs once for the map.
  const cellSize = opts.cellSize ?? Math.max(0.12, Math.min(0.4, Math.min(e - w, n - s) / 26));

  const land: LandPolygon[] = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  const growthSeeds: RealmSeed[] = seats.map((seat) => ({
    id: seat.name,
    seeds: [seat.point],
    // Members of one realm are peers; a chief town is a little stronger than a
    // market town but not four times the size of one.
    weight: 1 + Math.max(0, 8 - seat.rank) * 0.05,
  }));

  const grown = growRealms(
    land,
    growthSeeds,
    {
      extent,
      ...DEFAULT_GROWTH,
      cellSize,
      // The realm is already divided among its members — there is no wilderness
      // *inside* a kingdom, only between kingdoms.
      coverage: 1,
      // Gentler than at realm scale. A duchy's frontier bends, but a county-sized
      // shape perturbed as hard as a kingdom's comes out as a blot.
      roughness: DEFAULT_GROWTH.roughness * 0.75,
      grain: Math.max(6, DEFAULT_GROWTH.grain / 2),
      // The parent's outline *is* the coast here, so trimming to it is what
      // keeps members exactly inside their realm with no sliver either side.
      clipToCoast: true,
    },
    opts.rivers ?? [],
  );

  const minArea = opts.minAreaKm2 ?? 400;
  const out: Subdivision[] = [];
  for (const seat of seats) {
    const geometry = grown.shapes.get(seat.name);
    if (!geometry) continue;
    if (areaKm2(geometry) < minArea) continue;
    out.push({ name: seat.name, seat, geometry, order: 0 });
  }
  out.sort((a, b) => areaKm2(b.geometry) - areaKm2(a.geometry));
  return out.map((m, i) => ({ ...m, order: i }));
}
