# After the Fall

An interactive editor for **historical, political and alternate-history maps** — the kind of thing
you find in a printed historical atlas, not a video-game strategy map. It runs entirely in the
browser, needs no server, and is structured so it can be packaged with Tauri later.

![The demonstration map exported to SVG](docs/demo-export.png)

*The bundled demonstration map, exported to SVG at 3000 × 2100. Everything in it — territories,
hierarchy tints, border weights, hatching, city symbols, tracked country names, river labels
following the river, graticule, frame, title block and scale bar — is produced by the editor.*

![The editor](docs/editor.png)

*The editor itself: tool palette, layer/hierarchy tree, map, and object inspector.*

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

```bash
npm run build        # typecheck + production bundle into dist/
npm run test         # 88 unit tests over the geometry, history and export code
npm run typecheck    # tsc, no emit
```

The first launch loads a demonstration map (a fictional partition of the north-eastern United
States) so the feature set is visible immediately. **New** starts a blank map or one seeded with
real geography.

Reference geography (Natural Earth coastlines and country outlines, US Census states and counties)
ships in `public/data/` and is fetched lazily — nothing is downloaded at runtime.

### Deploying to GitHub Pages

`.github/workflows/pages.yml` typechecks, tests, builds and publishes on every push to the default
branch, and can also be run by hand from the Actions tab. It needs Pages switched on once, by a repo
admin: **Settings ▸ Pages ▸ Build and deployment ▸ Source: GitHub Actions**.

Pages serves from a sub-path (`/<repo>/`), which is why `vite.config.ts` sets `base: './'` and the
bundled geography is fetched with document-relative URLs. Both are load-bearing — changing either to
an absolute path will break a sub-path deployment.

---

## What the recurring cartographic elements are, and where each one lives

The spec's visual target (§59) decomposes into a handful of recurring elements. This is how each is
handled:

| Element | Implementation |
|---|---|
| Pastel political fills | `TerritoryStyle.fillColor` + the palette generator (`geo/palette.ts`) |
| Thin internal boundaries, heavy sovereign ones | Borders are **derived**, not drawn — `render/borders.ts` |
| Detailed coastline geometry | Real Natural Earth / Census data, convertible to editable territories |
| Widely-spaced country names | Per-glyph text rendering with real tracking — `render/textRenderer.ts` |
| Sea labels on broad curves, river labels along rivers | Text-on-path, same module |
| City circles, larger capital symbols | `render/symbols.ts`, one definition drawn to canvas *and* SVG |
| Disputed-territory hatching | `render/patterns.ts`, one definition → `CanvasPattern` *and* `<pattern>` |
| Latitude/longitude grid, frame, title, scale bar | `export/svgExport.ts` and the OpenLayers graticule layer |
| Large maps suitable for print | Export up to 12000 × 8000 raster, unbounded vector |

---

## Architecture

The spec's §60 requirement — separate geographic data from cartographic appearance from UI state —
is the organising principle of the whole codebase, not a note in a comment.

```
GEOGRAPHIC DATA          CARTOGRAPHIC APPEARANCE        UI STATE
src/model/types.ts       src/model/defaults.ts          src/state/uiStore.ts
  Territory                StyleSheet                     tool, selection, hover
  Settlement               TerritoryStyle                 snap settings
  LinearFeature            LineStyle / TextStyle           dialogs, toasts
  MapLabel                 SymbolStyle / HatchPattern
  geometry: GeoJSON        referenced by id,            never serialised
  always WGS84             overridable per object       into a project file
```

A `Territory` stores *where it is* and *what it is*. It stores no colours — only a `styleClassId`
and a sparse `styleOverrides` patch. Change the "Country Border" style class and every border using
it changes, which is what keeps a map with a thousand features consistent (§40).

### Directory structure

