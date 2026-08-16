/**
 * Derived political borders (spec §8, §57).
 *
 * Territories store *areas*, not boundaries. The lines between them are computed:
 * every boundary segment is classified by looking at who is on each side.
 *
 *   • two territories under the same sovereign → the finer of their two border
 *     weights (an internal provincial hairline)
 *   • two territories under different sovereigns → the heavier weight (a
 *     sovereign border)
 *   • nobody on the other side → that territory's own border weight (its coast
 *     or outer frontier)
 *
 * That single rule is what §57 asks for: assign counties to states, and the
 * national borders appear and disappear on their own.
 *
 * The result is memoised on the identity of the territories record, so panning
 * and zooming never recompute it.
 */

import { borderWeightFor } from '@/model/defaults';
import { sovereignOf } from '@/model/hierarchy';
import { visibleInTime } from '@/model/timeline';
import { deriveBorders, mergeBorderSegments } from '@/geo/topology';
import { indexLand, landContains, landPolygonsOf, type LandIndex } from '@/geo/coastline';
import { coastlinePolygons } from '@/io/importers';
import type { BorderStyleKind, MapProject, Territory, UUID } from '@/model/types';
import type { LineString, Position } from 'geojson';

export interface ClassifiedBorder {
  geometry: LineString;
  kind: BorderStyleKind;
  /**
   * This run lies along the coastline: land on one side, open water on the
   * other. Not a border anybody drew — it is where the country stops because
   * the ground does — so the renderers leave it to the coastline rather than
   * stroking a political line over the sea's edge.
   */
  coastal: boolean;
  /** Territories on each side, for hit-testing and inspection. */
  left: UUID;
  right: UUID | null;
}

let cacheKey: unknown = null;
let cacheTimeKey: string | null = null;
let cacheValue: ClassifiedBorder[] = [];

// ---------------------------------------------------------------------------
// The coastline, for telling a coast from a frontier
// ---------------------------------------------------------------------------

/**
 * Bumped when the coastline arrives, so callers that cache derived borders can
 * fold it into their key and reclassify once the coast is known.
 */
export let coastGeneration = 0;

const coastListeners = new Set<() => void>();

/**
 * Run `cb` when the coastline finishes loading, so a renderer that has already
 * drawn the borders once can redraw them classified. Returns an unsubscribe.
 */
export function onCoastReady(cb: () => void): () => void {
  coastListeners.add(cb);
  return () => coastListeners.delete(cb);
}

let coastIndex: LandIndex | null | undefined;

function requestCoast(): void {
  if (coastIndex !== undefined) return;
  coastIndex = null;
  coastlinePolygons()
    .then((land) => {
      coastIndex = indexLand(landPolygonsOf(land), [-180, -90, 180, 90]);
      invalidateBorderCache();
      coastGeneration++;
      for (const cb of coastListeners) cb();
    })
    .catch(() => {
      // No coastline — a headless test, or the fetch failed. Everything is a
      // frontier then, which is the drawing this map always made.
    });
}

/**
 * How far to either side of a border the ground is sampled, in degrees.
 *
 * Two scales, because one cannot cover both errors. A probe long enough to be
 * safely clear of the line reaches the far shore of a narrow strait — Discovery
 * Passage is two kilometres wide — and reads land on both sides, giving the
 * strait's coast a frontier's hard stroke. A short probe resolves the strait
 * but sits closer to the data's own noise. So the near probe is asked first and
 * the far one is the fallback, and a segment is a coast if either sees water on
 * exactly one side.
 */
const COAST_PROBES = [0.002, 0.01];
/**
 * A stretch shorter than this many segments flips to match its neighbours.
 *
 * The probes read the ground a kilometre out to each side, and at a river mouth
 * or across a spit that reading flickers for a segment or two. Without the
 * smoothing the flicker draws: a run of coast grows a few isolated dashes of
 * hard border where a creek happened to sit beside it.
 */
const COAST_SMOOTH = 3;

/**
 * Split a one-sided border into its coastal and frontier stretches.
 *
 * One run cannot simply be voted on. A territory reaching the sea has a single
 * merged outline run — same owner on the left, nobody on the right, all the way
 * round — so its coast and its inland frontier arrive as one line, and a vote
 * either strokes the coast or silences the frontier, whichever is longer.
 * Measured on the demonstration map's Baja: one 778-point run around the whole
 * peninsula tip, coast and frontier together, drawn all-soft by the vote.
 *
 * So each segment is classified on its own — land to one side and water to the
 * other is coast — and consecutive segments of a kind become one stretch.
 */
