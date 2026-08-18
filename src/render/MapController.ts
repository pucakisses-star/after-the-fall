/**
 * Owns the OpenLayers map and keeps it in step with the document.
 *
 * PERFORMANCE CONTRACT (spec §51: "do not rerender the entire React application
 * every time one vertex moves"):
 *
 *   • React never renders map content. It renders chrome — toolbar, panels — and
 *     mounts this controller once.
 *   • The controller subscribes to the store directly and diffs by *object
 *     identity*. Because every edit produces new objects only for the records it
 *     touched, syncing a one-vertex change touches exactly one OL feature.
 *   • Styles are cached (see olStyles.ts) so the per-frame style function is a
 *     map lookup, not an allocation.
 */

import OlMap from 'ol/Map';
import View from 'ol/View';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import ImageLayer from 'ol/layer/Image';
import Static from 'ol/source/ImageStatic';
import Graticule from 'ol/layer/Graticule';
import Feature from 'ol/Feature';
import GeoJSON from 'ol/format/GeoJSON';
import Style from 'ol/style/Style';
import Stroke from 'ol/style/Stroke';
import { defaults as defaultInteractions } from 'ol/interaction';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import type { Coordinate } from 'ol/coordinate';
import type Projection from 'ol/proj/Projection';
import type { Pixel } from 'ol/pixel';
import type { Geometry, Point as OlPoint } from 'ol/geom';

import {
  olProjectionFor,
  projectExtent,
  registerProjections,
  renderExtentFor,
} from '@/geo/projections';
import { clipToValidArea, findBasemapSource, loadBasemap } from '@/geo/basemap';
import {
  resolveLinearStyle,
  resolveSymbolStyle,
  resolveTerritoryStyle,
  resolveTextStyle,
} from '@/model/resolveStyle';
import { depthOf, layerEffective } from '@/model/hierarchy';
import { visibleInTime } from '@/model/timeline';
import { toCss } from '@/model/color';
import { coastGeneration, computeBorders, onCoastReady } from './borders';
import {
  basemapRoleStyle,
  BASEMAP_Z,
  clearStyleCaches,
  lineStyle,
  metersPerUnit,
  territoryLabelVisible,
  territoryStyle,
} from './olStyles';
import { drawSymbol } from './symbols';
import { placeNameBySymbol } from './namePlacement';
import { fitToPlate, inscriptionScale, nameFitsItsLand, nameIsLegible, scaledText } from './labelFit';
import { drawText, drawTextOnPath, boxContains, type TextBox } from './textRenderer';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import type {
  MapLabel,
  MapProject,
  ProjectionSettings,
  Territory,
  TextStyle,
  TimelineRange,
  UUID,
} from '@/model/types';

const geojson = new GeoJSON();

/**
 * How a reference place and a settlement are matched up: name and position.
 *
 * Three decimal places is about a hundred metres, which is finer than any two
 * towns are apart and coarser than the rounding a coordinate picks up on its way
 * through a document. The name is folded because a place taken over and then
 * renamed is a different place — the reference dot for the old name should come
 * back, since nothing on the map is standing in for it any more.
 */
function placeKey(name: string, at: number[]): string {
  return `${name.trim().toLowerCase()}@${at[0].toFixed(3)},${at[1].toFixed(3)}`;
}

/** Comparable form of a working extent, for spotting a change cheaply. */
function extentKey(e: [number, number, number, number] | null | undefined): string {
  return e ? e.join(',') : '';
}

/**
 * The map view, honouring the project's working extent when it has one.
 *
 * A working extent is a hard boundary for the view, not a hint: OpenLayers keeps
 * the viewport inside it, which caps how far out you can zoom as well as how far
 * you can pan. That is exactly what makes a regional map feel like a sheet of
 * paper — a map of the Americas should not be able to shrink itself into a
 * corner of the Pacific. `showFullExtent` keeps the whole region reachable when
 * its shape does not match the window's.
 */
function buildView(
  project: MapProject,
  projection: Projection,
  seed: { center: Coordinate; zoom: number; rotation: number },
): View {
  const bounds = project.workingExtent
    ? projectExtent(projection.getCode(), project.workingExtent)
    : null;
  return new View({
    projection,
    center: seed.center,
    zoom: seed.zoom,
    rotation: seed.rotation,
    constrainResolution: false,
    multiWorld: false,
    showFullExtent: true,
    ...(bounds ? { extent: bounds } : {}),
  });
}

/** A reference city or town, as the tools need it to adopt one. */
export interface BasemapPlace {
  name: string;
  coordinates: [number, number];
  scalerank: number;
  /** Natural Earth's `pop_max`, where the place carries one. */
  population?: number;
}

export interface HitResult {
  id: UUID;
  kind: 'territory' | 'settlement' | 'label' | 'linear';
}

export class MapController {
  readonly map: OlMap;

  readonly territorySource = new VectorSource({ wrapX: false });
  readonly borderSource = new VectorSource({ wrapX: false });
  readonly linearSource = new VectorSource({ wrapX: false });
  readonly settlementSource = new VectorSource({ wrapX: false });
  readonly labelSource = new VectorSource({ wrapX: false });
  /** Transient geometry: drawing previews, snap indicators, measurement. */
  readonly overlaySource = new VectorSource({ wrapX: false });

  readonly territoryLayer: VectorLayer<VectorSource>;
  readonly borderLayer: VectorLayer<VectorSource>;
  readonly linearLayer: VectorLayer<VectorSource>;
  readonly settlementLayer: VectorLayer<VectorSource>;
  readonly labelLayer: VectorLayer<VectorSource>;
  readonly overlayLayer: VectorLayer<VectorSource>;
  private graticuleLayer: Graticule | null = null;
  private referenceLayer: ImageLayer<Static> | null = null;

  private basemapLayers = new Map<string, VectorLayer<VectorSource>>();

  /** Label bounding boxes in CSS pixels, refreshed every frame. */
  /**
   * Reference places the document has taken over, by name and position.
   *
   * Rebuilt whenever the settlements change, and read by the reference layer's
   * style so a place that has become one of the map's own settlements stops
   * being drawn twice.
   */
  private adoptedPlaces = new Set<string>();
  private lastSettlements: MapProject['settlements'] | null = null;

  readonly labelBoxes = new Map<UUID, TextBox>();
  private labelBoxesDraft = new Map<UUID, TextBox>();

  /** Identity cache used to diff the document against the OL sources. */
  private cache = {
    territories: new Map<UUID, unknown>(),
    settlements: new Map<UUID, unknown>(),
    labels: new Map<UUID, unknown>(),
    linear: new Map<UUID, unknown>(),
  };
  private lastBorderKey: unknown = null;
  private lastBorderTimeKey: string | null = null;
  private lastOceanColor: string | null = null;
  private lastWaterLandKey: string | null = null;
  private lastProjectionId: string | null = null;
  /** How many documents have been opened, so a *load* can be told from an edit. */
  private lastLoadCount = -1;
  private lastWorkingExtent: string | null = null;
  private lastStyles: unknown = null;
  private lastLayers: unknown = null;

