/**
 * Tool interactions (spec §2, §5, §11, §14, §34, §35, §56).
 *
 * One manager owns every OpenLayers interaction and swaps them as the active tool
 * changes, so there is never more than one thing listening for a click and tools
 * cannot leak handlers into each other.
 */

import Draw, { createBox } from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Snap from 'ol/interaction/Snap';
import DragBox from 'ol/interaction/DragBox';
import DragPan from 'ol/interaction/DragPan';
import Collection from 'ol/Collection';
import Feature from 'ol/Feature';
import GeoJSON from 'ol/format/GeoJSON';
import { Point as OlPoint, LineString as OlLineString, Polygon as OlPolygon } from 'ol/geom';
import type { Geometry } from 'ol/geom';
import type Interaction from 'ol/interaction/Interaction';
import type { MapBrowserEvent } from 'ol';
import * as turf from '@turf/turf';
import type { LineString, MultiPolygon, Polygon } from 'geojson';

import type { MapController } from '@/render/MapController';
import { drawingStyle, metersPerUnit, snapIndicatorStyle, vertexStyle } from '@/render/olStyles';
import { distanceToBoundary } from '@/geo/reshape';
import { toast, useUIStore, type ToolId } from '@/state/uiStore';
import { getProject, makeLinear, commit } from '@/state/projectStore';
import {
  addLabel,
  addSettlement,
  adoptPlace,
  addTerritory,
  fillLandAt,
  moveLabel,
  moveSettlement,
  paintTerritory,
  reshapeTerritoryBoundary,
  stateFromStroke,
  strokeCloses,
  subdivisionFromStroke,
  splitTerritoryWithLine,
  updateTerritoryGeometry,
} from '@/state/commands';
import { coastlinePolygons } from '@/io/importers';
import { barrierLines, barrierWaters } from '@/geo/barriers';
import type { Territory, UUID } from '@/model/types';

const geojson = new GeoJSON();

export class ToolManager {
  private controller: MapController;
  private active: Interaction[] = [];
  private currentTool: ToolId | null = null;
  private unsubscribe: (() => void) | null = null;

  /**
   * Manual drag state for settlements and labels (custom-rendered, so no OL
   * Translate).
   *
   * `grab` and `origin` are what make it a drag rather than a teleport: the
   * feature moves by the distance the pointer has travelled since it was picked
   * up, so it keeps the grip it was grabbed with. Setting it to the pointer
   * instead snaps a long inscription's centre under the cursor the moment you
   * touch its first letter.
   */
  private drag: {
    id: UUID;
    kind: 'settlement' | 'label';
    moved: boolean;
    /** Map coordinate the pointer went down at. */
    grab: [number, number];
    /** Map coordinate the feature sat at when it was picked up. */
    origin: [number, number];
    /** A settlement's own name, and where it sat, so it can come along. */
    label?: { id: UUID; origin: [number, number] };
  } | null = null;
  private pointerHandlers: (() => void)[] = [];
  private paintStroke = new Set<UUID>();
  private painting = false;

  constructor(controller: MapController) {
    this.controller = controller;
    this.attachPointerHandlers();
    let last: ToolId | null = null;
    this.unsubscribe = useUIStore.subscribe((state) => {
      if (state.tool === last) return;
      last = state.tool;
      this.setTool(state.tool);
    });
    this.setTool(useUIStore.getState().tool);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.clearInteractions();
    for (const off of this.pointerHandlers) off();
    this.pointerHandlers = [];
    // Never leave the map unable to pan because a drag was interrupted.
    this.drag = null;
    this.setPanning(true);
  }

  private map() {
    return this.controller.map;
  }

  private clearInteractions(): void {
    for (const i of this.active) this.map().removeInteraction(i);
    this.active = [];
    this.controller.overlaySource.clear(true);
  }

  private add(interaction: Interaction): void {
    this.map().addInteraction(interaction);
    this.active.push(interaction);
  }