```
src/
  model/            The document. Pure data, no rendering, no OpenLayers.
    types.ts          Every interface in §61. The single source of truth.
    defaults.ts       Built-in style classes, border hierarchy, palettes.
    project.ts        Project construction, default layer stack, schema migration.
    hierarchy.ts      Territory and layer tree traversal (flat storage → tree views).
    resolveStyle.ts   styleClass + overrides + parent inheritance → final appearance.
    color.ts          Colour maths: shading, perceptual distance, contrast.
    timeline.ts       Year-range filtering.
    ids.ts

  geo/              Geometry. Turf-backed, no UI.
    operations.ts     union / difference / intersect / dissolve / split / simplify.
    topology.ts       The shared-border system. See below.
    projections.ts    Projection catalogue and registration.
    winkelTripel.ts   Winkel Tripel + Natural Earth (proj4 ships neither).
    palette.ts        Graph-colouring palette generator.
    basemap.ts        Reference geography loading.

  state/            Zustand stores and the command layer.
    history.ts        Patch-based undo/redo. Every write goes through `Recorder`.
    projectStore.ts   The document + undo stacks + feature factories.
    uiStore.ts        Session state. Never saved.
    commands.ts       Every user-facing operation, in exactly one place.

  render/           Document → pixels.
    MapController.ts  Owns the OpenLayers map. Diffs the store by object identity.
    borders.ts        Derives border lines from territory adjacency.
    olStyles.ts       Resolved style → cached OpenLayers Style.
    textRenderer.ts   Per-glyph text: tracking, halo, text-on-path, collision boxes.
    symbols.ts        Settlement symbols as primitives → canvas and SVG.
    patterns.ts       Hatch fills → CanvasPattern and <pattern>.

  tools/
    ToolManager.ts    All OpenLayers interactions, swapped by active tool.

  export/
    svgExport.ts      A real vector serialiser. Text stays text.
    pngExport.ts      Rasterises the SVG, so PNG and SVG always agree.

  io/importers.ts     GeoJSON / TopoJSON / KML / GPX / CSV, and basemap → territory.
  persistence/        Dexie storage, autosave, .atfmap file format.
  components/         React UI. Never in the map's render path.
  demo/               The demonstration map. Test data only.
```

### Why React never renders the map

§51 asks that moving one vertex must not re-render the application. It doesn't:

* React mounts `MapController` once and renders only chrome — toolbar, panels, dialogs.
* The controller subscribes to the store directly and **diffs by object identity**. Because an edit
  produces new objects only for the records it touched, syncing a one-vertex change touches exactly
  one OpenLayers feature out of however many exist.
* Styles are cached on their resolved appearance, so the per-frame style function is a map lookup.
* During a vertex drag, OpenLayers owns the frame; the store is written once, on `modifyend`.

---

## The shared-border system (§6)

This is the feature the spec calls "extremely important", and it deserves an explanation of what was
built and why.

There are two ways to guarantee adjacent territories never develop gaps or overlaps:

**(a) Store a true planar graph** — nodes, edges, and faces referencing directed edge rings.
Topologically airtight by construction. But then every import, export, boolean operation and undo
patch has to go through the graph, GeoJSON round-trips stop being trivial, and the project file
stops being something you can read.

**(b) Store ordinary polygons and actively maintain the invariant.**

This implements **(b)**, through three mechanisms in `geo/topology.ts`:

