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
  | 'land' | 'countries' | 'states' | 'counties' | 'lakes' | 'rivers' | 'places' | 'custom';

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
  countries: -80,
  states: -78,
  counties: -76,
  custom: -70,
  lakes: 14,
  rivers: 16,
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
    case 'places':
      return basemapPlaceStyle(metersPerUnit(project.projection?.units));
    default:
      return basemapStyle('rgba(0,0,0,0)', '#a89c86', 0.4);
  }
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

    // Show fewer names as you zoom out: at world scale only the majors survive.
    // `resolution` is metres (or degrees) per pixel, so a log scale is the right
    // shape here.
    const showLabel = !!name && placeLabelVisible(labelRank, resolution * unitsInMeters);

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