  private unsubscribes: (() => void)[] = [];

  constructor(target: HTMLElement) {
    registerProjections();
    const project = useProjectStore.getState().project;
    const projection = olProjectionFor(project.projection);

    this.territoryLayer = new VectorLayer({
      source: this.territorySource,
      style: (f) => this.styleTerritory(f as Feature<Geometry>),
      updateWhileAnimating: false,
      updateWhileInteracting: false,
      renderBuffer: 200,
    });

    this.borderLayer = new VectorLayer({
      source: this.borderSource,
      style: (f) => this.styleBorder(f as Feature<Geometry>),
      updateWhileInteracting: false,
      renderBuffer: 100,
    });

    this.linearLayer = new VectorLayer({
      source: this.linearSource,
      style: (f) => this.styleLinear(f as Feature<Geometry>),
      renderBuffer: 100,
    });

    this.settlementLayer = new VectorLayer({
      source: this.settlementSource,
      style: (f) => this.styleSettlement(f as Feature<Geometry>),
      renderBuffer: 60,
    });

    this.labelLayer = new VectorLayer({
      source: this.labelSource,
      style: (f) => this.styleLabel(f as Feature<Geometry>),
      renderBuffer: 800, // labels can extend far beyond their anchor
      declutter: false, // §11 requires manual control, so no automatic dropping
    });

    this.overlayLayer = new VectorLayer({ source: this.overlaySource, zIndex: 1000 });

    // One explicit stack, so nothing depends on insertion order.
    this.territoryLayer.setZIndex(10);
    this.borderLayer.setZIndex(20);
    this.linearLayer.setZIndex(30);
    this.settlementLayer.setZIndex(40);
    this.labelLayer.setZIndex(50);

    // Label boxes are collected during the layer's render pass and swapped in
    // when it finishes, so hit-testing never sees a half-built frame.
    this.labelLayer.on('prerender', () => {
      this.labelBoxesDraft = new Map();
    });
    this.labelLayer.on('postrender', () => {
      this.labelBoxes.clear();
      for (const [k, v] of this.labelBoxesDraft) this.labelBoxes.set(k, v);
    });

    this.map = new OlMap({
      target,
      layers: [
        this.territoryLayer,
        this.borderLayer,
        this.linearLayer,
        this.settlementLayer,
        this.labelLayer,
        this.overlayLayer,
      ],
      view: buildView(project, projection, {
        center: transformCoord(project.view.center, 'EPSG:4326', projection.getCode()),
        zoom: project.view.zoom,
        rotation: project.view.rotation,
      }),
      controls: defaultControls({ attribution: false, rotate: false, zoom: false }).extend([
        new ScaleLine({ units: 'metric', bar: true, steps: 4, text: false, minWidth: 90 }),
      ]),
      interactions: defaultInteractions({ doubleClickZoom: false, altShiftDragRotate: true, pinchRotate: false }),
    });

    this.lastProjectionId = project.projection.id;
    this.lastWorkingExtent = extentKey(project.workingExtent);
    this.attachStore();
    this.attachPointer();
    this.syncAll(project, true);

    // The first frames draw before the coastline has loaded, so every coast
    // carries a frontier's hard stroke until told otherwise. This is the
    // telling: re-derive the borders the moment the coast is known.
    this.unsubscribes.push(
      onCoastReady(() => this.syncBorders(useProjectStore.getState().project)),
    );
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private attachStore(): void {
    let lastRevision = -1;
    this.unsubscribes.push(
      useProjectStore.subscribe((state) => {
        if (state.revision === lastRevision) return;
        lastRevision = state.revision;
        this.syncAll(state.project, false);
      }),
    );

    // Selection and hover only change appearance, so a repaint is enough.
    let lastSelection = useUIStore.getState().selection;
    let lastHover = useUIStore.getState().hoverId;
    let lastFlags = flagsOf(useUIStore.getState());
    this.unsubscribes.push(
      useUIStore.subscribe((state) => {
        const flags = flagsOf(state);
        const selectionChanged = state.selection !== lastSelection;
        const hoverChanged = state.hoverId !== lastHover;
        if (selectionChanged || hoverChanged || flags !== lastFlags) {
          lastSelection = state.selection;
          lastHover = state.hoverId;
          if (flags !== lastFlags) {
            lastFlags = flags;
            this.applyVisibilityFlags();
            this.repaint();
          } else {
            // A hover is one layer's business; a selection is four layers'.
            this.repaint(selectionChanged ? this.styledLayers() : [this.territoryLayer]);
          }
        }
      }),
    );
  }

  private attachPointer(): void {
    this.map.on('pointermove', (evt) => {
      if (evt.dragging) return;
      const lonlat = this.toLonLat(evt.coordinate);
      useUIStore.getState().setPointer({ lon: lonlat[0], lat: lonlat[1] });
    });

    const view = this.map.getView();
    const publishView = () => {
      const zoom = view.getZoom() ?? 0;
      useUIStore.getState().setViewInfo(zoom, this.scaleText());
      const centre = this.toLonLat(view.getCenter() ?? [0, 0]);
      useProjectStore.getState().setView({
        center: [centre[0], centre[1]],
        zoom,
        rotation: view.getRotation(),
      });
    };
    view.on('change:center', publishView);
    view.on('change:resolution', publishView);
    view.on('change:rotation', publishView);
    publishView();
  }

  dispose(): void {
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
    this.map.setTarget(undefined);
  }

  /**
   * Redraw, re-running the style functions of the layers named.
   *
   * `map.render()` alone re-composites the cached layer frames, so a style that
   * depends on UI state — the selection outline, the hover tint — can survive
   * the state that justified it: deselecting a freshly drawn territory left it
   * wearing its selection blue until something else touched the document.
   * Marking a layer changed is what makes its styles run again.
   *
   * Which layers, though, is not a detail. Hover changes on every pointer move
   * across the map, and invalidating all five layers on each one cost twenty
   * milliseconds a move — the map went from sixty frames a second to eighteen
   * while the mouse was over it. Only the territory layer draws a hover tint,
   * so only the territory layer needs redrawing for one.
   */
  repaint(layers: VectorLayer<VectorSource>[] = this.styledLayers()): void {
    for (const layer of layers) layer.changed();
    this.map.render();
  }

  /** Every layer whose style function reads UI state. */
  private styledLayers(): VectorLayer<VectorSource>[] {
    return [this.territoryLayer, this.linearLayer, this.settlementLayer, this.labelLayer];
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  /** Document coordinates are WGS84; the view may be anything. */
  toView(lonlat: [number, number] | Coordinate, code?: string): Coordinate {
    const target = code ?? this.map.getView().getProjection().getCode();
    return transformCoord(lonlat as Coordinate, 'EPSG:4326', target);
  }

  toLonLat(coord: Coordinate): [number, number] {
    const source = this.map.getView().getProjection().getCode();
    const c = transformCoord(coord, source, 'EPSG:4326');
    return [c[0], c[1]];
  }

  /**
   * @param loaded A different document just replaced the one on screen, so its
   *   own saved view is what to open on — not wherever the last map was left.
   */
  setProjection(settings: ProjectionSettings, loaded = false): void {
    const project = useProjectStore.getState().project;
    const projection = olProjectionFor(settings);
    const old = this.map.getView();
    const centreLonLat = this.toLonLat(old.getCenter() ?? [0, 0]);

    // Changing projection on the map you are working on should keep you where
    // you are; opening a different map should not. Both went through the old
    // view before, which is why a prebuilt map opened at whatever zoom the
    // previous one happened to be left at rather than the view it ships with.
    const seed = loaded ? project.view : { center: centreLonLat, zoom: old.getZoom() ?? 4, rotation: old.getRotation() };
    const view = buildView(project, projection, {
      center: transformCoord(seed.center as Coordinate, 'EPSG:4326', projection.getCode()),
      zoom: seed.zoom,
      rotation: seed.rotation,
    });
    this.map.setView(view);
    this.lastProjectionId = settings.id;

    // Geometry is stored in WGS84, so every source has to be rebuilt in the new
    // projected space. Cheaper and far less error-prone than transforming in place.
    this.invalidateAll();
    this.syncAll(project, true);
    // With nothing drawn yet, frame the region the map is about — or the whole
    // projection when it is about everywhere.
    const frame = project.workingExtent
      ? projectExtent(projection.getCode(), project.workingExtent)
      : projection.getExtent();
    if (frame && !loaded && !this.territorySource.getFeatures().length) {
      view.fit(frame, { size: this.map.getSize(), padding: [20, 20, 20, 20] });
    }
    this.attachPointer();
  }

  /**
   * Rebuild the view and reload reference geography after the working extent
   * changes. Both depend on it: the view for its bounds, the reference layers
   * for what was clipped away before they were ever projected.
   */
  private applyWorkingExtent(project: MapProject, loaded = false): void {
    const old = this.map.getView();
    const projection = old.getProjection();
    const view = buildView(project, projection, {
      center: loaded
        ? transformCoord(project.view.center as Coordinate, 'EPSG:4326', projection.getCode())
        : (old.getCenter() ?? [0, 0]),
      zoom: loaded ? project.view.zoom : (old.getZoom() ?? 4),
      rotation: loaded ? project.view.rotation : old.getRotation(),
    });
    this.map.setView(view);

    // Dropped rather than restyled: what was clipped away is not in the source
    // at all. `syncAll` refills them on the way past.
    for (const layer of this.basemapLayers.values()) this.map.removeLayer(layer);
    this.basemapLayers.clear();

    // Frame the new region when one is set. Clearing the crop deliberately does
    // not move the view: "the map now covers the world" is not a request to be
    // thrown out to the far edge of the projection, which for a conic is a cone
    // tens of thousands of kilometres wide.
    // A map that arrived with its own view has already said where to open; only
    // a crop the user just drew is a request to be shown the region it covers.
    if (project.workingExtent && !loaded) {
      const frame = projectExtent(projection.getCode(), project.workingExtent);
      if (frame) view.fit(frame, { size: this.map.getSize(), padding: [20, 20, 20, 20] });
    }
    this.attachPointer();
  }

  /** Put the view where the document says, without disturbing anything else. */
  private applyDocumentView(project: MapProject): void {
    const view = this.map.getView();
    view.setCenter(transformCoord(project.view.center as Coordinate, 'EPSG:4326', view.getProjection().getCode()));
    view.setZoom(project.view.zoom);
    view.setRotation(project.view.rotation);
  }

  private invalidateAll(): void {
    this.cache.territories.clear();
    this.cache.settlements.clear();
    this.cache.labels.clear();
    this.cache.linear.clear();
    this.lastBorderKey = null;
    this.territorySource.clear(true);
    this.borderSource.clear(true);
    this.linearSource.clear(true);
    this.settlementSource.clear(true);
    this.labelSource.clear(true);
    for (const layer of this.basemapLayers.values()) layer.getSource()?.clear(true);
    this.basemapLayers.clear();
  }

  // -------------------------------------------------------------------------
  // Document → OpenLayers sync
  // -------------------------------------------------------------------------

  syncAll(project: MapProject, force: boolean): void {
    const loadCount = useProjectStore.getState().loadCount;
    const loaded = this.lastLoadCount >= 0 && loadCount !== this.lastLoadCount;
    this.lastLoadCount = loadCount;
    if (project.projection.id !== this.lastProjectionId) {
      this.lastWorkingExtent = extentKey(project.workingExtent);
      this.setProjection(project.projection, loaded);
      return;
    }
    if (extentKey(project.workingExtent) !== this.lastWorkingExtent) {
      this.lastWorkingExtent = extentKey(project.workingExtent);
      this.applyWorkingExtent(project, loaded);
      // Falls through: everything below is independent of the extent.
    } else if (loaded) {
      // A document that happens to share the projection and the crop of the one
      // it replaced still has its own view, and nothing above would have
      // applied it — which is how opening a saved map could leave you looking
      // at wherever the last one was.
      this.applyDocumentView(project);
    }
    if (force || this.lastStyles !== project.styles) {
      clearStyleCaches();
      this.lastStyles = project.styles;
    }
    if (force || this.lastLayers !== project.layers) {
      this.lastLayers = project.layers;
      this.syncLayerVisibility(project);
    }
    this.syncOcean(project);
    // Land layers take landColor and lake layers take oceanColor, so a change to
    // either has to reach the reference layers.
    const waterLandKey = `${project.landColor}|${project.oceanColor}`;
    if (force || this.lastWaterLandKey !== waterLandKey) {
      this.lastWaterLandKey = waterLandKey;
      for (const [id, layer] of this.basemapLayers) {
        layer.setStyle(basemapRoleStyle(findBasemapSource(id)?.role ?? 'custom', project));
      }
    }

    this.syncTerritories(project);
    this.syncBorders(project);
    this.syncLinear(project);
    this.syncSettlements(project);
    this.syncLabels(project);
    this.syncBasemaps(project);
    this.syncGraticule(project);
    this.repaint();
  }

  private projection(): string {
    return this.map.getView().getProjection().getCode();
  }

  /** Insert/update/remove OL features to match a document collection. */
  private syncCollection<T extends { id: UUID; hidden: boolean; layerId: UUID; timeline: TimelineRange }>(
    source: VectorSource,
    cache: Map<UUID, unknown>,
    records: Record<UUID, T>,
    project: MapProject,
    toGeometry: (rec: T) => Geometry | null,
  ): boolean {
    const seen = new Set<UUID>();
    let touched = false;

    for (const rec of Object.values(records)) {
      seen.add(rec.id);
      const visible =
        !rec.hidden &&
        layerEffective(project, rec.layerId).visible &&
        visibleInTime(rec.timeline, project.timeline);
      const existing = source.getFeatureById(rec.id) as Feature<Geometry> | null;

      if (!visible) {
        if (existing) source.removeFeature(existing);
        cache.delete(rec.id);
        touched = touched || !!existing;
        continue;
      }
      if (cache.get(rec.id) === rec && existing) continue; // untouched
      touched = true;

      const geometry = toGeometry(rec);
      if (!geometry) {
        if (existing) source.removeFeature(existing);
        cache.delete(rec.id);
        continue;
      }
      if (existing) {
        existing.setGeometry(geometry);
        existing.set('rec', rec, true);
      } else {
        const f = new Feature<Geometry>({ geometry });
        f.setId(rec.id);
        f.set('rec', rec, true);
        source.addFeature(f);
      }
      cache.set(rec.id, rec);
    }

    for (const id of [...cache.keys()]) {
      if (seen.has(id)) continue;
      const f = source.getFeatureById(id);
      if (f) source.removeFeature(f);
      cache.delete(id);
      touched = true;
    }
    return touched;
  }

  private syncTerritories(project: MapProject): void {
    const proj = this.projection();
    this.syncCollection(this.territorySource, this.cache.territories, project.territories, project, (t) =>
      geojson.readGeometry(t.geometry, { dataProjection: 'EPSG:4326', featureProjection: proj }),
    );
  }

  private syncLinear(project: MapProject): void {
    const proj = this.projection();
    this.syncCollection(this.linearSource, this.cache.linear, project.linearFeatures, project, (f) =>
      f.kind === 'label-path'
        ? null // carrier paths are invisible by design (§12)
        : geojson.readGeometry(f.geometry, { dataProjection: 'EPSG:4326', featureProjection: proj }),
    );
  }

  private syncSettlements(project: MapProject): void {
    if (this.lastSettlements !== project.settlements) {
      this.lastSettlements = project.settlements;
      const before = this.adoptedPlaces.size;
      this.adoptedPlaces = new Set();
      for (const s of Object.values(project.settlements)) {
        const [lon, lat] = s.geometry.coordinates;
        this.adoptedPlaces.add(placeKey(s.name, [lon, lat]));
      }
      // The reference layer draws from a style function, so it only notices when
      // it is asked to draw again.
      if (before !== this.adoptedPlaces.size) {
        for (const [id, layer] of this.basemapLayers) {
          if (findBasemapSource(id)?.role === 'places') layer.changed();
        }
      }
    }

    const proj = this.projection();
    // A name is drawn against its symbol, so a symbol that changed leaves the
    // name it belongs to out of date — and nothing in the label collection says
    // so, because the label record itself did not change. Without this, growing
    // a dot (or promoting a town to a capital, which grows it) redraws the
    // symbol under a name still placed for the old one.
    if (
      this.syncCollection(this.settlementSource, this.cache.settlements, project.settlements, project, (s) =>
        geojson.readGeometry(s.geometry, { dataProjection: 'EPSG:4326', featureProjection: proj }),
      )
    ) {
      this.labelLayer.changed();
    }
  }

  private syncLabels(project: MapProject): void {
    const proj = this.projection();
    this.syncCollection(this.labelSource, this.cache.labels, project.labels, project, (l) =>
      geojson.readGeometry(l.anchor, { dataProjection: 'EPSG:4326', featureProjection: proj }),
    );
  }

  /**
   * Borders are derived, not stored, so they are rebuilt whenever the territory
   * set changes — and only then.
   */
  private syncBorders(project: MapProject): void {
    // Borders depend on the territory set *and* on which of them the timeline
    // currently admits, so both go into the cache key.
    // The coast generation is in the key so borders reclassify when the
    // coastline arrives: the first frames of a session draw before it has
    // loaded, and without this every coast keeps its hard stroke until
    // something else happens to change the territory set.
    const key = `${project.timeline.enabled ? project.timeline.currentYear : 'all'}:${coastGeneration}`;
    if (this.lastBorderKey === project.territories && this.lastBorderTimeKey === key) return;
    this.lastBorderKey = project.territories;
    this.lastBorderTimeKey = key;

    const proj = this.projection();
    this.borderSource.clear(true);
    const borders = computeBorders(project);
    const features = borders.map((b, i) => {
      const f = new Feature<Geometry>({
        geometry: geojson.readGeometry(b.geometry, {
          dataProjection: 'EPSG:4326',
          featureProjection: proj,
        }),
      });
      f.setId(`border-${i}`);
      f.set('border', b, true);
      return f;
    });
    this.borderSource.addFeatures(features);
  }

  /**
   * Bumped on every basemap sync so a superseded run can bow out.
   *
   * Loading a dataset is asynchronous, so switching projects while the previous
   * one is still loading interleaves two runs. Without a way to tell which run
   * is current, the stale one adds a layer the new project never asked for —
   * a reference dataset on screen with its checkbox clear, invisible when it was
   * one coastline under another and glaring the moment it is a layer of city
   * dots. Nothing is registered or added to the map until its data is in hand
   * and the token still matches, so an abandoned run leaves no trace.
   */
  private basemapSyncToken = 0;

  private async syncBasemaps(project: MapProject): Promise<void> {
    const token = ++this.basemapSyncToken;
    const wanted = new Set(project.basemap.filter((b) => b.visible).map((b) => b.sourceId));

    for (const [id, layer] of this.basemapLayers) {
      if (!wanted.has(id)) {
        this.map.removeLayer(layer);
        this.basemapLayers.delete(id);
      }
    }

    // Loaded in parallel: `loadBasemap` shares one request per dataset, so this
    // costs nothing extra and gets a multi-layer map on screen far sooner than
    // waiting for each file in turn.
    await Promise.all(
      project.basemap
        .filter((entry) => entry.visible)
        .map(async (entry) => {
          const existing = this.basemapLayers.get(entry.sourceId);
          if (existing) {
            existing.setOpacity(entry.opacity);
            return;
          }

          let features;
          try {
            features = await loadBasemap(entry.sourceId);
          } catch (err) {
            useUIStore.getState().toast(String((err as Error).message ?? err), 'error');
            return;
          }
          // Superseded by a newer project, or another run got here first.
          if (token !== this.basemapSyncToken) return;
          if (this.basemapLayers.has(entry.sourceId)) return;

          const proj = this.projection();
          // Drop anything outside the projection's domain of validity, and
          // outside the map's working extent when it has one. Without the first,
          // Antarctica in a North-America conic projects to a ring tens of
          // thousands of kilometres across and floods the map with land colour;
          // without the second, a map of the Americas pays to project and draw
          // every Eurasian coastline and city it will never show.
          const valid = renderExtentFor(proj, project.workingExtent);
          const olFeatures: Feature<Geometry>[] = [];
          for (let i = 0; i < features.length; i++) {
            const clipped = clipToValidArea(features[i], valid);
            if (!clipped) continue;
            const f = clipped;
            const geometry = geojson.readGeometry(f.geometry, {
              dataProjection: 'EPSG:4326',
              featureProjection: proj,
            });
            // Backstop for custom projections with no declared domain.
            const extent = geometry.getExtent();
            if (!extent.every(Number.isFinite)) continue;
            const olf = new Feature<Geometry>({ geometry });
            olf.setId(`${entry.sourceId}-${i}`);
            olf.set('basemap', f, true);
            olFeatures.push(olf);
          }

          const role = findBasemapSource(entry.sourceId)?.role ?? 'custom';
          const layer = new VectorLayer({
            source: new VectorSource({ features: olFeatures, wrapX: false }),
            opacity: entry.opacity,
            style: basemapRoleStyle(role, project, (name, at) => this.adoptedPlaces.has(placeKey(name, at))),
            // City names would otherwise pile into an unreadable mat at low zoom.
            declutter: role === 'places',
            renderBuffer: role === 'places' ? 400 : 200,
            // Explicit z so land sits under lakes, lakes under rivers, and every
            // reference layer stays below the document's own features regardless
            // of the order the user switches them on.
            zIndex: BASEMAP_Z[role],
          });
          this.basemapLayers.set(entry.sourceId, layer);
          this.map.addLayer(layer);
        }),
    );
  }

  /**
   * The ocean (spec §17) is the map's ground, so it is painted as the viewport's
   * background rather than as a polygon — that way it covers the whole canvas at
   * every projection and zoom, exactly as the exported page's background rect does.
   */
  private syncOcean(project: MapProject): void {
    const oceanLayers = Object.values(project.layers).filter((l) => l.kind === 'ocean');
    const effective = oceanLayers.map((l) => layerEffective(project, l.id));
    const visible = effective.length === 0 || effective.some((e) => e.visible);
    // The Ocean layer's opacity slider has to mean something: fade the water
    // towards the application background as it drops, which is what a user
    // reaching for that slider is asking for.
    const opacity = effective.length ? Math.max(...effective.map((e) => e.opacity)) : 1;
    const color = visible ? toCss(project.oceanColor, opacity) : 'transparent';

    const key = `${color}`;
    if (this.lastOceanColor === key) return;
    this.lastOceanColor = key;

    const viewport = this.map.getViewport();
    if (viewport) {
      // A translucent water colour needs something behind it, or the page shows
      // through as application chrome.
      viewport.style.backgroundColor = '#1c1b19';
      viewport.style.backgroundImage = `linear-gradient(${color}, ${color})`;
    }
  }

  private syncGraticule(project: MapProject): void {
    const wanted = useUIStore.getState().showGraticule;
    if (wanted && !this.graticuleLayer) {
      this.graticuleLayer = new Graticule({
        strokeStyle: new Stroke({ color: 'rgba(70,60,45,0.35)', width: 0.6, lineDash: [1, 3] }),
        showLabels: true,
        wrapX: false,
        targetSize: 140,
        zIndex: 900,
        lonLabelStyle: undefined,
      });
      this.map.addLayer(this.graticuleLayer);
    } else if (!wanted && this.graticuleLayer) {
      this.map.removeLayer(this.graticuleLayer);
      this.graticuleLayer = null;
    }
    void project;
  }

  private syncLayerVisibility(project: MapProject): void {
    // Layer-level opacity is applied to the OL layer that carries that kind.
    const forKind = (kind: string) => {
      const layers = Object.values(project.layers).filter((l) => l.kind === kind);
      if (!layers.length) return { visible: true, opacity: 1 };
      const eff = layers.map((l) => layerEffective(project, l.id));
      return {
        visible: eff.some((e) => e.visible),
        opacity: Math.max(...eff.map((e) => e.opacity)),
      };
    };

    const apply = (layer: VectorLayer<VectorSource>, kind: string) => {
      const { visible, opacity } = forKind(kind);
      layer.setVisible(visible);
      layer.setOpacity(opacity);
    };

    apply(this.territoryLayer, 'territory');
    apply(this.borderLayer, 'border');
    apply(this.settlementLayer, 'settlement');
    const labelState = forKind('label');
    this.labelLayer.setOpacity(labelState.opacity);
    this.applyVisibilityFlags();

    // Rivers and roads share one OL layer; visible when either map layer is on.
    const river = forKind('river');
    const road = forKind('road');
    this.linearLayer.setVisible(river.visible || road.visible);
    this.linearLayer.setOpacity(Math.max(river.opacity, road.opacity));
  }

  private applyVisibilityFlags(): void {
    const ui = useUIStore.getState();
    const project = useProjectStore.getState().project;
    const labelLayers = Object.values(project.layers).filter((l) => l.kind === 'label');
    const labelsOn = labelLayers.some((l) => layerEffective(project, l.id).visible);
    this.labelLayer.setVisible(ui.showLabels && labelsOn);
    const borderLayers = Object.values(project.layers).filter((l) => l.kind === 'border');
    const bordersOn = borderLayers.some((l) => layerEffective(project, l.id).visible);
    this.borderLayer.setVisible(ui.showBorders && bordersOn);
    this.syncGraticule(project);
  }

  // -------------------------------------------------------------------------
  // Style functions
  // -------------------------------------------------------------------------

  private styleTerritory(f: Feature<Geometry>): Style[] {
    const project = useProjectStore.getState().project;
    const id = f.getId() as UUID;
    const t = project.territories[id];
    if (!t) return [];
    const ui = useUIStore.getState();
    return territoryStyle(
      resolveTerritoryStyle(project, t),
      ui.selection.includes(id),
      ui.hoverId === id,
    );
  }

  private styleBorder(f: Feature<Geometry>): Style[] {
    const project = useProjectStore.getState().project;
    const border = f.get('border') as { kind: string; coastal?: boolean } | undefined;
    if (!border) return [];
    // A coast is where the country stops because the ground does, not a line
    // anybody drew. The coastline layer draws the sea's edge; stroking a heavy
    // political border on top of it is the hard black rim this suppresses.
    if (border.coastal) return [];
    const styleClassId = borderClassId(border.kind);
    const resolved = project.styles.line[styleClassId]?.style;
    if (!resolved) return [];
    return lineStyle(resolved, false, project.landColor);
  }

  private styleLinear(f: Feature<Geometry>): Style[] {
    const project = useProjectStore.getState().project;
    const id = f.getId() as UUID;
    const lf = project.linearFeatures[id];
    if (!lf) return [];
    const selected = useUIStore.getState().selection.includes(id);
    return lineStyle(resolveLinearStyle(project, lf), selected, project.landColor);
  }

  private styleSettlement(f: Feature<Geometry>): Style[] {
    const project = useProjectStore.getState().project;
    const id = f.getId() as UUID;
    const s = project.settlements[id];
    if (!s) return [];
    const style = resolveSymbolStyle(project, s);
    const selected = useUIStore.getState().selection.includes(id);

    return [
      new Style({
        renderer: (coords, state) => {
          const [x, y] = coords as number[];
          const ctx = state.context as CanvasRenderingContext2D;
          const scale = state.pixelRatio;
          if (selected) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, (style.size / 2 + 4) * scale, 0, Math.PI * 2);
            ctx.strokeStyle = '#1f6feb';
            ctx.lineWidth = 2 * scale;
            ctx.stroke();
            ctx.restore();
          }
          drawSymbol(ctx, style, x, y, scale);
        },
      }),
    ];
  }

