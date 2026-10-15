# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Userscripts and a small CLI around Изпълнителна агенция по горите (ИАГ) maps: the public GeoServer at `maps.iag.bg` and the kade.si hiking portal.

- `iag-geoserver-fix.user.js` — fixes the MapStore viewer (`maps.iag.bg/mapstore/#/viewer/<id>`), whose config points layers at an internal GeoServer (`http://172.16.4.132:5088/geoserver/...`). Rewrites that origin to `https://maps.iag.bg/geoserver/...` across `fetch`, `XMLHttpRequest` (URL **and** response bodies, so the config is corrected before MapStore parses it — the primary fix) and `<img>` src as a fallback.
- `kade-iag-info.user.js` — on kade.si (OpenLayers; exposes globals `map` and `ol`), adds a `singleclick` handler that queries IAG GeoServer `GetFeatureInfo` and shows results in an `ol.Overlay` popup.
- `iag-lookup.mjs` — CLI of the same lookup: `node iag-lookup.mjs <lat> <lon>` (also accepts `"lat,lon"`). Node 18+, no deps.

## Key facts about the data

- Layers used: `IAG:lr_hunting_08_2024` (hunting; fields `lr`, `lovishte`) and `IAG:dleso_full_2022` (forest; `TR_SP`, `AGE`, `SLOPE`, plus ~80 more).
- Layers are stored natively in **EPSG:32635** (UTM 35N), so a WFS `INTERSECTS` CQL filter in 3857 returns empty. The working approach is **WMS `GetFeatureInfo`** in EPSG:3857 with a tiny (±3 m) bbox and `I=J=1` on a 3×3 request; coords are converted from WGS84 to Web Mercator in code.
- Both layers contain duplicate records (e.g. `...1456` ↔ `...10809`); dedupe (by `key_id` where present, else by the shown fields).
- GeoServer sends `Access-Control-Allow-Origin: *`, so cross-origin `fetch` with `@grant none` works — no `GM_xmlhttpRequest` needed.
- Which fields appear in the lookup is driven by the `LAYERS` config at the top of both `iag-lookup.mjs` and `kade-iag-info.user.js`; keep them in sync.

## Commands

No build step. Syntax check a script: `node --check <file>`. Run the lookup: `node iag-lookup.mjs 43.189 25.093`.
Explore all raw fields for a point (readable `text/plain`): a minimal `GetFeatureInfo` needs only `request, layers, query_layers, srs, bbox, width, height, x, y` (drop `service/version/styles/format/info_format/id/ENV`).
