/**
 * Shared borders and topology (spec §6).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DESIGN
 * ---------------------------------------------------------------------------
 * There are two ways to guarantee that two adjacent territories never develop
 * gaps or overlaps:
 *
 *   (a) Store a true planar graph — nodes, edges, faces referencing directed edge
 *       rings — and derive polygons from it. Topologically airtight by
 *       construction, but every import, export, boolean op and undo patch then has
 *       to go through the graph, and GeoJSON round-trips stop being trivial.
 *
 *   (b) Store ordinary polygons and *maintain* the invariant: snap while drawing,
 *       propagate edits to coincident vertices in neighbours, and validate/repair
 *       on demand.
 *
 * This module implements (b). Polygons stay the source of truth — which is what
 * keeps the project file plain GeoJSON, the SVG export direct, and undo cheap —
 * while these three mechanisms deliver the behaviour §6 asks for:
 *
 *   1. SNAPPING (`snapPosition`) — new and dragged vertices latch onto existing
 *      vertices and edges, so shared boundaries start out genuinely coincident.
 *   2. PROPAGATION (`propagateVertexEdit`) — when a vertex of territory A moves,
 *      every neighbour that had a vertex at the same place moves with it. This is
 *      the "move the border between Kingdom A and B and both update" requirement.
 *   3. VALIDATION + REPAIR (`validateTopology`, `repairTopology`) — find and fix
 *      whatever slipped through.
 *
 * A future migration to (a) can sit behind this same API.
 * ---------------------------------------------------------------------------
 */

import * as turf from '@turf/turf';
import type { Feature, LineString, Position } from 'geojson';
import { areaKm2, difference, explode, intersection, normalizePoly, ringsOf, union } from './operations';
import type { Poly } from './operations';
import type { Territory, UUID } from '@/model/types';

/** Default coincidence tolerance in degrees (~1.1 m at the equator). */
export const DEFAULT_TOLERANCE = 1e-5;

function key(p: Position, tol: number): string {
  // Quantise to the tolerance grid so "the same corner" hashes identically.
  const q = 1 / tol;
  return `${Math.round(p[0] * q)}|${Math.round(p[1] * q)}`;
}

function samePoint(a: Position, b: Position, tol: number): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
}

// ---------------------------------------------------------------------------
// 1. Snapping (spec §35)
// ---------------------------------------------------------------------------

export interface SnapTarget {
  position: Position;
  kind: 'vertex' | 'edge';
  featureId: UUID | null;
}

export interface SnapIndexEntry {
  id: UUID;
  rings: Position[][];
}

/**
 * A flat list of candidate rings to snap against. Rebuilt when the territory set
 * changes; cheap enough at a few thousand polygons because we only ever query it
 * against a small bbox.
 */
export function buildSnapIndex(territories: Territory[]): SnapIndexEntry[] {
  return territories.map((t) => ({ id: t.id, rings: ringsOf(t.geometry) }));
}

/**
 * Find the best snap target for `p` within `radius` degrees.
 * Vertices win over edges, because latching to an existing corner is what
 * actually produces shared geometry.
 */
export function snapPosition(
  index: SnapIndexEntry[],
  p: Position,
  radius: number,
  excludeId?: UUID,
): SnapTarget | null {
  let bestVertex: { d: number; target: SnapTarget } | null = null;
  let bestEdge: { d: number; target: SnapTarget } | null = null;

  for (const entry of index) {
    if (excludeId && entry.id === excludeId) continue;
    for (const ring of entry.rings) {
      for (let i = 0; i < ring.length; i++) {
        const v = ring[i];
        const dx = v[0] - p[0];
        const dy = v[1] - p[1];
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
        const d = Math.hypot(dx, dy);
        if (d <= radius && (!bestVertex || d < bestVertex.d)) {
          bestVertex = { d, target: { position: [v[0], v[1]], kind: 'vertex', featureId: entry.id } };
        }
      }
      if (bestVertex) continue; // a vertex hit always beats an edge hit
      for (let i = 0; i < ring.length - 1; i++) {
        const proj = projectOntoSegment(p, ring[i], ring[i + 1]);
        if (!proj) continue;
        const d = Math.hypot(proj[0] - p[0], proj[1] - p[1]);
        if (d <= radius && (!bestEdge || d < bestEdge.d)) {
          bestEdge = { d, target: { position: proj, kind: 'edge', featureId: entry.id } };
        }
      }
    }
  }
  return bestVertex?.target ?? bestEdge?.target ?? null;
}

