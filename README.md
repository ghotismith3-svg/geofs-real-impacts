# geofs-real-impacts
Precision crash detection for GeoFS — you only crash when you actually hit a real tree or building, not from the game's default lenient heuristics.
# geofs-real-impact

A Tampermonkey userscript for [GeoFS](https://www.geo-fs.com/) that replaces the game's default (very lenient) crash detection with one based on **real, exact-position obstacle detection** — you only crash when you actually hit a real tree or a real building, not from GeoFS's default heuristics. Runways, open fields, and water stay safe even skimming at very low altitude.

## Why this exists

GeoFS's built-in crash detection is fairly forgiving, especially around scenery objects. This script adds a stricter, more "real" layer on top: it checks the *exact* position under the aircraft for two categories of real obstacles, and only then forces an actual crash — engine cutout plus a forced, uncontrollable tumble, not just a cosmetic message.

## How detection works

- **Buildings** — detected via Cesium's `scene.sampleHeight()`, compared against the raw terrain height at the same point. This works because 3D building tilesets (OSM Buildings, Google Photorealistic 3D Tiles) are real `Cesium3DTileset` objects that Cesium's picking APIs can see.
- **Trees** — GeoFS renders trees through its own custom pipeline, completely outside Cesium's standard rendering path. Three separate approaches were tested to confirm this: `scene.pick()`/`drillPick()`, `scene.sampleHeight()`, and `scene.pickPosition()` (with and without `pickTranslucentDepth`) — none of them can see GeoFS's trees at all. Because of that, tree detection here depends on a companion script, **[geofs-real-tree-positions](https://github.com/yasseristaken/geofs-real-tree-positions)**, which decodes GeoFS's tree tiles directly and exposes real tree coordinates via `window.geofsRealTrees`. Without that script installed, this one still works fine for buildings — it just logs that tree detection isn't available.

## Requirements

- [Tampermonkey](https://www.tampermonkey.net/) or a similar userscript manager.
- **For tree detection specifically**: [geofs-real-tree-positions](https://github.com/yasseristaken/geofs-real-tree-positions) installed and active. Not required for building detection.

## Installation

1. Install Tampermonkey.
2. Create a new script and paste in the contents of the `.user.js` file from this repo.
3. (Recommended) Also install `geofs-real-tree-positions` for tree detection to work.
4. Reload GeoFS.

## Usage

Press `]` in-game to open the settings console:

- **Max altitude to count as impact** — how close to the ground (above bare terrain) the check needs to be to even start looking for obstacles. Default 80ft, tuned to catch tall tree canopies without triggering during normal cruise flight.
- **Min speed to arm the crash check** — filters out slow taxiing, so you don't get flagged for creeping past scenery at walking pace.
- **Object height threshold (buildings)** — how much taller than bare terrain something needs to be at your exact position to count as a building.
- **Tree detection radius** — how close a real extracted tree position needs to be to your aircraft to count as a hit.
- **Sampling offset** — used only for the building check, to avoid the aircraft's own fuselage being mistaken for an "object" by `sampleHeight`.

## Known limitations

- Detection runs on a ~200ms loop, not every frame — at high speed it's possible to slip past a narrow obstacle in the gap between checks.
- The tree detection radius is a single circle around the aircraft's exact position, not modeled against wingspan — a wingtip strike on a tree slightly off to the side may not register.
- Depends on the internal structure of both GeoFS and the companion tree-extractor script; updates to either may require adjustments here.

## License

CC BY 4.0 — see [LICENSE](./LICENSE). Use it, fork it, build on it — just credit the source.