  /**
   * Whether a territory's name is worth drawing at the current scale (spec §28).
   *
   * A realm divided into duchies and counties has an order of magnitude more
   * names than one that stops at the realm, and drawn all at once they are not a
   * map but a mat of white halos with a continent somewhere underneath. An atlas
   * solves this the same way every time: the plate showing two continents names
   * the realms, and the plate showing one region names what is inside them.
   *
   * Two things decide it. Depth in the hierarchy: a sovereign is always a
   * candidate and what is inside it waits until there is a plate showing the
   * inside, which is what keeps a small sovereign visible beside a large duchy
   * that belongs to somebody. And then whether the name actually fits the land
   * — because on a map where every realm stands alone, depth says yes to all
   * four hundred of them at once, and a name pinned to its own type size does
   * not shrink out of the way as you zoom out. It is left off the plate instead,
   * the way an atlas does it.
   *
   * `style` is the style as it will be drawn, scaling included; the test is
   * about ink on the plate, not about the number in the style sheet.
   *
   * Only territory labels are gated. Ocean, river and city names have their own
   * rules, and a label the user placed by hand is never second-guessed.
   */
  private labelEarnsItsPlace(project: MapProject, label: MapLabel, style: TextStyle): boolean {
    // Legibility first, and for every label rather than only the political ones:
    // a name drawn below reading size is a smudge whatever it names, and this is
    // the one rule that applies alike to a pinned name and a scaling one.
    if (!nameIsLegible(style)) return false;

    const owner = label.attachedToId ? project.territories[label.attachedToId] : undefined;
    if (!owner) return true;

    // "Name everything" turns the atlas thinning off: every realm keeps its
    // name at every zoom, overlaps and all. Legibility above still applies —
    // a name too small to read is not a name on the plate — but nothing is
    // held back for being deep in the hierarchy or short of room.
    if (project.nameEverything) return true;

    const resolution = this.map.getView().getResolution() ?? 1;
    const metersPerPixel = resolution * metersPerUnit(project.projection?.units);
    if (!territoryLabelVisible(depthOf(project, owner.id), metersPerPixel)) return false;
    return nameFitsItsLand(label.text, style, this.territoryRoom(owner));
  }