function projectOntoSegment(p: Position, a: Position, b: Position): Position | null {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return null;
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * vx, a[1] + t * vy];
}

// ---------------------------------------------------------------------------
// 2. Shared-vertex propagation — the heart of the shared border system
// ---------------------------------------------------------------------------

export interface VertexMove {
  from: Position;
  to: Position;
}

/**
 * Compare the geometry before and after an edit and report which vertices moved.
 *
 * We match vertices by position in the ring rather than by value, which is exact
 * as long as the edit did not insert or delete vertices. That covers dragging one
 * vertex, dragging several, and translating a whole polygon — the cases where
 * neighbours must follow. When the ring structure changed (a vertex was added or
 * removed) we return `null`: there is no unambiguous correspondence, so the
 * caller skips propagation rather than guessing and corrupting a neighbour.
 */
export function diffVertexMoves(before: Poly, after: Poly, tol = DEFAULT_TOLERANCE): VertexMove[] | null {
  const ringsBefore = ringsOf(before);
  const ringsAfter = ringsOf(after);
  if (ringsBefore.length !== ringsAfter.length) return null;

  const moves: VertexMove[] = [];
  for (let r = 0; r < ringsBefore.length; r++) {
    const rb = ringsBefore[r];
    const ra = ringsAfter[r];
    if (rb.length !== ra.length) return null;
    for (let i = 0; i < rb.length; i++) {
      if (!samePoint(rb[i], ra[i], tol)) moves.push({ from: rb[i], to: ra[i] });
    }
  }
  return moves;
}

/**
 * Apply a set of vertex moves to a polygon, touching only vertices that sit at a
 * `from` position. Returns `null` when nothing changed, so callers can skip
 * writing an identical record.
 */
export function applyVertexMoves(g: Poly, moves: VertexMove[], tol = DEFAULT_TOLERANCE): Poly | null {
  if (moves.length === 0) return null;

  const lookup = new Map<string, Position>();
  for (const m of moves) lookup.set(key(m.from, tol), m.to);

  let changed = false;
  const mapRing = (ring: Position[]): Position[] =>
    ring.map((v) => {
      const hit = lookup.get(key(v, tol));
      if (hit && !samePoint(v, hit, tol)) {
        changed = true;
        return [hit[0], hit[1]];
      }
      return v;
    });

  const next: Poly =
    g.type === 'Polygon'
      ? { type: 'Polygon', coordinates: g.coordinates.map(mapRing) }
      : { type: 'MultiPolygon', coordinates: g.coordinates.map((poly) => poly.map(mapRing)) };

  return changed ? next : null;
}

/**
 * Propagate an edit of one territory into every neighbour that shared the moved
 * vertices. Returns the neighbours' updated geometries, keyed by id.
 *
 * This is what makes a border between two states behave as one border.
 */
