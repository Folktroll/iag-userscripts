// ==UserScript==
// @name         kade.si – ИАГ овърлеи (слоеве)
// @namespace    https://maps.iag.bg/
// @version      1.2.0
// @description  Добавя прозрачни овърлеи към kade.si (ловни райони и горска карта от ИАГ, кадастрални граници от КАИС), с тикчета в менюто със слоеве като Hiking и Open Railway Map.
// @match        https://kade.si/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const GEOSERVER = 'https://maps.iag.bg/geoserver/wms';
    const IAG_ATTR = '<a href="https://maps.iag.bg/" target="_blank">ИАГ</a>';
    const KAIS = 'https://arcgis.cadastre.bg/arcgisnopki/rest/services/ExternalKais/BoundariesCache/MapServer';
    const KAIS_ATTR = '<a href="https://kais.cadastre.bg/" target="_blank">КАИС – Кадастър</a>';

    // Източник: WMS слой от GeoServer на ИАГ (ACAO:* => може crossOrigin:'anonymous').
    const iagSource = (ol, layer) =>
        new ol.source.TileWMS({
            url: GEOSERVER,
            attributions: IAG_ATTR,
            crossOrigin: 'anonymous',
            serverType: 'geoserver',
            params: { LAYERS: layer, TILED: true, FORMAT: 'image/png', TRANSPARENT: true },
        });

    // Източник: кадастрални граници (ArcGIS). Слоят е в EPSG:7801, затова ползваме
    // server-side export – ol.source.TileArcGISRest праща bbox/imageSR в проекцията на
    // картата (3857) и услугата препроектира. БЕЗ crossOrigin: ACAO е само за
    // kais.cadastre.bg, но за показване на картинки четене на пиксели не е нужно.
    const cadastreSource = (ol) =>
        new ol.source.TileArcGISRest({
            url: KAIS,
            attributions: KAIS_ATTR,
            params: { format: 'png', transparent: true },
        });

    // Овърлеи за добавяне. `source(ol)` връща OpenLayers източника; `opacity` – прозрачност.
    // Добави/махни редове тук, за да управляваш кои слоеве се предлагат.
    const OVERLAYS = [
        { title: 'ИАГ – Ловни райони', opacity: 0.55, source: (ol) => iagSource(ol, 'IAG:lr_hunting_08_2024') },
        { title: 'ИАГ – Горска карта', opacity: 0.55, source: (ol) => iagSource(ol, 'IAG:dleso_full_2022') },
        { title: 'Кадастър (граници)', opacity: 0.8, source: cadastreSource },
    ];

    // Значка "NEW" до заглавието. ol-layerswitcher слага заглавието през innerHTML,
    // затова HTML-ът минава и преживява прерисуване на менюто.
    const NEW_BADGE = ' <span class="iag-new">NEW</span>';

    const makeLayer = (ol, { title, opacity, source }) =>
        new ol.layer.Tile({
            title: title + NEW_BADGE, // ol-layerswitcher показва слоя по това заглавие
            // без type:'base' => слоят е овърлей (тикче, не радио-бутон)
            visible: false, // стартира изключен, включва се с тикчето
            zIndex: 3, // над базовата карта и над ORM/Hiking (zIndex 1)
            opacity,
            source: source(ol),
        });

    const waitForMap = () =>
        new Promise((resolve) => {
            const tick = () => {
                if (window.map && window.ol && typeof window.map.addLayer === 'function') {
                    resolve({ ol: window.ol, map: window.map });
                } else {
                    setTimeout(tick, 300);
                }
            };
            tick();
        });

    const injectStyle = () => {
        const s = document.createElement('style');
        s.textContent =
            '.iag-new{display:inline-block;background:#e8521f;color:#fff;font:700 9px/1.4 system-ui,Arial,sans-serif;' +
            'vertical-align:middle;padding:0 4px;margin-left:4px;border-radius:3px;letter-spacing:.5px}';
        document.head.appendChild(s);
    };

    const init = async () => {
        const { ol, map } = await waitForMap();
        injectStyle();

        // Вмъкваме в началото на колекцията => излизат най-долу в менюто (то рисува обърнато).
        // Редът на картата не се влияе – управлява се от zIndex.
        for (const cfg of OVERLAYS) {
            map.getLayers().insertAt(0, makeLayer(ol, cfg));
        }

        // Накарай менюто със слоеве да се прерисува, за да се появят новите овърлеи веднага.
        try {
            if (window.layerSwitcher && typeof window.layerSwitcher.renderPanel === 'function') {
                window.layerSwitcher.renderPanel();
            }
        } catch {
            /* ако не стане – слоевете пак ще се появят при следващо отваряне на менюто */
        }

        console.log(`[kade-iag-overlay] добавени ${OVERLAYS.length} овърлея от ИАГ.`);
    };

    init();
})();
