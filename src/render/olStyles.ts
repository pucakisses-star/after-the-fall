/**
 * Compile resolved styles into OpenLayers styles.
 *
 * Styles are cached on a key derived from the resolved appearance, because OL
 * re-asks for a style for every feature on every frame and constructing Style
 * objects in that loop is the single easiest way to lose a map with a few
 * thousand polygons (spec §51).
 */

import Style from 'ol/style/Style';
import Fill from 'ol/style/Fill';
import Stroke from 'ol/style/Stroke';
import CircleStyle from 'ol/style/Circle';
import Text from 'ol/style/Text';
import { toCss } from '@/model/color';
import { canvasPattern, dashArray, doubleLineWidths, isDoubleLine } from './patterns';
import type { StyleFunction } from 'ol/style/Style';
import type { LineStyle, TerritoryStyle } from '@/model/types';

const territoryCache = new Map<string, Style[]>();
const lineCache = new Map<string, Style[]>();

function territoryKey(s: TerritoryStyle, selected: boolean, hovered: boolean): string {
  const p = s.pattern;
  return [
    s.fillColor,
    s.fillOpacity,
    p ? `${p.kind}:${p.angle}:${p.spacing}:${p.thickness}:${p.color}:${p.opacity}` : '-',
    s.outline.color,
    s.outline.width,
    s.outline.opacity,
    s.outline.dash,
    selected ? 'S' : '',
    hovered ? 'H' : '',
  ].join('|');
}

const SELECT_COLOR = '#1f6feb';

export function territoryStyle(s: TerritoryStyle, selected = false, hovered = false): Style[] {
  const key = territoryKey(s, selected, hovered);
  const cached = territoryCache.get(key);
  if (cached) return cached;

  const styles: Style[] = [];

  styles.push(
    new Style({
      fill: new Fill({ color: toCss(s.fillColor, s.fillOpacity) }),
      zIndex: 0,
    }),
  );

  // The hatch sits above the flat fill so both read at once — a tinted territory
  // with diagonal hatching for "disputed", exactly as in the reference styles.
  const pattern = canvasPattern(s.pattern);
  if (pattern) {
    styles.push(new Style({ fill: new Fill({ color: pattern as unknown as string }), zIndex: 1 }));
  }

  if (s.outline.width > 0 && s.outline.opacity > 0) {
    styles.push(
      new Style({
        stroke: new Stroke({
          color: toCss(s.outline.color, s.outline.opacity),
          width: s.outline.width,
          lineDash: dashArray(s.outline.dash, s.outline.width),
          lineCap: s.outline.lineCap,
          lineJoin: s.outline.lineJoin,
        }),
        zIndex: 2,
      }),
    );
  }

  if (hovered && !selected) {
    styles.push(
      new Style({ stroke: new Stroke({ color: 'rgba(31,111,235,0.5)', width: 2 }), zIndex: 8 }),
    );
  }
  if (selected) {
    styles.push(
      new Style({ stroke: new Stroke({ color: '#ffffff', width: 4 }), zIndex: 9 }),
      new Style({ stroke: new Stroke({ color: SELECT_COLOR, width: 2 }), zIndex: 10 }),
    );
  }

  territoryCache.set(key, styles);
  return styles;
}

function lineKey(s: LineStyle, selected: boolean): string {
  return [s.color, s.width, s.opacity, s.dash, s.casingColor, s.casingWidth, s.lineCap, s.lineJoin, selected]
    .join('|');
}

