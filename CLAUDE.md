# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

The main deliverable is `kade-bg-gis.user.js`, which enriches the kade.si hiking portal with Bulgarian public GIS data (ИАГ GeoServer, КАИС cadastre, Natura/ЗЗТ). The other two files are extras around the same ИАГ data. README is organized the same way (main script first, the rest under „Бонус инструменти"); keep that emphasis.

- `kade-bg-gis.user.js` — **the main script.** A kade.si userscript (OpenLayers; exposes globals `map`, `ol`, `layerSwitcher`). Carries `@grant GM_xmlhttpRequest`/`unsafeWindow` + `@connect natura2000.egov.bg`, so kade.si globals are reached via `unsafeWindow` (aliased `PAGE`). Two parts:
  - **Overlays** (`OVERLAYS`): toggleable layers. IAG layers use WMS **GetMap** (`ol.source.TileWMS`, `crossOrigin:'anonymous'` since GeoServer sends ACAO:*; the forest layer overrides its bright default style via `SLD_BODY` from `softOutlineSLD()`). The cadastre (КАИС `BoundariesCache/MapServer`) and Natura (`…/AGKKIntegration/MapServer`) layers are natively EPSG:7801 (BGS2005/Lambert) while the map is 3857, so they use **server-side export** via `ol.source.TileArcGISRest` (reprojects per tile) with **no** `crossOrigin`. КАИС has `minScale` 1:5000. The Natura service gate-keeps by **Referer** (only `natura2000.egov.bg` → 200; else 403), which `<img>` can't forge, so its tiles load through `GM_xmlhttpRequest` with a spoofed `Referer` in a custom `setTileLoadFunction` (blob → object URL). Overlays are inserted with `getLayers().insertAt(0, …)` so they land at the bottom of the (reverse-rendered) list; each needs a unique `shortTitle` or kade.si's permalink reader (`update_location` in `main.js`, `setVisible(includes(title)||title===undefined)`) force-re-enables them on zoom. Map draw order is set by `zIndex`; a `.iag-new` badge goes in the `title` (switcher uses `innerHTML`).
  - **Click popup**: a `singleclick` handler queries IAG `GetFeatureInfo` (plain `fetch`) and the Natura ArcGIS `identify` (via `GM_xmlhttpRequest`, Referer-gated) and shows an `ol.Overlay` popup. `identify` returns a hit per sublayer — zone name in `value`, type in `layerName`; `cleanType()` strips „надписи“/„контур“/„(полигони)“ and results dedupe by type+name. A **"Инфо при клик" checkbox** is appended to the bottom of the switcher by wrapping `layerSwitcher.renderPanel` (which clears its panel each render); its state persists in `localStorage` (`iag-info-enabled`).
- `iag-geoserver-fix.user.js` — *(extra)* fixes the MapStore viewer (`maps.iag.bg/mapstore/#/viewer/<id>`), whose config points layers at an internal GeoServer (`http://172.16.4.132:5088/geoserver/...`). Rewrites that origin to `https://maps.iag.bg/geoserver/...` across `fetch`, `XMLHttpRequest` (URL **and** response bodies, so the config is corrected before MapStore parses it — the primary fix) and `<img>` src as a fallback.
- `iag-lookup.mjs` — *(extra)* CLI of the same point lookup: `node iag-lookup.mjs <lat> <lon>` (also accepts `"lat,lon"`). Node 18+, no deps.

## Key facts about the data

- Layers used: `IAG:lr_hunting_08_2024` (hunting; fields `lr`, `lovishte`) and `IAG:dleso_full_2022` (forest; `TR_SP`, `AGE`, `SLOPE`, plus ~80 more).
- Layers are stored natively in **EPSG:32635** (UTM 35N), so a WFS `INTERSECTS` CQL filter in 3857 returns empty. The working approach is **WMS `GetFeatureInfo`** in EPSG:3857 with a tiny (±3 m) bbox and `I=J=1` on a 3×3 request; coords are converted from WGS84 to Web Mercator in code.
- Both layers contain duplicate records (e.g. `...1456` ↔ `...10809`); dedupe (by `key_id` where present, else by the shown fields).
- GeoServer sends `Access-Control-Allow-Origin: *`, so cross-origin `fetch` with `@grant none` works — no `GM_xmlhttpRequest` needed.
- Which fields appear in the lookup is driven by the `LAYERS`/`INFO_LAYERS` config at the top of both `iag-lookup.mjs` and `kade-bg-gis.user.js`; keep them in sync.

## Commands

No build step. Syntax check a script: `node --check <file>`. Run the lookup: `node iag-lookup.mjs 43.189 25.093`.
Explore all raw fields for a point (readable `text/plain`): a minimal `GetFeatureInfo` needs only `request, layers, query_layers, srs, bbox, width, height, x, y` (drop `service/version/styles/format/info_format/id/ENV`).