  /** Snap interaction shared by every drawing/editing tool (spec §35). */
  private addSnap(): void {
    if (!useUIStore.getState().snapEnabled) return;
    this.add(new Snap({ source: this.controller.territorySource, pixelTolerance: useUIStore.getState().snapPixels }));
    this.add(new Snap({ source: this.controller.linearSource, pixelTolerance: useUIStore.getState().snapPixels }));
    this.add(
      new Snap({ source: this.controller.settlementSource, pixelTolerance: useUIStore.getState().snapPixels }),
    );
  }

  setTool(tool: ToolId): void {
    if (this.currentTool === tool) return;
    this.currentTool = tool;
    this.clearInteractions();
    // Switching tools abandons any drag in progress, and a drag holds the map
    // still while it lasts — so hand panning back on the way out.
    this.drag = null;
    this.setPanning(true);
    this.map().getTargetElement()?.style.setProperty('cursor', cursorFor(tool));

    switch (tool) {
      case 'select':
        this.setupSelect();
        break;
      case 'pan':
        // OpenLayers' default drag-pan is always present; the only thing that
        // ever switches it off is a settlement or label drag, which switches it
        // back on when the pointer comes up.
        break;
      case 'territory':
        // The coastline is what stops a drawn border at the water, and the trim
        // is synchronous — so the data has to be here before the first shape is
        // finished. Warmed on tool pick, exactly as the fill tool does.
        void coastlinePolygons().catch(() => undefined);
        this.setupDrawTerritory();
        break;
      case 'vertex':
        void coastlinePolygons().catch(() => undefined);
        this.setupVertexEdit();
        break;
      case 'reshape':
        void coastlinePolygons().catch(() => undefined);
        this.setupReshape();
        break;
      case 'cut':
        this.setupCut();
        break;
      case 'river':
      case 'road':
        this.setupDrawLinear(tool);
        break;
      case 'measure':
        this.setupMeasure();
        break;
      case 'fill':
        // Warm the coastline and the barrier layers as soon as the tool is
        // picked. Between them they are several MB of TopoJSON and the fill
        // cannot start without them, so leaving the load inside the click makes
        // the first click of a session look dead.
        void coastlinePolygons().catch(() => undefined);
        void barrierLines(getProject(), []).catch(() => undefined);
        void barrierWaters().catch(() => undefined);
        break;
      case 'settlement':
      case 'label':
      case 'paint':
        break; // handled by the shared pointer handlers below
    }
  }

  // -------------------------------------------------------------------------
  // Pointer handling shared by all tools
  // -------------------------------------------------------------------------