  /**
   * How wide a territory is on the plate right now, in px.
   *
   * The longer side of its box rather than the diagonal: the diagonal is up to
   * √2 more room than any single direction really offers, and measured against
   * it a continental view keeps two hundred names that each overrun their
   * country — which is the mat this test exists to prevent.
   *
   * The extent comes from the feature OpenLayers already holds, so it is a
   * lookup and two coordinate transforms per name rather than a walk over a
   * polygon with several thousand vertices.
   */
  private territoryRoom(owner: Territory): number {
    const geometry = this.territorySource.getFeatureById(owner.id)?.getGeometry();
    if (!geometry) return Infinity;
    const [minX, minY, maxX, maxY] = geometry.getExtent();
    const a = this.map.getPixelFromCoordinate([minX, minY]);
    const b = this.map.getPixelFromCoordinate([maxX, maxY]);
    if (!a || !b) return Infinity;
    return Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  }

  /**
   * Grow and shrink a political name with the land it names (spec §42).
   *
   * A territory's label is laid out once, against the shape of the territory, at
   * the scale the plate is composed for — see `render/labelFit.ts`. Drawn at a
   * fixed pixel size it is then only correct at that one zoom: composed to span
   * a kingdom, it spans two continents when you zoom out, and shrinks to a
   * caption when you zoom in. That is the difference between a name that belongs
   * to a country and a name that floats over it.
   *
   * So the size travels with the map. The clamp is what keeps it usable at the
   * extremes: without a floor a realm's name disappears entirely on a world
   * view, and without a ceiling one letter fills the window at street level.
   *
   * Only territory names scale. Cities, rivers and oceans are annotations on the
   * map rather than inscriptions across a shape, and are set to be read at
   * whatever zoom you happen to be at.
   */
  /**
   * How much larger than its own type size a label is being drawn right now.
   *
   * 1 means the label is drawn at exactly the size in its style — which is the
   * answer for everything that does not scale: pinned names, and names that are
   * annotations rather than inscriptions across a shape.
   *
   * The inspector asks this so that pinning a name does not resize it. What is
   * on screen is `style size × scale`; pinning multiplies the scale into the
   * style and then stops scaling, which leaves the glyphs exactly where they
   * were and makes the size box mean what it says.
   *
   * Pass the resolved style when you already have it — the renderer does, and it
   * saves resolving it twice for every label on every frame.
   */
  labelScale(
    label: MapLabel,
    project = useProjectStore.getState().project,
    style?: TextStyle,
  ): number {
    const resolution = this.map.getView().getResolution() ?? 1;
    const factor = inscriptionScale({
      pinned: label.fixedSize,
      metersPerPixel: resolution * metersPerUnit(project.projection?.units),
    });
    if (factor <= 1) return factor;
    const width = this.map.getSize()?.[0] ?? 0;
    return fitToPlate(factor, label.text, style ?? resolveTextStyle(project, label), width);
  }