1. **Snapping** (`snapPosition`, plus OpenLayers' `Snap` on every drawing tool). New and dragged
   vertices latch onto existing vertices and edges, so a shared boundary starts out *genuinely*
   coincident — the same coordinates in both polygons, not merely close.

2. **Propagation** (`propagateVertexEdit`) — the part that makes a border behave as one border.
   When a territory's geometry changes, the before and after are diffed to find which vertices
   moved, and every neighbour holding a vertex at one of those positions is moved with it, in the
   same undo command. Move the border between Kingdom A and Kingdom B and both polygons update.

   Vertices are matched by index rather than by value, which is exact for dragging one vertex,
   dragging several, and translating a whole polygon. If the edit *inserted or deleted* a vertex the
   correspondence is genuinely ambiguous, so `diffVertexMoves` returns `null` and propagation is
   skipped rather than guessing and corrupting a neighbour.

3. **Validation and repair** (`validateTopology`, `repairTopology`) for whatever slips through.
   Repair runs three passes, ordered so each makes the next easier:
   * **weld** near-coincident vertices onto one shared position — this removes the *cause* of most
     slivers rather than the symptom;
   * **subtract overlaps** from whichever territory is smaller;
   * **fill sliver gaps** into whichever neighbour surrounds most of the gap.

   A parent territory legitimately covers its own subdivisions, so ancestor/descendant pairs are
   excluded from overlap checks — otherwise every hierarchical map would report false errors.
   Anything larger than the sliver limit is reported but never silently changed, and the tool says
   so rather than claiming all is well. Locked territories are never touched. The whole repair is
   one undo step.

The API is deliberately shaped so a future move to design (a) could sit behind it unchanged.

### Derived borders (§8, §57)

Territories store **areas**. The lines between them are computed in `render/borders.ts`: every
boundary segment is classified by looking at who is on each side.

* Both sides under the same sovereign → the *finer* of the two border weights (an internal hairline).
* Different sovereigns → the *heavier* weight (a sovereign border).
* Nobody on the other side → that territory's own weight (its coast or outer frontier).

That single rule is what §57 asks for: assign counties to states with the paint tool, and the
national borders appear and disappear on their own. Segments are hashed on their endpoints, so
exactly-shared edges — the ones snapping and welding produce — match in constant time, and the
result is memoised on the territory set so panning never recomputes it.

---

## The territory paint system (§55, §56)

The intended workflow for an alternate-history map of somewhere real:

1. **Project ▸ Reference geography ▸ Convert to territories…** Pick a dataset (US counties, say),
   filter it to a state or a name list, and import one editable `Territory` per feature.
2. Draw or import the state you want to build, then switch to the **Paint** tool (`B`) and choose it
   in the Inspector.
3. Drag across subdivisions on the map. Each one gets `parentId` set to the target, its border
   demoted to county weight, and the parent's own outline grown to the union of everything assigned
   to it. One undo entry per stroke, not per county.
4. The border hierarchy does the rest: internal boundaries fade to hairlines, and a sovereign border
   appears wherever differently-assigned subdivisions touch.

The same dissolve machinery backs **Create Territory from Selection**: select several divisions,
and they become one new state with their internal borders erased, preserved underneath as
subordinate divisions with inherited colour.

---

## SVG export (§48, §66)

`export/svgExport.ts` is a real vector serialiser, not a canvas dump.

* Polygons, borders and symbols are written as `<path>`, `<circle>`, `<polygon>`.
* **Text stays text** — `<text>` and `<tspan>`, never outlined, never rasterised.
* Tracking becomes `letter-spacing`; halos become `paint-order="stroke"`; text-on-path becomes a
  real `<textPath>`.
* Hatch fills become `<pattern>` defs generated from the *same* description the canvas renderer
  uses, so what exports is what you were looking at.
* Groups are emitted in exactly the order §66 specifies, so the file opens in Illustrator or
  Inkscape with a sane layer structure:

```
water · terrain · territories · internal-borders · international-borders ·
rivers · roads · settlements · labels · graticule · legend · frame
```

Territory groups carry `data-name` and `data-type` attributes, so an exported map is still
identifiable after it leaves the app.

**PNG export rasterises that same SVG** rather than screenshotting the live map — one renderer, one
result, and output sizes bounded only by what a browser canvas will hold (very large images are
drawn in bands so peak memory is one band, not the whole picture).

---

## Projections (§4)

Geometry is always stored in WGS84. A projection is purely a *view* concern, so switching one
re-projects on the fly and never touches stored coordinates.

Mercator · Equirectangular · Robinson · **Winkel Tripel** · **Natural Earth** · Mollweide ·
Lambert Conformal Conic · Albers Equal Area · Orthographic · plus any custom proj4 string.

proj4js ships neither Winkel Tripel nor Natural Earth, so both are implemented in
`geo/winkelTripel.ts` against proj4's documented extension contract. Neither has a closed-form
inverse: Winkel Tripel is inverted by two-dimensional Newton–Raphson, Natural Earth by a scalar
Newton iteration on its polynomial. `winkelTripel.test.ts` round-trips a grid of control points
through both to prove the inverses are right.

---

## Undo/redo (§36)

Snapshotting the document per edit is simple but wasteful — a 2,000-polygon map is megabytes, and
the spec asks for at least 100 states. Instead every edit records a **patch**: the before and after
value of each record it touched. Undo replays `before`, redo replays `after`. Nudging one vertex
costs one polygon, not one map.

Every mutation funnels through `Recorder`; there is deliberately no other way to write to the
document, which is what makes undo complete rather than merely mostly-complete. Selection is
captured with each command, so undo restores what you had selected. The stack holds 200 states.

---

## Project format (§49, §50)

`.atfmap` files are the `MapProject` object in a small envelope — plain JSON, GeoJSON geometry,
string ids. Nothing is a rendered pixel, so a saved map is always fully editable. `migrate()`
upgrades older files additively and re-seeds any built-in style a file predates; a file from a newer
schema is refused with an explanation rather than silently mangled.

Maps are also autosaved into IndexedDB every 20 seconds, with rolling recovery snapshots written
periodically and before any load that would replace unsaved work.

---

## Current state

Phase 1 is complete, and the parts of Phases 2–4 that the priority list in §67 puts near the top
are in as well. Everything listed here works — there are no placeholder controls in the UI.

**Editing** — territory drawing, vertex editing with add/remove, merge, subtract, split-with-a-line,
dissolve-from-selection, the paint tool, duplicate, lock, hide, delete, box-select, multi-select,
bulk edit, context menus, 200-state undo.

**Topology** — snapping, shared-vertex propagation, gap/overlap/sliver detection with a preview
list, three-pass repair, simplify, smooth, remove-tiny-polygons.

**Structure** — unlimited territory hierarchy with colour inheritance, nested layer groups with
visibility/lock/opacity/reorder/rename/duplicate/delete, named style classes with per-object
overrides.

**Cartography** — border hierarchy with derived borders, hatch patterns, the palette generator,
settlements with ten symbol types, rivers and roads, labels with real tracking, halos, rotation,
manual placement and text-on-path, graticule, frames, title block, scale bar.

**Data** — real world/US geography, GeoJSON/TopoJSON/KML/GPX/CSV import, basemap→territory
conversion, reference-image tracing, spreadsheet data table, search, GeoJSON/CSV/SVG/PNG export,
IndexedDB storage with autosave and recovery snapshots.

**Timeline** — start/end years on every feature, and the slider filters territories, subdivisions,
borders, settlements, lines and labels on both the screen and the export.

### Not built yet

Stated plainly rather than stubbed out:

* **Legend creator (§26)** — the SVG export emits an empty `<g id="legend">` so the structure is
  there, but there is no legend editor.
* **Compass rose (§28)** and **coordinate index (§29)**.
* **Terrain (§18)** beyond importing polygons as territories — no mountain symbols or hillshading.
* **PDF export (§48)** — SVG into a print pipeline is the current answer.
* **Masking/clipping (§46)** and **border labels (§44)**.
* **Shapefile import** — GeoJSON, TopoJSON, KML, GPX and CSV are supported instead.
* **Label collision** — the detection primitives exist (`findCollisions`, per-label boxes and an
  opt-out flag), but they are not yet surfaced as warnings in the UI.
* Reference images are a session aid and are not written into the project file.

---

## Tests (§64)

88 tests covering the parts where a silent regression would be expensive:

* `geo/operations.test.ts` — union, difference, intersection, dissolve, polygon splitting along
  straight and bent lines, simplification, interior-point placement for concave shapes.
* `geo/topology.test.ts` — vertex diffing, shared-border propagation (including that unrelated and
  locked neighbours are left alone), snapping, gap/overlap detection, hierarchy exclusion, all three
  repair passes, derived borders and segment merging.
* `state/history.test.ts` — patch recording, undo/redo round-trips, reverse replay of multiple
  writes to one record, redo-stack invalidation, 100+ history states, save/load round-trip, schema
  migration and version refusal.
* `export/svgExport.test.ts` — group presence and ordering, text staying text, tracking and halo
  attributes, pattern defs, border classification, symbol shapes, graticule, frame, title, style
  scaling, XML escaping, timeline filtering.
* `geo/winkelTripel.test.ts` — forward/inverse round-trips for all four numerically-inverted
  projections, plus the symmetry and pseudocylindrical properties each one should have.

---

## Licence and data

Application code is unlicensed pending a decision. The bundled geography is public domain:
[Natural Earth](https://www.naturalearthdata.com/) via `world-atlas`, and US Census cartographic
boundaries via `us-atlas`, both redistributed under their original terms.