  private attachPointerHandlers(): void {
    const map = this.map();

    const onMove = (evt: MapBrowserEvent<PointerEvent>) => {
      const ui = useUIStore.getState();

      if (this.drag && evt.dragging) {
        const { grab, origin } = this.drag;
        const [x, y] = evt.coordinate as [number, number];
        this.drag.moved = true;
        // Preview the move without committing, so undo gets one entry per drag.
        this.previewDrag(this.drag.id, this.drag.kind, [
          origin[0] + (x - grab[0]),
          origin[1] + (y - grab[1]),
        ]);
        return;
      }

      if (this.painting && evt.dragging && ui.tool === 'paint') {
        this.paintAt(evt);
        return;
      }

      if (evt.dragging) return;
      if (ui.tool === 'select' || ui.tool === 'paint' || ui.tool === 'vertex') {
        const hit = this.controller.hitTest(evt.pixel);
        ui.setHover(hit?.id ?? null);
        map.getTargetElement()?.style.setProperty('cursor', hit ? 'pointer' : cursorFor(ui.tool));
      }
    };

    const onDown = (evt: MapBrowserEvent<PointerEvent>) => {
      // A press on the reference image, while it is the thing being positioned,
      // belongs to the image (spec §32).
      if (this.controller.referenceGrabsAt(evt.coordinate)) return;
      const ui = useUIStore.getState();
      if (ui.tool === 'paint') {
        this.painting = true;
        this.paintStroke.clear();
        this.paintAt(evt);
        return;
      }
      if (ui.tool !== 'select') return;
      const hit = this.controller.hitTest(evt.pixel);
      if (!hit || (hit.kind !== 'settlement' && hit.kind !== 'label')) return;

      const source = this.sourceFor(hit.kind);
      const geom = source.getFeatureById(hit.id)?.getGeometry() as OlPoint | undefined;
      if (!geom) return;
      const at = geom.getCoordinates() as [number, number];
      const labelId = hit.kind === 'settlement' ? getProject().settlements[hit.id]?.labelId : null;
      const labelGeom = labelId
        ? (this.controller.labelSource.getFeatureById(labelId)?.getGeometry() as OlPoint | undefined)
        : undefined;
      const labelAt = labelGeom?.getCoordinates() as [number, number] | undefined;
      this.drag = {
        id: hit.id,
        kind: hit.kind,
        moved: false,
        grab: [...(evt.coordinate as [number, number])],
        origin: [at[0], at[1]],
        label: labelId && labelAt ? { id: labelId, origin: [labelAt[0], labelAt[1]] } : undefined,
      };
      // Otherwise the map pans under the drag and the name goes nowhere: the
      // ground the pointer is over is exactly what panning holds still, so a
      // label pinned to the pointer stays put while the whole plate slides.
      this.setPanning(false);
    };

    const onUp = () => {
      if (this.painting) {
        this.painting = false;
        this.commitPaintStroke();
      }
      if (this.drag) {
        const { id, kind, moved } = this.drag;
        this.drag = null;
        this.setPanning(true);
        if (moved) this.commitDrag(id, kind);
      }
    };

    const onClick = (evt: MapBrowserEvent<PointerEvent>) => {
      const ui = useUIStore.getState();
      const [lon, lat] = this.controller.toLonLat(evt.coordinate);

      switch (ui.tool) {
        case 'settlement': {
          // Clicking a reference city with the settlement tool means that one,
          // not a new nameless dot on top of it.
          const place = this.controller.basemapPlaceAt(evt.pixel);
          if (place) adoptPlace(place);
          else addSettlement([lon, lat]);
          return;
        }
        case 'label':
          addLabel([lon, lat], { text: 'New Label' });
          return;
        case 'fill':
          void this.fillUnclaimed([lon, lat]);
          return;
        case 'select': {
          if (this.dragJustEnded) {
            this.dragJustEnded = false;
            return;
          }
          const hit = this.controller.hitTest(evt.pixel);
          const additive =
            (evt.originalEvent as PointerEvent).shiftKey ||
            (evt.originalEvent as PointerEvent).metaKey ||
            (evt.originalEvent as PointerEvent).ctrlKey;
          if (hit) ui.toggleSelection(hit.id, additive);
          else if (!additive) ui.clearSelection();
          return;
        }
        default:
          return;
      }
    };

    // Double-clicking a reference city adopts it, which is how one gets a name
    // you can edit. Deliberately a double-click: every city sits on somebody's
    // ground, so a single click there means the country, and creating a
    // settlement by brushing past a dot would be nobody's idea of selecting.
    const onDoubleClick = (evt: MapBrowserEvent<PointerEvent>) => {
      if (useUIStore.getState().tool !== 'select') return;
      const place = this.controller.basemapPlaceAt(evt.pixel);
      if (place) adoptPlace(place);
    };

    map.on('pointermove', onMove as never);
    map.on('dblclick' as never, onDoubleClick as never);
    map.on('pointerdown' as never, onDown as never);
    map.on('click', onClick as never);
    const targetUp = () => onUp();
    window.addEventListener('pointerup', targetUp);

    this.pointerHandlers.push(
      () => map.un('pointermove', onMove as never),
      () => map.un('dblclick' as never, onDoubleClick as never),
      () => map.un('pointerdown' as never, onDown as never),
      () => map.un('click', onClick as never),
      () => window.removeEventListener('pointerup', targetUp),
    );
  }

  private dragJustEnded = false;
  private filling = false;