  private scaleToPlate(project: MapProject, label: MapLabel, style: TextStyle): TextStyle {
    const factor = this.labelScale(label, project, style);
    if (Math.abs(factor - 1) < 0.02) return style;
    return scaledText(style, factor);
  }

  private styleLabel(f: Feature<Geometry>): Style[] {
    const project = useProjectStore.getState().project;
    const id = f.getId() as UUID;
    const label = project.labels[id];
    if (!label) return [];
    const base = resolveTextStyle(project, label);
    const selected = useUIStore.getState().selection.includes(id);
    const style = this.scaleToPlate(project, label, base);
    if (!selected && !this.labelEarnsItsPlace(project, label, style)) return [];
    const pathPixels = label.pathId ? this.labelPathPixels(project, label) : null;
    // A name belonging to a symbol is placed against that symbol rather than at
    // a stored offset, so promoting a town — or resizing its dot — moves its
    // name out of the way instead of under it. A name the author has dragged
    // has said where it goes and is left alone.
    const owner = label.attachedToId ? project.settlements[label.attachedToId] : undefined;
    const pin =
      owner && !label.manualPosition && !pathPixels
        ? placeNameBySymbol(label.offset, resolveSymbolStyle(project, owner), style, label.text.split(/\r?\n/).length)
        : null;

    return [
      new Style({
        renderer: (coords, state) => {
          const ctx = state.context as CanvasRenderingContext2D;
          const scale = state.pixelRatio;
          const [x, y] = coords as number[];

          let box: TextBox | null;
          if (pathPixels && pathPixels.length > 1) {
            box = drawTextOnPath(
              ctx,
              label.text,
              pathPixels.map(([px, py]) => ({ x: px * scale, y: py * scale })),
              style,
              scale,
            );
          } else {
            box = drawText(
              ctx,
              label.text,
              x + (pin ? pin.dx : label.offset[0]) * scale,
              y + (pin ? pin.dy : label.offset[1]) * scale,
              style,
              scale,
              label.rotation,
              pin ? pin.anchorX : 'middle',
            );
          }

          if (box) {
            // Record in CSS pixels for hit-testing against pointer positions.
            this.labelBoxesDraft.set(id, {
              cx: box.cx / scale,
              cy: box.cy / scale,
              width: box.width / scale,
              height: box.height / scale,
              rotation: box.rotation,
            });

            if (selected) {
              ctx.save();
              ctx.translate(box.cx, box.cy);
              ctx.rotate((box.rotation * Math.PI) / 180);
              ctx.strokeStyle = '#1f6feb';
              ctx.lineWidth = 1.5 * scale;
              ctx.setLineDash([4 * scale, 3 * scale]);
              const pad = 4 * scale;
              ctx.strokeRect(
                -box.width / 2 - pad,
                -box.height / 2 - pad,
                box.width + pad * 2,
                box.height + pad * 2,
              );
              ctx.restore();
            }
          }
        },
      }),
    ];
  }

