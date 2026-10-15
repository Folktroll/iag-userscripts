// ==UserScript==
// @name         kade.si – ИАГ информация при клик
// @namespace    https://maps.iag.bg/
// @version      1.0.0
// @description  При клик върху картата на kade.si показва ловния район и горска информация от GeoServer на ИАГ.
// @match        https://kade.si/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const GEOSERVER = 'https://maps.iag.bg/geoserver/wms';

    // Слоеве и показвани полета — същата идея като iag-lookup.mjs.
    // За да махнеш горския слой, просто изтрий втория обект от масива.
    const LAYERS = [
        {
            name: 'IAG:lr_hunting_08_2024',
            title: 'Лов',
            key: null,
            fields: [
                ['lr', ''],
                ['lovishte', 'ловище'],
            ],
        },
        {
            name: 'IAG:dleso_full_2022',
            title: 'Гора',
            key: 'key_id',
            fields: [
                ['TR_SP', 'дървесен вид'],
                ['AGE', 'възраст', 'г.'],
                ['SLOPE', 'наклон', '°'],
            ],
        },
    ];

    const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

    const fmtValue = (v, unit) => {
        const s = typeof v === 'number' ? Math.round(v * 100) / 100 : String(v).trim();
        if (!unit) return `${s}`;
        return unit === '°' ? `${s}${unit}` : `${s} ${unit}`;
    };

    const fmtField = ([attr, label, unit], props) => {
        const v = props[attr];
        if (blank(v)) return null;
        const val = fmtValue(v, unit);
        return label ? `${label}: ${val}` : val;
    };

    // Запитване към един слой за точка [x, y] в EPSG:3857.
    const queryLayer = async (layer, x, y) => {
        const d = 3; // ±3 м bbox около точката
        const bbox = `${x - d},${y - d},${x + d},${y + d}`;
        const props = layer.fields.map((f) => f[0]).concat(layer.key ? [layer.key] : []);
        const url =
            `${GEOSERVER}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
            `&QUERY_LAYERS=${encodeURIComponent(layer.name)}` +
            `&LAYERS=${encodeURIComponent(layer.name)}` +
            `&INFO_FORMAT=${encodeURIComponent('application/json')}` +
            `&FEATURE_COUNT=10&PROPERTYNAME=${[...new Set(props)].join(',')}` +
            `&CRS=EPSG:3857&WIDTH=3&HEIGHT=3&I=1&J=1` +
            `&BBOX=${encodeURIComponent(bbox)}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`${layer.name}: HTTP ${res.status}`);
        const data = await res.json();

        const seen = new Set();
        const records = [];
        for (const f of data.features ?? []) {
            const p = f.properties ?? {};
            const lines = layer.fields.map((fd) => fmtField(fd, p)).filter(Boolean);
            if (lines.length === 0) continue;
            const dedupKey = layer.key && !blank(p[layer.key]) ? String(p[layer.key]) : lines.join('|');
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            records.push(lines);
        }
        return records;
    };

    // --- popup (ol.Overlay) ---------------------------------------------------
    const buildPopup = (ol, map) => {
        const el = document.createElement('div');
        el.className = 'iag-popup';
        el.innerHTML =
            '<a href="#" class="iag-popup__close">×</a><div class="iag-popup__body"></div>';
        const overlay = new ol.Overlay({
            element: el,
            autoPan: { animation: { duration: 200 } },
            positioning: 'bottom-center',
            offset: [0, -12],
            stopEvent: true,
        });
        map.addOverlay(overlay);
        el.querySelector('.iag-popup__close').addEventListener('click', (e) => {
            e.preventDefault();
            overlay.setPosition(undefined);
        });
        const body = el.querySelector('.iag-popup__body');
        return { overlay, body };
    };

    const renderResults = (results, lat, lon) => {
        const esc = (s) =>
            String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        let html = `<div class="iag-popup__coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`;
        let any = false;
        for (const { layer, records } of results) {
            for (const lines of records) {
                any = true;
                html += `<div class="iag-popup__sec"><span class="iag-popup__tag">${esc(layer.title)}</span>`;
                html += lines.map((l) => `<div>${esc(l)}</div>`).join('');
                html += '</div>';
            }
        }
        if (!any) html += '<div class="iag-popup__empty">(няма данни за тази точка)</div>';
        return html;
    };

    const injectStyle = () => {
        const css = `
.iag-popup{position:absolute;min-width:200px;max-width:320px;background:#fff;color:#1a1a1a;
  border:1px solid #bbb;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);
  padding:10px 12px 10px;font:13px/1.4 system-ui,Arial,sans-serif;bottom:12px;left:-50%}
.iag-popup::after{content:"";position:absolute;bottom:-9px;left:50%;margin-left:-8px;
  border:8px solid transparent;border-top-color:#fff;filter:drop-shadow(0 1px 0 #bbb)}
.iag-popup__close{position:absolute;top:4px;right:8px;color:#888;text-decoration:none;font-size:16px}
.iag-popup__close:hover{color:#000}
.iag-popup__coords{font-size:11px;color:#888;margin-bottom:6px}
.iag-popup__sec{margin-top:6px}
.iag-popup__sec:first-of-type{margin-top:0}
.iag-popup__tag{display:inline-block;font-size:11px;font-weight:700;color:#2b6a2b;
  background:#e8f3e8;border-radius:4px;padding:0 6px;margin-bottom:2px}
.iag-popup__empty{color:#888;font-style:italic}`;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    };

    // --- изчакване на картата -------------------------------------------------
    const waitForMap = () =>
        new Promise((resolve) => {
            const tick = () => {
                if (window.map && window.ol && typeof window.map.on === 'function') {
                    resolve({ ol: window.ol, map: window.map });
                } else {
                    setTimeout(tick, 300);
                }
            };
            tick();
        });

    const init = async () => {
        const { ol, map } = await waitForMap();
        injectStyle();
        const { overlay, body } = buildPopup(ol, map);

        map.on('singleclick', async (evt) => {
            const [x, y] = evt.coordinate; // EPSG:3857
            const [lon, lat] = ol.proj.transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
            overlay.setPosition(evt.coordinate);
            body.innerHTML = '<div class="iag-popup__empty">Зареждане…</div>';
            try {
                const results = await Promise.all(
                    LAYERS.map(async (layer) => ({ layer, records: await queryLayer(layer, x, y) })),
                );
                body.innerHTML = renderResults(results, lat, lon);
            } catch (err) {
                body.innerHTML = `<div class="iag-popup__empty">Грешка: ${err.message}</div>`;
            }
        });

        console.log('[kade-iag-info] готово — кликни върху картата.');
    };

    init();
})();