  /**
   * The paint bucket: grow the realm beside a piece of wilderness over the whole
   * of it (spec §6, §57).
   *
   * Asynchronous only because the coastline has to be there before the fill can
   * know where the land ends — after the first click it is cached, so this is a
   * plain click-to-fill. The guard stops a second click starting a second fill
   * while the first is still deciding; the work is measured in hundreds of
   * milliseconds on a big region, and two overlapping fills would each compute
   * against a document the other was about to change.
   */
  private async fillUnclaimed(point: [number, number]): Promise<void> {
    if (this.filling) return;
    this.filling = true;
    try {
      const land = await coastlinePolygons();
      // An explicit selection says which realm should grow; without one the
      // fill goes to whoever already holds most of that ground's edge.
      const ui = useUIStore.getState();
      const project = getProject();
      const preferred = ui.selection.find((id) => project.territories[id]) ?? null;
      const walls = ui.fillStopsAtLines ? await barrierLines(project, ui.selection) : [];
      const waters = await barrierWaters();

      const result = fillLandAt(point, land, preferred, walls, waters);
      toast(result.message, result.filled ? 'success' : 'warn');
    } catch (err) {
      toast(`Could not fill: ${(err as Error).message}`, 'error');
    } finally {
      this.filling = false;
    }
  }

  private sourceFor(kind: 'settlement' | 'label') {
    return kind === 'settlement' ? this.controller.settlementSource : this.controller.labelSource;
  }

  /**
   * Let the map pan, or hold it still.
   *
   * Dragging a settlement or a label is our own gesture on top of the map's, and
   * the two mean opposite things with the same pointer: panning keeps the ground
   * under the pointer fixed, which is precisely what a drag needs to change.
   */
  private setPanning(on: boolean): void {
    this.map().getInteractions().forEach((i) => {
      if (i instanceof DragPan) i.setActive(on);
    });
  }

  /** Move the OL feature only; the document is written once, on pointer-up. */
  private previewDrag(id: UUID, kind: 'settlement' | 'label', at: [number, number]): void {
    const f = this.sourceFor(kind).getFeatureById(id);
    const geom = f?.getGeometry() as OlPoint | undefined;
    if (!geom) return;
    geom.setCoordinates(at);

    // A settlement drags its name along with it, wherever the name was put:
    // one that follows the dot lands back on the dot, one that was placed by
    // hand keeps the placement and travels the same distance.
    const carried = this.drag?.label;
    if (kind === 'settlement' && carried) {
      const project = getProject();
      const s = project.settlements[id];
      const manual = s?.labelId ? project.labels[s.labelId]?.manualPosition : false;
      const lf = this.controller.labelSource.getFeatureById(carried.id);
      const to: [number, number] = manual
        ? [
            carried.origin[0] + (at[0] - this.drag!.origin[0]),
            carried.origin[1] + (at[1] - this.drag!.origin[1]),
          ]
        : at;
      (lf?.getGeometry() as OlPoint | undefined)?.setCoordinates(to);
    }
    this.controller.repaint();
  }

  private commitDrag(id: UUID, kind: 'settlement' | 'label'): void {
    const geom = this.sourceFor(kind).getFeatureById(id)?.getGeometry() as OlPoint | undefined;
    if (!geom) return;
    this.dragJustEnded = true;

    if (kind === 'settlement') {
      moveSettlement(id, this.controller.toLonLat(geom.getCoordinates()));
      return;
    }

    // Dropping a label clears its pixel offset, so anything the offset was
    // holding has to move into the anchor or the text jumps out from under the
    // cursor at the moment it is let go.
    const offset = getProject().labels[id]?.offset ?? [0, 0];
    let dropped = geom.getCoordinates();
    if (offset[0] || offset[1]) {
      const px = this.map().getPixelFromCoordinate(dropped);
      if (px) dropped = this.map().getCoordinateFromPixel([px[0] + offset[0], px[1] + offset[1]]);
    }
    moveLabel(id, this.controller.toLonLat(dropped));
  }