export function splitByCoast(
  line: LineString,
  land: LandIndex,
): { coastal: boolean; geometry: LineString }[] {
  const ring = line.coordinates;
  if (ring.length < 2) return [{ coastal: false, geometry: line }];

  const kinds: boolean[] = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) {
      kinds.push(kinds[kinds.length - 1] ?? false);
      continue;
    }
    const mid: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let coastal = false;
    for (const probe of COAST_PROBES) {
      const nx = (-dy / len) * probe;
      const ny = (dx / len) * probe;
      const one = landContains(land, [mid[0] + nx, mid[1] + ny]);
      const two = landContains(land, [mid[0] - nx, mid[1] - ny]);
      if (one !== two) {
        coastal = true;
        break;
      }
    }
    kinds.push(coastal);
  }

  // Flip stretches too short to mean anything.
  for (let i = 0; i < kinds.length; ) {
    let j = i;
    while (j < kinds.length && kinds[j] === kinds[i]) j++;
    if (j - i < COAST_SMOOTH && (i > 0 || j < kinds.length)) {
      const fill = i > 0 ? kinds[i - 1] : kinds[j];
      for (let k = i; k < j; k++) kinds[k] = fill;
    }
    i = j;
  }

  const out: { coastal: boolean; geometry: LineString }[] = [];
  let start = 0;
  for (let i = 1; i <= kinds.length; i++) {
    if (i === kinds.length || kinds[i] !== kinds[start]) {
      out.push({
        coastal: kinds[start],
        geometry: { type: 'LineString', coordinates: ring.slice(start, i + 1) },
      });
      start = i;
    }
  }
  return out;
}

export function computeBorders(project: MapProject): ClassifiedBorder[] {
  requestCoast();
  const timeKey = project.timeline.enabled ? String(project.timeline.currentYear) : 'all';
  if (cacheKey === project.territories && cacheTimeKey === timeKey) return cacheValue;

  const territories = Object.values(project.territories).filter(
    (t) => !t.hidden && visibleInTime(t.timeline, project.timeline),
  );
  const byId = new Map<UUID, Territory>(territories.map((t) => [t.id, t]));

  const raw = mergeBorderSegments(deriveBorders(territories));
  const out: ClassifiedBorder[] = [];

  for (const b of raw) {
    const left = byId.get(b.left);
    if (!left) continue;
    const right = b.right ? byId.get(b.right) : undefined;

    let kind: BorderStyleKind;
    if (!right) {
      kind = left.borderKind;
      // Only a one-sided run can be a coast: where two territories meet, the
      // line between them is a border whatever ground it crosses. One run can
      // be both in turn — a coast and then an inland frontier — so it is split
      // rather than judged whole.
      if (coastIndex) {
        for (const piece of splitByCoast(b.geometry, coastIndex)) {
          out.push({ geometry: piece.geometry, kind, coastal: piece.coastal, left: b.left, right: b.right });
        }
        continue;
      }
    } else {
      const sovL = sovereignOf(project, left.id)?.id;
      const sovR = sovereignOf(project, right.id)?.id;
      if (sovL && sovR && sovL === sovR) {
        // Same state either side — draw the quieter of the two lines.
        kind =
          borderWeightFor(left.borderKind) <= borderWeightFor(right.borderKind)
            ? left.borderKind
            : right.borderKind;
      } else {
        // Different states — the border is as strong as the stronger claim.
        kind =
          borderWeightFor(left.borderKind) >= borderWeightFor(right.borderKind)
            ? left.borderKind
            : right.borderKind;
      }
    }

    out.push({ geometry: b.geometry, kind, coastal: false, left: b.left, right: b.right });
  }

  // Draw quiet lines first so heavy sovereign borders land on top of them.
  out.sort((a, b) => borderWeightFor(a.kind) - borderWeightFor(b.kind));

  cacheKey = project.territories;
  cacheTimeKey = timeKey;
  cacheValue = out;
  return out;
}

export function invalidateBorderCache(): void {
  cacheKey = null;
  cacheTimeKey = null;
  cacheValue = [];
}