export function lineStyle(s: LineStyle, selected = false, backgroundColor = '#f0e8d5'): Style[] {
  const key = lineKey(s, selected) + backgroundColor;
  const cached = lineCache.get(key);
  if (cached) return cached;

  const styles: Style[] = [];

  if (isDoubleLine(s)) {
    // Wide dark stroke with a narrow background-coloured stroke on top: the
    // engraved twin-rule border of a 19th-century atlas.
    const { outer, inner } = doubleLineWidths(s);
    styles.push(
      new Style({
        stroke: new Stroke({ color: toCss(s.color, s.opacity), width: outer, lineCap: 'butt' }),
        zIndex: 0,
      }),
      new Style({
        stroke: new Stroke({ color: backgroundColor, width: Math.max(0.3, inner), lineCap: 'butt' }),
        zIndex: 1,
      }),
    );
  } else {
    if (s.casingColor && s.casingWidth > 0) {
      styles.push(
        new Style({
          stroke: new Stroke({
            color: toCss(s.casingColor, s.opacity),
            width: s.width + s.casingWidth * 2,
            lineCap: s.lineCap,
            lineJoin: s.lineJoin,
          }),
          zIndex: 0,
        }),
      );
    }
    styles.push(
      new Style({
        stroke: new Stroke({
          color: toCss(s.color, s.opacity),
          width: Math.max(0.2, s.width),
          lineDash: dashArray(s.dash, s.width),
          lineCap: s.lineCap,
          lineJoin: s.lineJoin,
        }),
        zIndex: 1,
      }),
    );
  }

  if (selected) {
    styles.push(
      new Style({ stroke: new Stroke({ color: SELECT_COLOR, width: Math.max(3, s.width + 2) }), zIndex: 10 }),
    );
  }

  lineCache.set(key, styles);
  return styles;
}

/** Basemap reference geography — deliberately quiet, it is a tracing aid. */
export function basemapStyle(fill: string, stroke: string, width = 0.5): Style {
  return new Style({
    fill: new Fill({ color: fill }),
    stroke: new Stroke({ color: stroke, width }),
  });
}

export type BasemapRole =
  | 'land' | 'elevation' | 'countries' | 'states' | 'counties'
  | 'lakes' | 'rivers' | 'roads' | 'places' | 'custom';

/**
 * Draw order for reference geography, interleaved with the document's own layers
 * (territories 10, borders 20, lines 30, settlements 40, labels 50).
 *
 * Outlines used for tracing — land, countries, states, counties — sit at the
 * bottom, underneath everything.
 *
 * Water is the exception. A lake inside a country has to be drawn *over* the
 * political fill or it disappears under it, which is both how atlases set water
 * and the only way the layer is usable as a reference at all. So lakes and
 * rivers sit just above the territory fills and just below the borders, where a
 * printed map would put them.
 */
export const BASEMAP_Z: Record<BasemapRole, number> = {
  land: -100,
  // Relief sits on the land it describes and under every political line drawn
  // over it, which is where an atlas puts hypsometric tints.
  elevation: -90,
  countries: -80,
  states: -78,
  counties: -76,
  custom: -70,
  lakes: 14,
  rivers: 16,
  // Roads over water: a highway crosses a river on a bridge, and drawing the
  // river on top of it says the opposite.
  roads: 18,
  // Reference cities sit just under the document's own settlements, so your
  // placed capitals always read above the ones you are working from.
  places: 38,
};

/**
 * Appearance per role. Lakes take the project's ocean colour so inland water
 * matches the sea, which is what makes a lake read as water rather than as an
 * oddly-coloured territory.
 */
export function basemapRoleStyle(
  role: BasemapRole,
  project: { landColor: string; oceanColor: string; projection?: { units: string } },
): Style | StyleFunction {
  switch (role) {
    case 'land':
      return basemapStyle(project.landColor, '#8b7f6a', 0.8);
    case 'lakes':
      return basemapStyle(project.oceanColor, '#7d9bad', 0.6);
    case 'rivers':
      // A style *function*, not a fixed style: width follows importance.
      return basemapRiverStyle();
    case 'elevation':
      return basemapElevationStyle();
    case 'roads':
      return basemapRoadStyle(metersPerUnit(project.projection?.units));
    case 'places':
      return basemapPlaceStyle(metersPerUnit(project.projection?.units));
    default:
      return basemapStyle('rgba(0,0,0,0)', '#a89c86', 0.4);
  }
}