  // -------------------------------------------------------------------------
  // Select (spec §2)
  // -------------------------------------------------------------------------

  private setupSelect(): void {
    // Box select: shift-drag on empty space.
    const dragBox = new DragBox({
      condition: (evt) => {
        const oe = evt.originalEvent as PointerEvent;
        return oe.shiftKey === true;
      },
    });
    dragBox.on('boxend', () => {
      const extent = dragBox.getGeometry().getExtent();
      const ids: UUID[] = [];
      const project = getProject();
      this.controller.territorySource.forEachFeatureIntersectingExtent(extent, (f) => {
        const id = f.getId();
        if (typeof id === 'string' && !project.territories[id]?.locked) ids.push(id);
      });
      this.controller.settlementSource.forEachFeatureInExtent(extent, (f) => {
        const id = f.getId();
        if (typeof id === 'string' && !project.settlements[id]?.locked) ids.push(id);
      });
      this.controller.labelSource.forEachFeatureInExtent(extent, (f) => {
        const id = f.getId();
        if (typeof id === 'string' && !project.labels[id]?.locked) ids.push(id);
      });
      const ui = useUIStore.getState();
      const existing = new Set(ui.selection);
      for (const id of ids) existing.add(id);
      ui.setSelection([...existing]);
    });
    this.add(dragBox);
  }

  // -------------------------------------------------------------------------
  // Territory drawing (spec §5)
  // -------------------------------------------------------------------------

  private setupDrawTerritory(): void {
    const draw = new Draw({
      source: this.controller.overlaySource,
      type: 'Polygon',
      style: drawingStyle(),
    });
    draw.on('drawend', (evt) => {
      const geom = evt.feature.getGeometry() as OlPolygon;
      const wgs = geojson.writeGeometryObject(geom, {
        featureProjection: this.map().getView().getProjection(),
        dataProjection: 'EPSG:4326',
        rightHanded: true,
      }) as Polygon;
      // Defer so the draw interaction finishes before the store change re-syncs.
      setTimeout(() => {
        this.controller.overlaySource.clear(true);
        addTerritory(wgs);
        useUIStore.getState().setTool('select');
      }, 0);
    });
    this.add(draw);
    this.addSnap();
  }

  /** Rectangle helper, exposed for the shape tool. */
  setupDrawBox(onDone: (poly: Polygon) => void): void {
    this.clearInteractions();
    const draw = new Draw({
      source: this.controller.overlaySource,
      type: 'Circle',
      geometryFunction: createBox(),
      style: drawingStyle(),
    });
    draw.on('drawend', (evt) => {
      const geom = evt.feature.getGeometry() as OlPolygon;
      const wgs = geojson.writeGeometryObject(geom, {
        featureProjection: this.map().getView().getProjection(),
        dataProjection: 'EPSG:4326',
        rightHanded: true,
      }) as Polygon;
      setTimeout(() => {
        this.controller.overlaySource.clear(true);
        onDone(wgs);
      }, 0);
    });
    this.add(draw);
  }

  // -------------------------------------------------------------------------
  // Vertex editing (spec §2, §6)
  // -------------------------------------------------------------------------