  /** Pixel coordinates of a label's carrier path, for text-on-path. */
  private labelPathPixels(project: MapProject, label: MapLabel): [number, number][] | null {
    if (!label.pathId) return null;
    const path = project.linearFeatures[label.pathId];
    if (!path) return null;
    const coords =
      path.geometry.type === 'LineString' ? path.geometry.coordinates : path.geometry.coordinates[0];
    if (!coords || coords.length < 2) return null;
    const out: [number, number][] = [];
    for (const c of coords) {
      const px = this.map.getPixelFromCoordinate(this.toView([c[0], c[1]]));
      if (!px) return null;
      out.push([px[0], px[1]]);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------

  /**
   * Topmost feature at a pixel, respecting draw order: labels, then settlements,
   * then lines, then territories.
   *
   * Labels and settlements use custom canvas renderers, which OpenLayers cannot
   * hit-test, so both are tested here against geometry we already track.
   */
  /**
   * The reference city or town under a pixel, if any (spec §47).
   *
   * Not part of `hitTest`, which answers with things the document owns and the
   * selection can hold. A reference place is neither until somebody adopts it,
   * and this is what the tools ask before they do.
   */
  basemapPlaceAt(pixel: Pixel): BasemapPlace | null {
    let found: BasemapPlace | null = null;
    this.map.forEachFeatureAtPixel(
      pixel,
      (f) => {
        const raw = f.get('basemap') as
          | { geometry?: { type?: string; coordinates?: number[] }; properties?: Record<string, unknown> }
          | undefined;
        const at = raw?.geometry?.coordinates;
        const name = raw?.properties?.name;
        if (!at || at.length < 2 || typeof name !== 'string' || !name) return undefined;
        const pop = Number(raw?.properties?.pop_max);
        found = {
          name,
          coordinates: [at[0], at[1]],
          scalerank: Number(raw?.properties?.scalerank),
          population: Number.isFinite(pop) && pop > 0 ? pop : undefined,
        };
        return true;
      },
      {
        hitTolerance: 8,
        layerFilter: (layer) => {
          for (const [id, l] of this.basemapLayers) {
            if (l === layer) return findBasemapSource(id)?.role === 'places' && l.getVisible();
          }
          return false;
        },
      },
    );
    return found;
  }

  hitTest(pixel: Pixel): HitResult | null {
    const project = useProjectStore.getState().project;
    const ui = useUIStore.getState();

    if (ui.showLabels) {
      // Later entries render on top, so walk backwards.
      const entries = [...this.labelBoxes.entries()].reverse();
      for (const [id, box] of entries) {
        const label = project.labels[id];
        if (!label || label.locked) continue;
        if (boxContains(box, pixel[0], pixel[1])) return { id, kind: 'label' };
      }
    }

    let best: HitResult | null = null;
    let bestDist = Infinity;
    this.settlementSource.forEachFeatureInExtent(
      this.pixelExtent(pixel, 14),
      (f) => {
        const id = f.getId() as UUID;
        const s = project.settlements[id];
        if (!s || s.locked) return;
        const geom = f.getGeometry() as OlPoint | null;
        if (!geom) return;
        const px = this.map.getPixelFromCoordinate(geom.getCoordinates());
        if (!px) return;
        const d = Math.hypot(px[0] - pixel[0], px[1] - pixel[1]);
        const style = resolveSymbolStyle(project, s);
        if (d <= style.size / 2 + 5 && d < bestDist) {
          bestDist = d;
          best = { id, kind: 'settlement' };
        }
      },
    );
    if (best) return best;

    const found = this.map.forEachFeatureAtPixel(
      pixel,
      (f, layer) => {
        const id = f.getId();
        if (typeof id !== 'string') return undefined;
        if (layer === this.linearLayer && project.linearFeatures[id] && !project.linearFeatures[id].locked) {
          return { id, kind: 'linear' as const };
        }
        if (layer === this.territoryLayer && project.territories[id] && !project.territories[id].locked) {
          return { id, kind: 'territory' as const };
        }
        return undefined;
      },
      { hitTolerance: 4, layerFilter: (l) => l === this.linearLayer || l === this.territoryLayer },
    );
    return (found as HitResult | undefined) ?? null;
  }

  /** All territories whose polygon contains a pixel — used by the paint tool. */
  territoriesAtPixel(pixel: Pixel): UUID[] {
    const project = useProjectStore.getState().project;
    const out: UUID[] = [];
    this.map.forEachFeatureAtPixel(
      pixel,
      (f) => {
        const id = f.getId();
        if (typeof id === 'string' && project.territories[id]) out.push(id);
        return undefined;
      },
      { hitTolerance: 0, layerFilter: (l) => l === this.territoryLayer },
    );
    return out;
  }

  private pixelExtent(pixel: Pixel, radius: number): [number, number, number, number] {
    const a = this.map.getCoordinateFromPixel([pixel[0] - radius, pixel[1] - radius]);
    const b = this.map.getCoordinateFromPixel([pixel[0] + radius, pixel[1] + radius]);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }

  // -------------------------------------------------------------------------
  // View helpers (spec §2)
  // -------------------------------------------------------------------------

  /**
   * Fit an extent given in the *view's* projection.
   *
   * Deliberately no `maxZoom`: OpenLayers zoom levels are derived from the
   * projection's extent, so a level that means "street" in Web Mercator means
   * "region" in a conic. Clamping to a fixed number silently refuses to zoom in
   * some projections. A degenerate extent (a single point) is grown instead, so
   * fitting a city still does something sensible.
   */
  zoomToExtent(extent: [number, number, number, number] | null, paddingPx = 60): void {
    if (!extent || !extent.every(Number.isFinite)) return;

    let target = extent;
    if (extent[0] === extent[2] || extent[1] === extent[3]) {
      // Grow a point or a zero-width extent to roughly 20 km across.
      const resolution = this.map.getView().getResolution() ?? 1;
      const pad = Math.max(resolution * 120, 1e-6);
      target = [extent[0] - pad, extent[1] - pad, extent[2] + pad, extent[3] + pad];
    }

    this.map.getView().fit(target, {
      size: this.map.getSize(),
      padding: [paddingPx, paddingPx, paddingPx, paddingPx],
      duration: 350,
    });
  }

  /**
   * What the window currently shows, as WGS84 [w, s, e, n].
   *
   * The interior is sampled on a grid, not just the corners. Two things make the
   * corners insufficient. A projection that curves the parallels bulges the
   * visible area past them, so a corner-only box cuts off geography the user can
   * plainly see. And a conic's inverse is only meaningful inside its cone: a
   * viewport wider than the cone contains coordinates that invert to a longitude
   * on the far side of the world, which would silently report the visible area
   * as the entire globe. Each sample is therefore projected back and discarded
   * unless it lands where it started.
   */
  visibleExtentLonLat(): [number, number, number, number] | null {
    const view = this.map.getView();
    const size = this.map.getSize();
    if (!size) return null;
    const code = view.getProjection().getCode();
    const [minX, minY, maxX, maxY] = view.calculateExtent(size);
    const tolerance = Math.max(maxX - minX, maxY - minY) * 1e-6;

    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const x = minX + ((maxX - minX) * i) / steps;
        const y = minY + ((maxY - minY) * j) / steps;
        try {
          const [lon, lat] = transformCoord([x, y], code, 'EPSG:4326');
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
          const back = transformCoord([lon, lat], 'EPSG:4326', code);
          if (Math.abs(back[0] - x) > tolerance || Math.abs(back[1] - y) > tolerance) continue;
          west = Math.min(west, lon);
          east = Math.max(east, lon);
          south = Math.min(south, lat);
          north = Math.max(north, lat);
        } catch {
          /* off the edge of the projection; contributes nothing */
        }
      }
    }
    if (!Number.isFinite(west) || east <= west || north <= south) return null;
    return [
      Math.max(-180, west),
      Math.max(-90, south),
      Math.min(180, east),
      Math.min(90, north),
    ];
  }

