// ==UserScript==
// @name         kade.si – ИАГ овърлеи (слоеве)
// @namespace    https://maps.iag.bg/
// @version      1.1.0
// @description  Добавя прозрачни WMS овърлеи от GeoServer на ИАГ (ловни райони, горска карта) към kade.si, с тикчета в менюто със слоеве като Hiking и Open Railway Map.
// @match        https://kade.si/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const GEOSERVER = 'https://maps.iag.bg/geoserver/wms';
    const ATTR = '<a href="https://maps.iag.bg/" target="_blank">ИАГ</a>';

    // Овърлеи за добавяне. `layer` е името на WMS слоя, `opacity` – прозрачност (0–1).
    // Добави/махни редове тук, за да управляваш кои слоеве се предлагат.
    const OVERLAYS = [
        { title: 'ИАГ – Ловни райони', layer: 'IAG:lr_hunting_08_2024', opacity: 0.55 },
        { title: 'ИАГ – Горска карта', layer: 'IAG:dleso_full_2022', opacity: 0.55 },
    ];

    // Значка "NEW" до заглавието. ol-layerswitcher слага заглавието през innerHTML,
    // затова HTML-ът минава и преживява прерисуване на менюто.
    const NEW_BADGE = ' <span class="iag-new">NEW</span>';

    const makeLayer = (ol, { title, layer, opacity }) =>
        new ol.layer.Tile({
            title: title + NEW_BADGE, // ol-layerswitcher показва слоя по това заглавие
            // без type:'base' => слоят е овърлей (тикче, не радио-бутон)
            visible: false, // стартира изключен, включва се с тикчето
            zIndex: 3, // над базовата карта и над ORM/Hiking (zIndex 1)
            opacity,
            source: new ol.source.TileWMS({
                url: GEOSERVER,
                attributions: ATTR,
                crossOrigin: 'anonymous', // GeoServer връща ACAO:* => безопасно за canvas/експорт
                serverType: 'geoserver',
                params: {
                    LAYERS: layer,
                    TILED: true,
                    FORMAT: 'image/png',
                    TRANSPARENT: true,
                },
            }),
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
