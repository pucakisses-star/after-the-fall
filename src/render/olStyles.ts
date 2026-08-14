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
import { toCss } from '@/model/color';
import { canvasPattern, dashArray, doubleLineWidths, isDoubleLine } from './patterns';
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