  /** Fit everything that exists in the document. */
  fitAll(): void {
    const sources = [this.territorySource, this.linearSource, this.settlementSource];
    let extent: [number, number, number, number] | null = null;
    for (const s of sources) {
      if (s.isEmpty()) continue;
      const e = s.getExtent() as [number, number, number, number];
      extent = extent ? extendExtent(extent, e) : e;
    }
    if (!extent) {
      for (const layer of this.basemapLayers.values()) {
        const s = layer.getSource();
        if (s && !s.isEmpty()) {
          const e = s.getExtent() as [number, number, number, number];
          extent = extent ? extendExtent(extent, e) : e;
        }
      }
    }
    this.zoomToExtent(extent);
  }

  zoomToSelection(): void {
    const ids = useUIStore.getState().selection;
    if (!ids.length) return;
    let extent: [number, number, number, number] | null = null;
    for (const id of ids) {
      for (const source of [this.territorySource, this.settlementSource, this.linearSource, this.labelSource]) {
        const f = source.getFeatureById(id);
        const g = f?.getGeometry();
        if (!g) continue;
        const e = g.getExtent() as [number, number, number, number];
        extent = extent ? extendExtent(extent, e) : e;
      }
    }
    this.zoomToExtent(extent);
  }

  zoomToFeature(id: UUID): void {
    for (const source of [this.territorySource, this.settlementSource, this.linearSource, this.labelSource]) {
      const f = source.getFeatureById(id);
      const g = f?.getGeometry();
      if (!g) continue;
      this.zoomToExtent(g.getExtent() as [number, number, number, number]);
      return;
    }
  }