  private setupVertexEdit(): void {
    const selection = useUIStore.getState().selection;
    const project = getProject();
    const editable = selection.filter((id) => project.territories[id] && !project.territories[id].locked);

    const features = new Collection<Feature<Geometry>>(
      (editable.length
        ? editable
        : Object.keys(project.territories).filter((id) => !project.territories[id].locked)
      )
        .map((id) => this.controller.territorySource.getFeatureById(id))
        .filter((f): f is Feature<Geometry> => !!f),
    );

    if (features.getLength() === 0) {
      useUIStore.getState().toast('Nothing to edit — draw or select a territory first.', 'warn');
      return;
    }

    // Snapshot geometry at the start of a modify gesture so the shared-border
    // system can diff old against new and carry the change into neighbours.
    const before = new Map<UUID, Polygon | MultiPolygon>();

    const modify = new Modify({
      features,
      style: vertexStyle(),
      // Alt-click deletes a vertex; that is the OpenLayers default and matches
      // the convention in Illustrator and QGIS.
      deleteCondition: (evt) => {
        const oe = evt.originalEvent as PointerEvent;
        return oe.type === 'pointerdown' && (oe.altKey || (oe as PointerEvent & { button: number }).button === 2);
      },
    });

    modify.on('modifystart', (evt) => {
      before.clear();
      evt.features.forEach((f) => {
        const id = f.getId();
        if (typeof id !== 'string') return;
        const g = getProject().territories[id]?.geometry;
        if (g) before.set(id, g);
      });
    });

    modify.on('modifyend', (evt) => {
      const viewProj = this.map().getView().getProjection();
      evt.features.forEach((f) => {
        const id = f.getId();
        if (typeof id !== 'string') return;
        const geom = f.getGeometry();
        if (!geom) return;
        const wgs = geojson.writeGeometryObject(geom, {
          featureProjection: viewProj,
          dataProjection: 'EPSG:4326',
          rightHanded: true,
        }) as Polygon | MultiPolygon;
        updateTerritoryGeometry(id, wgs);
      });
    });

    this.add(modify);
    this.addSnap();
  }

  // -------------------------------------------------------------------------
  // Redrawing a border by hand (spec §5, §6, §21)
  // -------------------------------------------------------------------------

  /**
   * A pencil for borders: hold the button down and draw over the stretch you
   * want changed, starting and finishing on the outline.
   *
   * Freehand, because that is the point — a click-per-vertex tool for this
   * already exists and is the vertex editor. `freehand: true` also takes the
   * drag away from panning for as long as the tool is active, which is what
   * makes it feel like a pencil rather than a map.
   */
  private setupReshape(): void {
    const draw = new Draw({
      source: this.controller.overlaySource,
      type: 'LineString',
      freehand: true,
      style: drawingStyle(),
    });
    draw.on('drawend', (evt) => {
      const geom = evt.feature.getGeometry() as OlLineString;
      const wgs = geojson.writeGeometryObject(geom, {
        featureProjection: this.map().getView().getProjection(),
        dataProjection: 'EPSG:4326',
      }) as LineString;

      setTimeout(() => {
        this.controller.overlaySource.clear(true);
        const project = getProject();
        const start = wgs.coordinates[0];
        if (!start) return;

        // How near an end has to land to count as "on the border", in degrees:
        // a pencil's worth of aim at the current zoom, so it follows the zoom
        // rather than being a fixed distance on the ground that is generous at
        // one scale and unusable at the other. Generous on purpose — this is a
        // freehand tool, and a stroke that begins a few pixels off the line is
        // plainly meant for it.
        const view = this.map().getView();
        const metres = (view.getResolution() ?? 1) * metersPerUnit(view.getProjection().getUnits());
        const tolerance = Math.max(0.0005, (metres * 28) / 111_320);

        // The territory whose border it is: the selected one, or whichever
        // outlines the stroke started near.
        //
        // Near, plural. A stroke drawn over a frontier starts on two realms at
        // once — they share that line — and which of them measures a hair
        // closer is a coin toss the user cannot see or control. Taking only the
        // winner meant that half the time the pencil was handed the realm for
        // which the gesture happened not to work, and refused. So the ones
        // within reach are ranked and each is offered the stroke in turn.
        const selection = useUIStore.getState().selection;
        const chosen = selection.find((id) => project.territories[id]);
        let candidates: UUID[];
        if (chosen) {
          candidates = [chosen];
        } else {
          const near: { id: UUID; d: number }[] = [];
          for (const t of Object.values(project.territories)) {
            if (t.locked || t.hidden) continue;
            const d = distanceToBoundary(t.geometry, start);
            // A stroke that began nowhere near a border is not a reshape.
            if (d <= tolerance * 4) near.push({ id: t.id, d });
          }
          near.sort((a, b) => a.d - b.d);
          candidates = near.slice(0, 4).map((n) => n.id);
        }
        const targetId = candidates[0];
        const tryReshape = () =>
          candidates.some((id) => reshapeTerritoryBoundary(id, wgs, tolerance, true));
        // Three gestures, separated by the stroke's own shape *before* anything
        // is tried. A loop — a stroke that comes back to its start — is an area
        // being drawn: a subdivision if it lands inside a state, a new state if
        // it lands on open ground. A stroke that stays open is a stretch of
        // border being moved. The shape test has to come first rather than
        // falling through from a failed reshape, because the failure is not
        // reliable: a loop drawn near a border begins and ends "on" it as far
        // as the freehand tolerance cares, and the reshape "succeeds" by
        // grafting the whole loop onto the neighbour as a lobe.
        if (strokeCloses(wgs)) {
          if (subdivisionFromStroke(wgs)) return;
          if (stateFromStroke(wgs)) return;
          // A loop that is neither — straddling a border, or mostly over
          // somebody's ground without being inside anyone — may still be a
          // whole-outline redraw of a small state, so the reshape gets it last.
          if (tryReshape()) return;
          useUIStore
            .getState()
            .toast(
              'That shape straddles a border. Draw it inside a state for a subdivision, or on open ground for a new state.',
              'warn',
            );
          return;
        }
        if (tryReshape()) return;
        useUIStore
          .getState()
          .toast(
            targetId
              ? 'That stroke could not be fitted to the border. Draw over the line itself, starting and finishing on it.'
              : 'Draw over a border, starting and finishing on the same outline — or close the stroke into a shape: inside a state for a subdivision, on open ground for a new state.',
            'warn',
          );
      }, 0);
    });
    this.add(draw);
    this.addSnap();
  }

