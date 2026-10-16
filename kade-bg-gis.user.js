// ==UserScript==
// @name         kade.si – ИАГ/КАИС/Natura слоеве + инфо при клик
// @namespace    https://maps.iag.bg/
// @version      2.5.0
// @description  Добавя към kade.si прозрачни овърлеи (ловни райони и горска карта от ИАГ, кадастрални граници, защитени територии/Natura) с тикчета в менюто, и popup при клик с инфо за точката. Най-долу в менюто има тикче за вкл./изкл. на popup-а.
// @match        https://kade.si/*
// @homepageURL  https://github.com/Folktroll/iag-userscripts
// @supportURL   https://github.com/Folktroll/iag-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/Folktroll/iag-userscripts/main/kade-bg-gis.user.js
// @updateURL    https://raw.githubusercontent.com/Folktroll/iag-userscripts/main/kade-bg-gis.user.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      natura2000.egov.bg
// ==/UserScript==

(() => {
    'use strict';

    // При наличие на @grant скриптът е в sandbox – глобалните на kade.si (map, ol,
    // layerSwitcher) се достигат през unsafeWindow.
    const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // GM_xmlhttpRequest (класически) или GM.xmlHttpRequest (нов API) – за заявки с
    // подправен Referer, което <img>/fetch не позволяват (услугата на Natura).
    const gmXHR =
        typeof GM_xmlhttpRequest !== 'undefined'
            ? GM_xmlhttpRequest
            : typeof GM !== 'undefined' && GM.xmlHttpRequest
              ? GM.xmlHttpRequest.bind(GM)
              : null;

    const gmGetJSON = (url, referer) =>
        new Promise((resolve, reject) => {
            if (!gmXHR) {
                reject(new Error('GM_xmlhttpRequest липсва'));
                return;
            }
            gmXHR({
                method: 'GET',
                url,
                headers: { Referer: referer },
                onload: (res) => {
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: () => reject(new Error('мрежова грешка')),
            });
        });

    // ---------------------------------------------------------------------------
    // Адреси
    // ---------------------------------------------------------------------------
    const GEOSERVER = 'https://maps.iag.bg/geoserver/wms';
    const IAG_ATTR = '<a href="https://maps.iag.bg/" target="_blank">ИАГ</a>';
    const KAIS = 'https://arcgis.cadastre.bg/arcgisnopki/rest/services/ExternalKais/BoundariesCache/MapServer';
    const KAIS_ATTR = '<a href="https://kais.cadastre.bg/" target="_blank">КАИС – Кадастър</a>';
    const NATURA =
        'https://natura2000.egov.bg/arcgis/sharing/servers/b2bf934051e14d62b6830428ec876262/rest/services/NaturaIntegration/AGKKIntegration/MapServer';
    const NATURA_ATTR = '<a href="https://natura2000.egov.bg/" target="_blank">Natura 2000 BG</a>';
    const NATURA_REFERER = 'https://natura2000.egov.bg/';

    // ===========================================================================
    // 1) ОВЪРЛЕИ (слоеве с тикчета)
    // ===========================================================================

    // Мек контурен SLD за даден слой: само граница (без запълване), приглушен цвят.
    const softOutlineSLD = (layer, { color = '#a86b5c', width = 0.8, opacity = 0.6 } = {}) =>
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">' +
        `<NamedLayer><Name>${layer}</Name><UserStyle><FeatureTypeStyle><Rule><PolygonSymbolizer><Stroke>` +
        `<CssParameter name="stroke">${color}</CssParameter>` +
        `<CssParameter name="stroke-width">${width}</CssParameter>` +
        `<CssParameter name="stroke-opacity">${opacity}</CssParameter>` +
        '</Stroke></PolygonSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>';

    const iagTileSource = (ol, layer, sld) =>
        new ol.source.TileWMS({
            url: GEOSERVER,
            attributions: IAG_ATTR,
            crossOrigin: 'anonymous', // GeoServer връща ACAO:*
            serverType: 'geoserver',
            params: {
                LAYERS: layer,
                TILED: true,
                FORMAT: 'image/png',
                TRANSPARENT: true,
                ...(sld ? { SLD_BODY: sld } : {}),
            },
        });

    // Общ ArcGIS източник през server-side export (слоевете са в EPSG:7801, картата в
    // 3857 – услугата препроектира). `referer`: услугата пази плочките зад проверка на
    // Referer, затова ги теглим през GM_xmlhttpRequest като blob.
    const arcgisSource = (ol, { url, attr, params, referer }) => {
        const src = new ol.source.TileArcGISRest({ url, attributions: attr, params });
        if (referer && gmXHR) {
            src.setTileLoadFunction((tile, tileUrl) => {
                gmXHR({
                    method: 'GET',
                    url: tileUrl,
                    responseType: 'blob',
                    headers: { Referer: referer },
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300 && res.response) {
                            const objUrl = URL.createObjectURL(res.response);
                            const img = tile.getImage();
                            img.onload = img.onerror = () => URL.revokeObjectURL(objUrl);
                            img.src = objUrl;
                        } else {
                            tile.setState(ol.TileState.ERROR);
                        }
                    },
                    onerror: () => tile.setState(ol.TileState.ERROR),
                });
            });
        }
        return src;
    };

    // Редът тук = ред в менюто (отгоре надолу); последният ред излиза най-долу.
    // `shortTitle` – уникален код; нужен е за permalink логиката на kade.si (иначе при
    // зуум слой без shortTitle се включва принудително пак).
    const OVERLAYS = [
        { title: 'ИАГ – Ловни райони', shortTitle: 'iaglov', opacity: 0.55, defaultOn: true, source: (ol) => iagTileSource(ol, 'IAG:lr_hunting_08_2024') },
        {
            title: 'ИАГ – Горска карта',
            shortTitle: 'iaggora',
            opacity: 0.45,
            source: (ol) => iagTileSource(ol, 'IAG:dleso_full_2022', softOutlineSLD('IAG:dleso_full_2022')),
        },
        {
            title: 'Кадастър (граници)',
            shortTitle: 'kais',
            opacity: 0.8,
            source: (ol) => arcgisSource(ol, { url: KAIS, attr: KAIS_ATTR, params: { format: 'png', transparent: true } }),
        },
        {
            title: 'Защитени територии (Natura/ЗЗТ)',
            shortTitle: 'natura',
            opacity: 0.6,
            defaultOn: true,
            source: (ol) =>
                arcgisSource(ol, {
                    url: NATURA,
                    attr: NATURA_ATTR,
                    referer: NATURA_REFERER,
                    params: { format: 'PNG32', transparent: true, dpi: 90, layers: 'show:9,10,21,12,13,14,15' },
                }),
        },
    ];

    const NEW_BADGE = ' <span class="iag-new">NEW</span>';

    const makeOverlayLayer = (ol, { title, shortTitle, opacity, source, defaultOn }) => {
        const layer = new ol.layer.Tile({
            title: title + NEW_BADGE, // ol-layerswitcher показва слоя по това заглавие
            shortTitle, // код за permalink логиката на kade.si
            // без type:'base' => слоят е овърлей (тикче, не радио-бутон)
            visible: loadVis(shortTitle, defaultOn), // запомненото състояние, иначе default
            zIndex: 3,
            opacity,
            source: source(ol),
        });
        // запомняме при всяка промяна на видимостта (тикване/махване)
        layer.on('change:visible', () => saveVis(shortTitle, layer.getVisible()));
        return layer;
    };

    // ===========================================================================
    // 2) ИНФО ПРИ КЛИК (popup)
    // ===========================================================================

    // WMS слоеве на ИАГ и показвани полета.
    const INFO_LAYERS = [
        {
            name: 'IAG:lr_hunting_08_2024',
            title: 'Лов',
            tagClass: 'hunt',
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

    const queryInfoLayer = async (layer, x, y) => {
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

    // Привежда името на подслой до „вид зона“ (маха надписи/контур/полигони).
    const cleanType = (name) =>
        String(name || '')
            .replace(/\s*надписи$/, '')
            .replace(/\s*-\s*(обобщен|детайлен)\s*контур$/, '')
            .replace(/\s*\((полигони|точки)\)$/, '')
            .trim();

    const queryNatura = async (x, y) => {
        const d = 120;
        const ext = `${x - d},${y - d},${x + d},${y + d}`;
        const url =
            `${NATURA}/identify?geometry=${x},${y}&geometryType=esriGeometryPoint&sr=3857` +
            `&tolerance=3&mapExtent=${ext}&imageDisplay=256,256,96&layers=all&returnGeometry=false&f=json`;
        const data = await gmGetJSON(url, NATURA_REFERER);
        const seen = new Set();
        const lines = [];
        for (const r of data.results ?? []) {
            const type = cleanType(r.layerName);
            const name = r.value == null ? '' : String(r.value).trim();
            if (!name) continue;
            const key = `${type}|${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            lines.push(type ? `${type}: ${name}` : name);
        }
        return lines;
    };

    const buildPopup = (ol, map) => {
        const el = document.createElement('div');
        el.className = 'iag-popup';
        el.innerHTML = '<a href="#" class="iag-popup__close">×</a><div class="iag-popup__body"></div>';
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
        return { overlay, body: el.querySelector('.iag-popup__body') };
    };

    const renderResults = (results, lat, lon) => {
        const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
        let html = `<div class="iag-popup__coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`;
        let any = false;
        for (const { layer, records } of results) {
            for (const lines of records) {
                any = true;
                const tagClass = layer.tagClass ? ` iag-popup__tag--${layer.tagClass}` : '';
                html += `<div class="iag-popup__sec"><span class="iag-popup__tag${tagClass}">${esc(layer.title)}</span>`;
                html += lines.map((l) => `<div>${esc(l)}</div>`).join('');
                html += '</div>';
            }
        }
        if (!any) html += '<div class="iag-popup__empty">(няма данни за тази точка)</div>';
        return html;
    };

    // ===========================================================================
    // Стилове
    // ===========================================================================
    const injectStyle = () => {
        const css = `
.iag-new{display:inline-block;background:#e8521f;color:#fff;font:700 9px/1.4 system-ui,Arial,sans-serif;
  vertical-align:middle;padding:0 4px;margin-left:4px;border-radius:3px;letter-spacing:.5px}
.iag-info-row label{cursor:pointer}
.iag-sep{list-style:none;border-top:2px solid #ccc;margin:6px 0 4px;padding:0;height:0}
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
.iag-popup__tag--nature{color:#1d5f7a;background:#e1f0f6}
.iag-popup__tag--hunt{color:#b5651d;background:#fbe6d0}
.iag-popup__empty{color:#888;font-style:italic}`;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    };

    // ===========================================================================
    // Състояние: показвай ли popup при клик (запомнено в localStorage)
    // ===========================================================================
    const INFO_KEY = 'iag-info-enabled';
    let infoEnabled = true;
    try {
        infoEnabled = localStorage.getItem(INFO_KEY) !== '0';
    } catch {
        /* частен режим и т.н. – оставаме на default */
    }
    const saveInfo = () => {
        try {
            localStorage.setItem(INFO_KEY, infoEnabled ? '1' : '0');
        } catch {
            /* игнорираме */
        }
    };

    // Видимост на всеки овърлей (вкл./изкл.) – запомнена в localStorage по shortTitle,
    // за да оцелява и след рефреш, и в нова сесия.
    const visKey = (shortTitle) => `iag-ov-${shortTitle}`;
    const loadVis = (shortTitle, defOn = false) => {
        try {
            const v = localStorage.getItem(visKey(shortTitle));
            return v === null ? defOn : v === '1'; // няма запис => default; иначе запомненото
        } catch {
            return defOn;
        }
    };
    const saveVis = (shortTitle, on) => {
        try {
            localStorage.setItem(visKey(shortTitle), on ? '1' : '0');
        } catch {
            /* игнорираме */
        }
    };

    // ===========================================================================
    // Изчакване на картата
    // ===========================================================================
    const waitForMap = () =>
        new Promise((resolve) => {
            const tick = () => {
                if (PAGE.map && PAGE.ol && typeof PAGE.map.addLayer === 'function') {
                    resolve({ ol: PAGE.ol, map: PAGE.map });
                } else {
                    setTimeout(tick, 300);
                }
            };
            tick();
        });

    const init = async () => {
        const { ol, map } = await waitForMap();
        injectStyle();

        // --- овърлеи (най-долу в менюто) ---
        for (const cfg of OVERLAYS) {
            map.getLayers().insertAt(0, makeOverlayLayer(ol, cfg));
        }

        // --- popup при клик ---
        const { overlay, body } = buildPopup(ol, map);

        map.on('singleclick', async (evt) => {
            if (!infoEnabled) return;
            const [x, y] = evt.coordinate; // EPSG:3857
            const [lon, lat] = ol.proj.transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
            overlay.setPosition(evt.coordinate);
            body.innerHTML = '<div class="iag-popup__empty">Зареждане…</div>';
            try {
                const [iagResults, naturaLines] = await Promise.all([
                    Promise.all(INFO_LAYERS.map(async (layer) => ({ layer, records: await queryInfoLayer(layer, x, y) }))),
                    queryNatura(x, y).catch(() => []),
                ]);
                // ред в popup-а: Защитени зони, Гора, Лов
                const results = [];
                if (naturaLines.length) {
                    results.push({ layer: { title: 'Защитени зони', tagClass: 'nature' }, records: [naturaLines] });
                }
                results.push(...iagResults.reverse()); // INFO_LAYERS е [Лов, Гора] => reverse дава [Гора, Лов]
                body.innerHTML = renderResults(results, lat, lon);
            } catch (err) {
                body.innerHTML = `<div class="iag-popup__empty">Грешка: ${err.message}</div>`;
            }
        });

        // --- разделител над първия наш овърлей (за да личи къде почват опциите ни) ---
        const insertSeparator = (ul) => {
            if (ul.querySelector('.iag-sep')) return;
            // първият ред със значка „NEW“, който НЕ е тикчето – това е първият наш овърлей
            const firstOurs = [...ul.querySelectorAll('li')].find(
                (li) => li.querySelector('.iag-new') && !li.classList.contains('iag-info-row'),
            );
            if (!firstOurs) return;
            const sep = document.createElement('li');
            sep.className = 'iag-sep';
            ul.insertBefore(sep, firstOurs);
        };

        // --- тикче „Инфо при клик“ най-долу в менюто ---
        const appendInfoToggle = (panel) => {
            const ul = panel && panel.querySelector('ul');
            if (!ul) return;
            insertSeparator(ul);
            if (ul.querySelector('#iag-info-toggle')) return;
            const li = document.createElement('li');
            li.className = 'iag-info-row';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = 'iag-info-toggle';
            input.checked = infoEnabled;
            input.addEventListener('change', () => {
                infoEnabled = input.checked;
                saveInfo();
                if (!infoEnabled) overlay.setPosition(undefined); // скрий отворения popup
            });
            const label = document.createElement('label');
            label.htmlFor = 'iag-info-toggle';
            label.innerHTML = 'Инфо при клик' + NEW_BADGE;
            li.appendChild(input);
            li.appendChild(label);
            ul.appendChild(li);
        };

        // Обвиваме renderPanel на layer switcher-а, за да добавяме тикчето след всяко
        // прерисуване (то изчиства панела при всяко отваряне).
        const ls = PAGE.layerSwitcher;
        if (ls && typeof ls.renderPanel === 'function') {
            const orig = ls.renderPanel.bind(ls);
            ls.renderPanel = () => {
                orig();
                appendInfoToggle(ls.panel);
            };
            ls.renderPanel();
        }

        console.log('[kade-iag] готово – овърлеи + инфо при клик.');
    };

    init();
})();