export function propagateVertexEdit(
  territories: Territory[],
  editedId: UUID,
  before: Poly,
  after: Poly,
  tol = DEFAULT_TOLERANCE,
): Map<UUID, Poly> {
  const out = new Map<UUID, Poly>();
  const moves = diffVertexMoves(before, after, tol);
  if (!moves || moves.length === 0) return out;

  for (const t of territories) {
    if (t.id === editedId || t.locked) continue;
    const updated = applyVertexMoves(t.geometry, moves, tol);
    if (updated) out.set(t.id, updated);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Validation (spec §6: gap detection, overlap detection)
// ---------------------------------------------------------------------------

export interface TopologyIssue {
  kind: 'overlap' | 'gap' | 'sliver' | 'invalid';
  /** Territories involved. A gap lists its surrounding neighbours. */
  featureIds: UUID[];
  /** Area in km² of the offending region. */
  areaKm2: number;
  geometry: Poly | null;
  message: string;
}

export interface ValidateOptions {
  /** Areas below this are treated as accidental rather than intentional. */
  maxSliverKm2?: number;
  /** Restrict the check to this subset. */
  scopeIds?: Set<UUID>;
}

/**
 * A parent territory legitimately covers its own subdivisions — a Kingdom
 * contains its Duchies — so those pairs must never be reported as overlaps.
 * Only siblings and unrelated territories are compared.
 */
function buildRelatedTest(territories: Territory[]): (a: UUID, b: UUID) => boolean {
  const parentOf = new Map<UUID, UUID | null>(territories.map((t) => [t.id, t.parentId]));

  const ancestors = (id: UUID): Set<UUID> => {
    const out = new Set<UUID>();
    let cur = parentOf.get(id) ?? null;
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return out;
  };

  const cache = new Map<UUID, Set<UUID>>();
  const chain = (id: UUID) => {
    let c = cache.get(id);
    if (!c) {
      c = ancestors(id);
      cache.set(id, c);
    }
    return c;
  };

  return (a, b) => a === b || chain(a).has(b) || chain(b).has(a);
}

/**
 * Find overlaps and gaps in a set of territories.
 *
 * Overlaps are found pairwise, with a bbox pre-filter so the O(n²) loop only
 * pays for pairs that could possibly touch. Gaps are found by unioning everything
 * and inspecting the holes of the result: a hole small enough to be accidental is
 * a sliver gap, a large one is presumably intentional (an inland sea, an
 * unclaimed region) and is reported but not auto-filled.
 */
export function validateTopology(territories: Territory[], opts: ValidateOptions = {}): TopologyIssue[] {
  const maxSliver = opts.maxSliverKm2 ?? 50;
  const scope = opts.scopeIds ? territories.filter((t) => opts.scopeIds!.has(t.id)) : territories;
  const issues: TopologyIssue[] = [];
  const isRelated = buildRelatedTest(territories);

  const boxes = scope.map((t) => {
    try {
      return turf.bbox({ type: 'Feature', properties: {}, geometry: t.geometry });
    } catch {
      return null;
    }
  });

  for (let i = 0; i < scope.length; i++) {
    const a = scope[i];
    const ba = boxes[i];
    if (!ba) {
      issues.push({
        kind: 'invalid',
        featureIds: [a.id],
        areaKm2: 0,
        geometry: null,
        message: `"${a.name}" has unreadable geometry.`,
      });
      continue;
    }
    for (let j = i + 1; j < scope.length; j++) {
      const b = scope[j];
      const bb = boxes[j];
      if (!bb) continue;
      if (isRelated(a.id, b.id)) continue; // a state covering its own divisions
      if (ba[2] < bb[0] || bb[2] < ba[0] || ba[3] < bb[1] || bb[3] < ba[1]) continue;

      const inter = intersection(a.geometry, b.geometry);
      if (!inter) continue;
      const area = areaKm2(inter);
      if (area <= 1e-9) continue;
      issues.push({
        kind: area <= maxSliver ? 'sliver' : 'overlap',
        featureIds: [a.id, b.id],
        areaKm2: area,
        geometry: inter,
        message: `"${a.name}" and "${b.name}" overlap by ${formatArea(area)}.`,
      });
    }
  }

  // Gaps: holes in the dissolved union. Only leaf territories take part — a
  // parent's own footprint would paper over genuine gaps between its children.
  const hasChild = new Set(scope.map((t) => t.parentId).filter((p): p is UUID => !!p));
  const leaves = scope.filter((t) => !hasChild.has(t.id));
  const merged = union((leaves.length ? leaves : scope).map((t) => t.geometry));
  if (merged) {
    for (const part of explode(merged)) {
      // ring 0 is the outer boundary; every subsequent ring is a hole
      for (let r = 1; r < part.coordinates.length; r++) {
        const hole: Poly = { type: 'Polygon', coordinates: [part.coordinates[r]] };
        const area = areaKm2(hole);
        if (area <= 1e-9) continue;
        const touching = scope
          .filter((t) => {
            try {
              return turf.booleanIntersects(
                { type: 'Feature', properties: {}, geometry: t.geometry },
                { type: 'Feature', properties: {}, geometry: hole },
              );
            } catch {
              return false;
            }
          })
          .map((t) => t.id);
        issues.push({
          kind: 'gap',
          featureIds: touching,
          areaKm2: area,
          geometry: hole,
          message:
            area <= maxSliver
              ? `Sliver gap of ${formatArea(area)} between ${touching.length} territories.`
              : `Unclaimed area of ${formatArea(area)} enclosed by ${touching.length} territories.`,
        });
      }
    }
  }

  issues.sort((a, b) => a.areaKm2 - b.areaKm2);
  return issues;
}

export function formatArea(km2: number): string {
  if (km2 < 0.01) return `${(km2 * 1e6).toFixed(0)} m²`;
  if (km2 < 1000) return `${km2.toFixed(2)} km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

// ---------------------------------------------------------------------------
// 4. Repair (spec §6 "Repair Territory Topology", §58)
// ---------------------------------------------------------------------------

export interface RepairOptions {
  /** Vertices closer than this in degrees are welded together. */
  tolerance?: number;
  /** Gaps and overlaps up to this size are fixed; larger ones are left alone. */
  maxSliverKm2?: number;
  weldVertices?: boolean;
  fixOverlaps?: boolean;
  fillGaps?: boolean;
  /** Territories that must not be modified. */
  lockedIds?: Set<UUID>;
}

export interface RepairResult {
  /** Territory id → repaired geometry. Only changed territories appear. */
  changes: Map<UUID, Poly>;
  weldedVertices: number;
  overlapsFixed: number;
  gapsFilled: number;
  log: string[];
}

/**
 * Detect and fix accidental gaps and overlaps.
 *
 * Runs in three passes, ordered so each makes the next one easier:
 *
 *   1. WELD — snap near-coincident vertices between neighbours onto a shared
 *      position. This removes the *cause* of most slivers rather than the symptom.
 *   2. OVERLAPS — where two territories still claim the same ground, the smaller
 *      one yields: subtract the overlap from whichever has less area, on the
 *      reasoning that the larger polygon is the more established one.
 *   3. GAPS — fill remaining sliver holes by handing each to the neighbour that
 *      shares the most boundary with it.
 */
export function repairTopology(territories: Territory[], opts: RepairOptions = {}): RepairResult {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE * 5;
  const maxSliver = opts.maxSliverKm2 ?? 50;
  const locked = opts.lockedIds ?? new Set<UUID>();
  const weld = opts.weldVertices ?? true;
  const fixOverlaps = opts.fixOverlaps ?? true;
  const fillGaps = opts.fillGaps ?? true;

  const working = new Map<UUID, Poly>();
  for (const t of territories) working.set(t.id, t.geometry);
  const nameOf = new Map(territories.map((t) => [t.id, t.name]));
  const result: RepairResult = {
    changes: new Map(),
    weldedVertices: 0,
    overlapsFixed: 0,
    gapsFilled: 0,
    log: [],
  };

  // --- Pass 1: weld near-coincident vertices onto a canonical position ---------
  if (weld) {
    // Bucket every vertex on a grid of `tol`. Any bucket holding vertices from
    // more than one territory (or several distinct positions) collapses to the
    // bucket's mean, which is the shared position all of them then reference.
    const buckets = new Map<string, { pts: Position[]; ids: Set<UUID> }>();
    for (const [id, g] of working) {
      for (const ring of ringsOf(g)) {
        for (const v of ring) {
          const k = key(v, tol);
          let b = buckets.get(k);
          if (!b) {
            b = { pts: [], ids: new Set() };
            buckets.set(k, b);
          }
          b.pts.push(v);
          b.ids.add(id);
        }
      }
    }

    const canonical = new Map<string, Position>();
    for (const [k, b] of buckets) {
      const distinct = new Set(b.pts.map((p) => `${p[0]},${p[1]}`));
      if (distinct.size <= 1) continue; // already exactly coincident
      const mean: Position = [
        b.pts.reduce((s, p) => s + p[0], 0) / b.pts.length,
        b.pts.reduce((s, p) => s + p[1], 0) / b.pts.length,
      ];
      canonical.set(k, mean);
    }

    if (canonical.size > 0) {
      for (const [id, g] of working) {
        if (locked.has(id)) continue;
        let touched = 0;
        const mapRing = (ring: Position[]) =>
          ring.map((v) => {
            const c = canonical.get(key(v, tol));
            if (c && !samePoint(v, c, 1e-12)) {
              touched++;
              return [c[0], c[1]] as Position;
            }
            return v;
          });
        // `mapRing` counts as it goes, so the geometry has to be rebuilt before
        // we can know whether anything actually moved.
        const next: Poly =
          g.type === 'Polygon'
            ? { type: 'Polygon', coordinates: g.coordinates.map(mapRing) }
            : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(mapRing)) };
        if (touched === 0) continue;
        const cleaned = normalizePoly(dedupeConsecutive(next));
        if (cleaned) {
          working.set(id, cleaned);
          result.weldedVertices += touched;
        }
      }
      if (result.weldedVertices > 0) {
        result.log.push(`Welded ${result.weldedVertices} near-coincident vertices (tolerance ${tol}°).`);
      }
    }
  }

  // --- Pass 2: subtract overlaps from the smaller territory --------------------
  if (fixOverlaps) {
    const isRelated = buildRelatedTest(territories);
    const ids = [...working.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        if (isRelated(a, b)) continue; // parent/child containment is intentional
        const ga = working.get(a)!;
        const gb = working.get(b)!;
        const inter = intersection(ga, gb);
        if (!inter) continue;
        const area = areaKm2(inter);
        if (area <= 1e-9 || area > maxSliver) continue;

        // The smaller polygon yields, unless it is locked.
        let loser = areaKm2(ga) <= areaKm2(gb) ? a : b;
        if (locked.has(loser)) loser = loser === a ? b : a;
        if (locked.has(loser)) continue;

        const trimmed = difference(working.get(loser)!, inter);
        if (trimmed) {
          working.set(loser, trimmed);
          result.overlapsFixed++;
          result.log.push(
            `Removed ${formatArea(area)} overlap from "${nameOf.get(loser) ?? loser}".`,
          );
        }
      }
    }
  }

  // --- Pass 3: hand each sliver gap to its dominant neighbour ------------------
  if (fillGaps) {
    const hasChild = new Set(territories.map((t) => t.parentId).filter((p): p is UUID => !!p));
    const leafIds = new Set(territories.filter((t) => !hasChild.has(t.id)).map((t) => t.id));
    const gapScope = leafIds.size ? leafIds : new Set(territories.map((t) => t.id));
    const merged = union([...working.entries()].filter(([id]) => gapScope.has(id)).map(([, g]) => g));
    if (merged) {
      for (const part of explode(merged)) {
        for (let r = 1; r < part.coordinates.length; r++) {
          const hole: Poly = { type: 'Polygon', coordinates: [part.coordinates[r]] };
          const area = areaKm2(hole);
          if (area <= 1e-9 || area > maxSliver) continue;

          // "Dominant neighbour" = the one whose boundary hugs the most of the
          // hole. Approximated by intersecting a slightly grown hole with each
          // candidate and comparing the resulting areas.
          let grown: Poly | null = null;
          try {
            const buffered = turf.buffer(
              { type: 'Feature', properties: {}, geometry: hole } as Feature<Poly>,
              Math.max(0.02, Math.sqrt(area) * 0.1),
              { units: 'kilometers' },
            );
            grown = buffered ? (buffered.geometry as Poly) : null;
          } catch {
            grown = null;
          }

          let best: { id: UUID; score: number } | null = null;
          for (const [id, g] of working) {
            if (locked.has(id) || !gapScope.has(id)) continue;
            const probe = grown ? intersection(grown, g) : intersection(hole, g);
            const score = probe ? areaKm2(probe) : 0;
            if (score > 0 && (!best || score > best.score)) best = { id, score };
          }
          if (!best) continue;

          const filled = union([working.get(best.id)!, hole]);
          if (filled) {
            working.set(best.id, filled);
            result.gapsFilled++;
            result.log.push(
              `Filled ${formatArea(area)} gap into "${nameOf.get(best.id) ?? best.id}".`,
            );
          }
        }
      }
    }
  }

  for (const t of territories) {
    const next = working.get(t.id);
    if (next && next !== t.geometry) result.changes.set(t.id, next);
  }

  // Anything above the sliver limit was deliberately left alone. Say so rather
  // than reporting "nothing wrong" after a check that listed problems — a silent
  // no-op here reads as a failure.
  const remaining = validateTopology(
    territories.map((t) => ({ ...t, geometry: working.get(t.id) ?? t.geometry })),
    { maxSliverKm2: maxSliver },
  ).filter((i) => i.areaKm2 > maxSliver);
  if (remaining.length > 0) {
    const gaps = remaining.filter((i) => i.kind === 'gap').length;
    const overlaps = remaining.length - gaps;
    result.log.push(
      `Left ${remaining.length} region${remaining.length === 1 ? '' : 's'} alone ` +
        `(${gaps} unclaimed area${gaps === 1 ? '' : 's'}, ${overlaps} overlap${overlaps === 1 ? '' : 's'}) — ` +
        `each is larger than the ${formatArea(maxSliver)} sliver limit and is probably intentional. ` +
        `Raise the limit to have them repaired too.`,
    );
  }

  if (result.log.length === 0) result.log.push('No topology problems found.');
  return result;
}

/** Drop repeated consecutive vertices left behind by welding. */
function dedupeConsecutive(g: Poly): Poly {
  const clean = (ring: Position[]): Position[] => {
    const out: Position[] = [];
    for (const v of ring) {
      const last = out[out.length - 1];
      if (!last || last[0] !== v[0] || last[1] !== v[1]) out.push(v);
    }
    // A ring must stay closed and hold at least 3 distinct corners.
    if (out.length >= 2) {
      const first = out[0];
      const last = out[out.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
    }
    return out.length >= 4 ? out : ring;
  };
  return g.type === 'Polygon'
    ? { type: 'Polygon', coordinates: g.coordinates.map(clean) }
    : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(clean)) };
}

// ---------------------------------------------------------------------------
// 5. Derived borders (spec §8, §57)
// ---------------------------------------------------------------------------

export interface DerivedBorder {
  geometry: LineString;
  /** The two territories on either side; `null` means open sea / map edge. */
  left: UUID;
  right: UUID | null;
}

/**
 * Split every territory boundary into the segments it shares with each neighbour,
 * plus the segments it shares with nobody (its outer coast/frontier).
 *
 * This is what §57 needs: once subdivisions are assigned to states, the borders
 * between same-state neighbours can be drawn thin (or hidden) and the borders
 * between differently-assigned neighbours drawn as sovereign lines — all without
 * the user drawing a single line by hand.
 *
 * Implemented by walking each ring's individual segments and asking which other
 * territory carries that same segment. Segments are hashed on their endpoints
 * (order-independent), so exactly-shared edges — the ones snapping and welding
 * produce — match in O(1).
 */
export function deriveBorders(territories: Territory[], tol = DEFAULT_TOLERANCE): DerivedBorder[] {
  const owners = new Map<string, UUID[]>();
  const segments = new Map<string, Position[]>();

  const segKey = (a: Position, b: Position): string => {
    const ka = key(a, tol);
    const kb = key(b, tol);
    return ka < kb ? `${ka}~${kb}` : `${kb}~${ka}`;
  };

  for (const t of territories) {
    for (const ring of ringsOf(t.geometry)) {
      for (let i = 0; i < ring.length - 1; i++) {
        const k = segKey(ring[i], ring[i + 1]);
        const list = owners.get(k);
        if (list) {
          if (!list.includes(t.id)) list.push(t.id);
        } else {
          owners.set(k, [t.id]);
          segments.set(k, [ring[i], ring[i + 1]]);
        }
      }
    }
  }

  const out: DerivedBorder[] = [];
  for (const [k, ids] of owners) {
    const coords = segments.get(k)!;
    out.push({
      geometry: { type: 'LineString', coordinates: [coords[0], coords[1]] },
      left: ids[0],
      right: ids[1] ?? null,
    });
  }
  return out;
}

/**
 * Merge the raw per-segment borders from `deriveBorders` into long polylines,
 * grouping consecutive segments that separate the same pair of territories.
 * Fewer, longer lines mean far fewer draw calls and much better dash rendering.
 */
export function mergeBorderSegments(borders: DerivedBorder[]): DerivedBorder[] {
  const groups = new Map<string, DerivedBorder[]>();
  for (const b of borders) {
    const pair = [b.left, b.right ?? '∅'].sort().join('|');
    const list = groups.get(pair);
    if (list) list.push(b);
    else groups.set(pair, [b]);
  }

  const out: DerivedBorder[] = [];
  for (const [, list] of groups) {
    // Chain segments end-to-start into runs.
    const remaining = new Map<string, DerivedBorder[]>();
    const pk = (p: Position) => key(p, DEFAULT_TOLERANCE);
    for (const b of list) {
      const k = pk(b.geometry.coordinates[0]);
      const arr = remaining.get(k);
      if (arr) arr.push(b);
      else remaining.set(k, [b]);
    }
    const used = new Set<DerivedBorder>();
    for (const b of list) {
      if (used.has(b)) continue;
      used.add(b);
      const coords: Position[] = [...b.geometry.coordinates];
      // extend forward
      for (;;) {
        const tail = coords[coords.length - 1];
        const cands = remaining.get(pk(tail));
        const next = cands?.find((c) => !used.has(c));
        if (!next) break;
        used.add(next);
        coords.push(next.geometry.coordinates[1]);
      }
      out.push({ geometry: { type: 'LineString', coordinates: coords }, left: b.left, right: b.right });
    }
  }
  return out;
}