  // -------------------------------------------------------------------------
  // Cut / split (spec §5)
  // -------------------------------------------------------------------------

  private setupCut(): void {
    const draw = new Draw({
      source: this.controller.overlaySource,
      type: 'LineString',
      style: drawingStyle(),
    });
    draw.on('drawend', (evt) => {
      const geom = evt.feature.getGeometry() as OlLineString;
      const wgs = geojson.writeGeometryObject(geom, {
        featureProjection: this.map().getView().getProjection(),
        dataProjection: 'EPSG:4326',
      }) as LineString;

      setTimeout(() => {
        this.controller.overlaySource.clear(true);
        const selection = useUIStore.getState().selection;
        const project = getProject();
        // Cut the selected territory, or whichever one the line starts inside.
        let targetId = selection.find((id) => project.territories[id]);
        if (!targetId) {
          const start = wgs.coordinates[0];
          for (const t of Object.values(project.territories)) {
            if (t.locked) continue;
            try {
              if (
                turf.booleanPointInPolygon(turf.point([start[0], start[1]]), {
                  type: 'Feature',
                  properties: {},
                  geometry: t.geometry,
                })
              ) {
                targetId = t.id;
                break;
              }
            } catch {
              /* ignore malformed geometry */
            }
          }
        }
        if (!targetId) {
          useUIStore.getState().toast('Select the territory to split, or start the line inside it.', 'warn');
          return;
        }
        splitTerritoryWithLine(targetId, wgs);
        useUIStore.getState().setTool('select');
      }, 0);
    });
    this.add(draw);
    this.addSnap();
  }

  // -------------------------------------------------------------------------
  // Rivers and roads (spec §15, §16)
  // -------------------------------------------------------------------------

  private setupDrawLinear(tool: 'river' | 'road'): void {
    const draw = new Draw({
      source: this.controller.overlaySource,
      type: 'LineString',
      style: drawingStyle(),
    });
    draw.on('drawend', (evt) => {
      const geom = evt.feature.getGeometry() as OlLineString;
      const wgs = geojson.writeGeometryObject(geom, {
        featureProjection: this.map().getView().getProjection(),
        dataProjection: 'EPSG:4326',
      }) as LineString;

      setTimeout(() => {
        this.controller.overlaySource.clear(true);
        const ui = useUIStore.getState();
        const project = getProject();
        const kind = ui.draftLinearKind || (tool === 'river' ? 'river' : 'road-major');
        const feature = makeLinear(project, wgs, {
          kind,
          name: tool === 'river' ? 'New River' : 'New Road',
        });
        commit(tool === 'river' ? 'Draw river' : 'Draw road', (r) => r.set('linearFeatures', feature));
        ui.selectAndReveal([feature.id]);
      }, 0);
    });
    this.add(draw);
    this.addSnap();
  }