/**
 * Hypsometric tints for the elevation bands.
 *
 * Each band is the ground *at or above* its threshold rather than a slice
 * between two, so they nest and are drawn lowest first, the higher tints
 * painting over the lower ones — which is how the ladder is laid down on paper
 * and what lets a basin inside a plateau show through as a hole.
 *
 * The ramp is the conventional one, kept muted: this is a wash under a political
 * map, and anything more saturated fights the territory fills that are the point
 * of the plate. No outline at all, because a band edge is a smooth change in
 * ground, not a boundary, and drawing it as a line makes 8-arc-minute sampling
 * look like a claim about where a mountain starts.
 */
export function basemapElevationStyle(): StyleFunction {
  const cache = new Map<number, Style>();
  return (feature) => {
    const props =
      (feature.get('basemap') as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const band = Number(props.band);
    if (!Number.isFinite(band)) return undefined;

    let style = cache.get(band);
    if (!style) {
      style = new Style({
        fill: new Fill({ color: elevationTint(band) }),
        // Within the one layer, higher ground draws over lower.
        zIndex: band,
      });
      cache.set(band, style);
    }
    return style;
  };
}

/** The tint for a band threshold in metres, shared with the SVG exporter. */
export function elevationTint(band: number): string {
  if (band >= 4000) return '#9c6b4c';
  if (band >= 3000) return '#b8875f';
  if (band >= 2000) return '#cfa878';
  if (band >= 1000) return '#ddc794';
  if (band >= 500) return '#d8d5a4';
  return '#c8d4ae';
}

/**
 * Reference highways, thinned and weighted by scale.
 *
 * Two problems, both of which a flat hairline for every road gets wrong. The
 * first is hierarchy: an interstate and a two-lane state route read identically,
 * which is not how any road map has ever been drawn — a trunk route carries the
 * eye, a secondary stays quiet behind it. The second is quantity. All 9,364
 * roads at continental scale is not a network, it is a smear that swallows the
 * coastlines and borders underneath; Natural Earth's own `min_zoom` says which
 * ones survive a zoomed-out view, and honouring it takes the continental view
 * down to the ~1,300 that read as the trunk system.
 *
 * Warm brown rather than the rivers' blue, so the two networks never read as one
 * at a glance, and route shields once you are close enough for a number to mean
 * something.
 */
export function basemapRoadStyle(unitsInMeters = 1): StyleFunction {
  const cache = new Map<string, Style>();
  return (feature, resolution) => {
    const props =
      (feature.get('basemap') as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const metersPerPixel = resolution * unitsInMeters;
    if (!roadVisible(Number(props.min_zoom), metersPerPixel)) return undefined;

    const kind = roadClass(props);
    const shield = roadLabelVisible(Number(props.min_label), metersPerPixel) ? routeShield(props) : '';

    const key = `${kind}|${shield}`;
    let style = cache.get(key);
    if (!style) {
      const { width, color } = roadRankStyle(kind);
      style = new Style({
        stroke: new Stroke({ color, width, lineCap: 'round', lineJoin: 'round' }),
        text: shield
          ? new Text({
              text: shield,
              font: `600 9px 'Iowan Old Style', Palatino, Georgia, serif`,
              placement: 'line',
              textBaseline: 'middle',
              fill: new Fill({ color: ROAD_TEXT_FILL }),
              stroke: new Stroke({ color: ROAD_TEXT_HALO, width: 3 }),
              declutterMode: 'declutter',
            })
          : undefined,
      });
      cache.set(key, style);
    }
    return style;
  };
}

/** How a road is drawn: three weights, coarser than Natural Earth's own tiers. */
export type RoadClass = 'trunk' | 'major' | 'minor';

/**
 * Which weight a road is drawn at.
 *
 * `level` is the more honest field where it exists — an Interstate is an
 * interstate whatever `type` calls it — and `type` is the fallback for the two
 * thirds of the Americas that Natural Earth never assigned a level to.
 */
export function roadClass(props: Record<string, unknown>): RoadClass {
  const level = String(props.level ?? '');
  const type = String(props.type ?? '');
  if (level === 'Interstate' || level === 'Federal') return 'trunk';
  if (type === 'Major Highway') return 'trunk';
  if (type === 'Beltway' || type === 'Bypass') return 'major';
  return 'minor';
}

/** Stroke width and colour for a road class, shared with the SVG exporter. */
export function roadRankStyle(kind: RoadClass): { width: number; color: string } {
  switch (kind) {
    case 'trunk':
      return { width: 1.5, color: 'rgba(158, 92, 48, 0.8)' };
    case 'major':
      return { width: 1.0, color: 'rgba(166, 110, 70, 0.7)' };
    default:
      return { width: 0.7, color: 'rgba(172, 132, 100, 0.55)' };
  }
}

export const ROAD_TEXT_FILL = '#8a4f28';
export const ROAD_TEXT_HALO = 'rgba(253,250,242,0.92)';

/**
 * The route number as a reader recognises it.
 *
 * Natural Earth stores the two halves apart — prefix "I", name "95" — and then
 * fills the prefix in on only 96 of the 1,352 US interstates, so most of the
 * network would read as a bare "95" without the fallback below. Country plus
 * level recovers it: an American road levelled Interstate is an I route and one
 * levelled Federal is a US route, which is exactly the rule the rows that *do*
 * carry a prefix follow.
 *
 * Deliberately no equivalent elsewhere. A Mexican federal highway is not "US-15"
 * and a state route belongs to a state this file does not name, so both keep the
 * bare number they are signed with.
 */
export function routeShield(props: Record<string, unknown>): string {
  const name = typeof props.name === 'string' ? props.name.trim() : '';
  if (!name) return '';
  const prefix = typeof props.prefix === 'string' ? props.prefix.trim() : '';
  if (prefix) return `${prefix}-${name}`;
  if (props.sov_a3 === 'USA') {
    if (props.level === 'Interstate') return `I-${name}`;
    if (props.level === 'Federal') return `US-${name}`;
  }
  return name;
}

/**
 * Whether a road is worth drawing at this scale.
 *
 * Natural Earth's `min_zoom` is in web-map zoom levels, which run about 3.25
 * ahead of the `zoomish` the places above are calibrated in; the offset here is
 * that difference, rounded, so the answer is simply "what Natural Earth would
 * have drawn at this scale". Roads with no hint are treated as minor.
 */
export function roadVisible(minZoom: number, metersPerPixel: number): boolean {
  const zoomish = Math.max(0, 14 - Math.log2(Math.max(metersPerPixel, 1e-9)));
  return (Number.isFinite(minZoom) ? minZoom : 7.5) <= zoomish + 3;
}

/**
 * Whether a road's route number is worth drawing at this scale.
 *
 * Its own field, not a derivative of `min_zoom`: a road appears as a line well
 * before there is room to write on it, which is the same order the places above
 * earn their names in.
 */
export function roadLabelVisible(minLabel: number, metersPerPixel: number): boolean {
  const zoomish = Math.max(0, 14 - Math.log2(Math.max(metersPerPixel, 1e-9)));
  return (Number.isFinite(minLabel) ? minLabel : 9.6) <= zoomish + 3;
}

/**
 * Reference rivers, weighted by Natural Earth's `scalerank`.
 *
 * A flat hairline for every watercourse is close to useless: the Mississippi and
 * an unnamed creek read identically, and at 1 px in pale blue neither reads at
 * all over land. Ranking them restores the hierarchy a drawn map has — trunk
 * rivers carry the eye, tributaries stay quiet.
 *
 * Natural Earth's rank runs roughly 0 (major) to 11 (minor); anything missing is
 * treated as minor.
 */
export function basemapRiverStyle(): StyleFunction {
  const cache = new Map<number, Style>();
  return (feature) => {
    const source = feature.get('basemap') as { properties?: Record<string, unknown> } | undefined;
    const raw = Number(source?.properties?.scalerank);
    const rank = Number.isFinite(raw) ? Math.max(0, Math.min(11, Math.round(raw))) : 9;

    let style = cache.get(rank);
    if (!style) {
      const width = rank <= 2 ? 1.9 : rank <= 4 ? 1.4 : rank <= 6 ? 1.0 : rank <= 8 ? 0.75 : 0.55;
      // Minor watercourses also fade, so the hierarchy reads by weight and tone
      // rather than by weight alone.
      const color = rank <= 4 ? '#6f9cb8' : rank <= 8 ? '#87abc2' : '#9dbccd';
      style = new Style({ stroke: new Stroke({ color, width, lineCap: 'round', lineJoin: 'round' }) });
      cache.set(rank, style);
    }
    return style;
  };
}

/**
 * Reference cities and towns.
 *
 * Deliberately quiet — a small hollow dot and a grey name, so real places read
 * as a backdrop you are placing your own settlements against rather than
 * competing with them. Size and label visibility follow Natural Earth's
 * `scalerank`, and the layer is decluttered so names thin out instead of piling
 * into an unreadable mat at low zoom.
 */
export function basemapPlaceStyle(unitsInMeters = 1): StyleFunction {
  const cache = new Map<string, Style>();
  return (feature, resolution) => {
    const props =
      (feature.get('basemap') as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const rank = clampRank(Number(props.scalerank), 8);
    const labelRank = clampRank(Number(props.labelrank), 8);
    const name = typeof props.name === 'string' ? props.name : '';

    // `resolution` is metres — or degrees — per pixel, hence the conversion; a
    // log curve is the right shape for a scale.
    const metersPerPixel = resolution * unitsInMeters;
    if (!placeDotVisible(rank, metersPerPixel)) return undefined;
    const showLabel = !!name && placeLabelVisible(labelRank, metersPerPixel);

    const key = `${rank}|${showLabel ? name : ''}`;
    let style = cache.get(key);
    if (!style) {
      const { radius, fontSize } = placeRankStyle(rank);
      style = new Style({
        image: new CircleStyle({
          radius,
          fill: new Fill({ color: PLACE_DOT_FILL }),
          stroke: new Stroke({ color: PLACE_DOT_STROKE, width: 1 }),
        }),
        text: showLabel
          ? new Text({
              text: name,
              font: `${fontSize}px 'Iowan Old Style', Palatino, Georgia, serif`,
              offsetX: radius + 4,
              textAlign: 'left',
              fill: new Fill({ color: PLACE_TEXT_FILL }),
              stroke: new Stroke({ color: PLACE_TEXT_HALO, width: 2.5 }),
              declutterMode: 'declutter',
            })
          : undefined,
      });
      cache.set(key, style);
    }
    return style;
  };
}

export function clampRank(raw: number, fallback: number): number {
  return Number.isFinite(raw) ? Math.max(0, Math.min(11, Math.round(raw))) : fallback;
}

/** Colours for reference cities, shared with the SVG exporter. */
export const PLACE_DOT_FILL = '#fdfaf2';
export const PLACE_DOT_STROKE = '#8a7f6d';
export const PLACE_TEXT_FILL = '#6d6455';
export const PLACE_TEXT_HALO = 'rgba(253,250,242,0.9)';

/** Dot radius and name size for a place's `scalerank`, shared with the exporter. */
export function placeRankStyle(rank: number): { radius: number; fontSize: number } {
  const r = clampRank(rank, 8);
  return {
    radius: r <= 1 ? 3.6 : r <= 3 ? 3 : r <= 5 ? 2.5 : 2,
    fontSize: r <= 1 ? 11 : 10,
  };
}

/**
 * Metres in one unit of a projection, for turning a resolution into a scale.
 *
 * Only the two cases the app can produce: an equirectangular project measures in
 * degrees, everything else in metres. Without this a lat/lon map reports a
 * resolution near 0.5 where a metric one reports 40,000, and any threshold
 * calibrated on one is nonsense on the other.
 */
export function metersPerUnit(units: string | undefined): number {
  return units === 'degrees' ? 111319.49079327358 : 1;
}

/**
 * Whether a place is worth marking at all at this scale.
 *
 * Names are not the only thing that piles up: 7,300 dots at continental scale is
 * a stipple, not a map. Dots survive two ranks longer than names do, so a city
 * appears as a mark first and earns its name a little further in — which is the
 * order an atlas reveals things in.
 */
export function placeDotVisible(rank: number, metersPerPixel: number): boolean {
  const zoomish = Math.max(0, 14 - Math.log2(Math.max(metersPerPixel, 1e-9)));
  return clampRank(rank, 8) <= zoomish + 3;
}

/**
 * Whether a place's name is worth drawing at this scale.
 *
 * Show fewer names as you zoom out: at world scale only the majors survive,
 * otherwise seven thousand names pile into an unreadable mat. `metersPerPixel`
 * is a scale, so a log curve is the right shape — and because the SVG exporter
 * knows its own metres per pixel it can ask the same question and get the same
 * answer, keeping print and screen in agreement.
 */
export function placeLabelVisible(labelRank: number, metersPerPixel: number): boolean {
  const zoomish = Math.max(0, 14 - Math.log2(Math.max(metersPerPixel, 1e-9)));
  return clampRank(labelRank, 8) <= zoomish - 1;
}

/**
 * Whether a territory's name is worth drawing at this scale (spec §28).
 *
 * Keyed on depth in the political hierarchy rather than on rank, because that is
 * the question actually being asked: a realm is named on the plate that shows
 * the realm, and what is *inside* it is named on the plate that shows the
 * inside. Rank cannot answer it — a kingdom's premier duchy and an independent
 * duchy carry the same rank and belong at opposite ends of this decision.
 *
 * Sovereigns are always named. Each level down waits for about two and a half
 * more zoom steps, which is what lets a map of four hundred member states read
 * as thirty realms from a hemisphere away and as a feudal patchwork up close.
 *
 * Shared with the SVG exporter, so a printed plate names what the screen named.
 */
export function territoryLabelVisible(depth: number, metersPerPixel: number): boolean {
  if (depth <= 0) return true;
  const zoomish = Math.max(0, 14 - Math.log2(Math.max(metersPerPixel, 1e-9)));
  return zoomish >= depth * 2.5;
}

/** Stroke width and colour for a river rank, shared with the SVG exporter. */
export function riverRankStyle(rank: number): { width: number; color: string } {
  const r = Number.isFinite(rank) ? Math.max(0, Math.min(11, Math.round(rank))) : 9;
  return {
    width: r <= 2 ? 1.9 : r <= 4 ? 1.4 : r <= 6 ? 1.0 : r <= 8 ? 0.75 : 0.55,
    color: r <= 4 ? '#6f9cb8' : r <= 8 ? '#87abc2' : '#9dbccd',
  };
}

/** Vertex handles shown by the vertex-edit tool. */
export function vertexStyle(): Style {
  return new Style({
    image: new CircleStyle({
      radius: 4,
      fill: new Fill({ color: '#ffffff' }),
      stroke: new Stroke({ color: SELECT_COLOR, width: 1.5 }),
    }),
  });
}

export function snapIndicatorStyle(): Style {
  return new Style({
    image: new CircleStyle({
      radius: 6,
      fill: new Fill({ color: 'rgba(255,180,0,0.35)' }),
      stroke: new Stroke({ color: '#e08b00', width: 2 }),
    }),
  });
}

export function drawingStyle(): Style[] {
  return [
    new Style({
      fill: new Fill({ color: 'rgba(31,111,235,0.12)' }),
      stroke: new Stroke({ color: SELECT_COLOR, width: 2, lineDash: [6, 4] }),
      image: new CircleStyle({
        radius: 4,
        fill: new Fill({ color: '#ffffff' }),
        stroke: new Stroke({ color: SELECT_COLOR, width: 1.5 }),
      }),
    }),
  ];
}

export function clearStyleCaches(): void {
  territoryCache.clear();
  lineCache.clear();
}