  zoomBy(delta: number): void {
    const view = this.map.getView();
    view.animate({ zoom: (view.getZoom() ?? 5) + delta, duration: 200 });
  }

  /** Human-readable scale for the status bar. */
  scaleText(): string {
    const view = this.map.getView();
    const resolution = view.getResolution();
    if (!resolution) return '';
    const units = view.getProjection().getUnits();
    const mpu = units === 'degrees' ? 111320 : 1;
    const metresPerPixel = resolution * mpu;
    // 96 dpi ⇒ 0.0002645833 m per CSS pixel
    const denominator = metresPerPixel / 0.0002645833;
    if (!Number.isFinite(denominator)) return '';
    return `1 : ${Math.round(denominator).toLocaleString()}`;
  }

  // -------------------------------------------------------------------------
  // Reference image (spec §32)
  // -------------------------------------------------------------------------

  setReferenceImage(
    url: string | null,
    extentLonLat: [number, number, number, number] | null,
    opacity = 0.6,
  ): void {
    if (this.referenceLayer) {
      this.map.removeLayer(this.referenceLayer);
      this.referenceLayer = null;
    }
    if (!url || !extentLonLat) return;
    const proj = this.projection();
    const a = transformCoord([extentLonLat[0], extentLonLat[1]], 'EPSG:4326', proj);
    const b = transformCoord([extentLonLat[2], extentLonLat[3]], 'EPSG:4326', proj);
    this.referenceLayer = new ImageLayer({
      source: new Static({ url, imageExtent: [a[0], a[1], b[0], b[1]], projection: proj }),
      opacity,
      zIndex: -10,
    });
    this.map.getLayers().insertAt(0, this.referenceLayer);
  }

  setReferenceOpacity(opacity: number): void {
    this.referenceLayer?.setOpacity(opacity);
  }

  hasReferenceImage(): boolean {
    return !!this.referenceLayer;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { transform as olTransform } from 'ol/proj';

function transformCoord(coord: Coordinate, from: string, to: string): Coordinate {
  if (from === to) return [coord[0], coord[1]];
  try {
    const out = olTransform([coord[0], coord[1]], from, to);
    return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : [0, 0];
  } catch {
    return [0, 0];
  }
}

function extendExtent(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function flagsOf(s: { showLabels: boolean; showBorders: boolean; showGraticule: boolean }): string {
  return `${s.showLabels}|${s.showBorders}|${s.showGraticule}`;
}

import { STYLE_IDS } from '@/model/defaults';

function borderClassId(kind: string): string {
  switch (kind) {
    case 'international':
      return STYLE_IDS.lineInternational;
    case 'major-political':
      return STYLE_IDS.lineMajor;
    case 'subordinate':
      return STYLE_IDS.lineSubordinate;
    case 'provincial':
      return STYLE_IDS.lineProvincial;
    case 'county':
      return STYLE_IDS.lineCounty;
    case 'disputed':
      return STYLE_IDS.lineDisputed;
    case 'ceasefire':
      return STYLE_IDS.lineCeasefire;
    case 'historical':
      return STYLE_IDS.lineHistorical;
    default:
      return STYLE_IDS.lineProvincial;
  }
}