  // -------------------------------------------------------------------------
  // Measure (spec §52 toolbar)
  // -------------------------------------------------------------------------

  private setupMeasure(): void {
    const draw = new Draw({
      source: this.controller.overlaySource,
      type: 'LineString',
      style: drawingStyle(),
    });

    const report = (geom: OlLineString) => {
      const wgs = geojson.writeGeometryObject(geom, {
        featureProjection: this.map().getView().getProjection(),
        dataProjection: 'EPSG:4326',
      }) as LineString;
      if (wgs.coordinates.length < 2) return;
      const km = turf.length(turf.lineString(wgs.coordinates), { units: 'kilometers' });
      useUIStore
        .getState()
        .setStatus(`Distance: ${km < 10 ? km.toFixed(2) : Math.round(km).toLocaleString()} km  ·  ${(km * 0.621371).toFixed(km < 10 ? 2 : 0)} mi`);
    };

    draw.on('drawstart', (evt) => {
      const geom = evt.feature.getGeometry() as OlLineString;
      geom.on('change', () => report(geom));
    });
    draw.on('drawend', (evt) => report(evt.feature.getGeometry() as OlLineString));
    this.add(draw);
    this.addSnap();
  }

  // -------------------------------------------------------------------------
  // Paint tool (spec §56)
  // -------------------------------------------------------------------------

  private paintAt(evt: MapBrowserEvent<PointerEvent>): void {
    const ui = useUIStore.getState();
    if (!ui.paintTargetId) {
      ui.setStatus('Pick a state to paint with in the Inspector.');
      return;
    }
    const hits = this.controller.territoriesAtPixel(evt.pixel);
    const project = getProject();
    for (const id of hits) {
      if (id === ui.paintTargetId) continue;
      const t: Territory | undefined = project.territories[id];
      if (!t || t.locked) continue;
      if (t.parentId === ui.paintTargetId) continue; // already assigned
      this.paintStroke.add(id);
    }
    // Immediate visual feedback: highlight what the stroke has picked up.
    if (this.paintStroke.size) ui.setSelection([...this.paintStroke]);
  }

  /** One undo entry per paint stroke, not per subdivision touched. */
  private commitPaintStroke(): void {
    const ui = useUIStore.getState();
    const target = ui.paintTargetId;
    if (!target || this.paintStroke.size === 0) return;
    const ids = [...this.paintStroke];
    this.paintStroke.clear();
    paintTerritory(target, ids);
    ui.setSelection([target]);
    ui.setStatus(`Assigned ${ids.length} division${ids.length === 1 ? '' : 's'}.`);
    setTimeout(() => useUIStore.getState().setStatus(null), 2500);
  }

  // -------------------------------------------------------------------------
  // Snap indicator
  // -------------------------------------------------------------------------

  showSnapIndicator(lonlat: [number, number] | null): void {
    this.controller.overlaySource.clear(true);
    if (!lonlat) return;
    const f = new Feature({ geometry: new OlPoint(this.controller.toView(lonlat)) });
    f.setStyle(snapIndicatorStyle());
    this.controller.overlaySource.addFeature(f);
  }
}

function cursorFor(tool: ToolId): string {
  switch (tool) {
    case 'pan':
      return 'grab';
    case 'territory':
    case 'cut':
    case 'river':
    case 'road':
    case 'measure':
      return 'crosshair';
    case 'settlement':
    case 'label':
      return 'copy';
    case 'paint':
      return 'cell';
    case 'fill':
      return 'crosshair';
    default:
      return 'default';
  }
}
