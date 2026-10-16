// ==UserScript==
// @name         kade.si – ИАГ/КАИС/Natura овърлеи (слоеве)
// @namespace    https://maps.iag.bg/
// @version      1.4.1
// @description  Добавя прозрачни овърлеи към kade.si (ловни райони и горска карта от ИАГ, кадастрални граници от КАИС, защитени територии/Natura), с тикчета в менюто със слоеве като Hiking и Open Railway Map.
// @match        https://kade.si/*
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
    // подправен Referer, което <img> не позволява.
    const gmXHR =
        typeof GM_xmlhttpRequest !== 'undefined'
            ? GM_xmlhttpRequest
            : typeof GM !== 'undefined' && GM.xmlHttpRequest
              ? GM.xmlHttpRequest.bind(GM)
              : null;

    const GEOSERVER = 'https://maps.iag.bg/geoserver/wms';
    const IAG_ATTR = '<a href="https://maps.iag.bg/" target="_blank">ИАГ</a>';
    const KAIS = 'https://arcgis.cadastre.bg/arcgisnopki/rest/services/ExternalKais/BoundariesCache/MapServer';
    const KAIS_ATTR = '<a href="https://kais.cadastre.bg/" target="_blank">КАИС – Кадастър</a>';
    const NATURA =
        'https://natura2000.egov.bg/arcgis/sharing/servers/b2bf934051e14d62b6830428ec876262/rest/services/NaturaIntegration/AGKKIntegration/MapServer';
    const NATURA_ATTR = '<a href="https://natura2000.egov.bg/" target="_blank">Natura 2000 BG</a>';
    const NATURA_REFERER = 'https://natura2000.egov.bg/';

    // Мек контурен SLD за даден слой: само граница (без запълване), приглушен цвят,
    // полупрозрачна линия. Подава се като SLD_BODY, за да замени ярко-червения default.
    const softOutlineSLD = (layer, { color = '#a86b5c', width = 0.8, opacity = 0.6 } = {}) =>
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">' +
        `<NamedLayer><Name>${layer}</Name><UserStyle><FeatureTypeStyle><Rule><PolygonSymbolizer><Stroke>` +
        `<CssParameter name="stroke">${color}</CssParameter>` +
        `<CssParameter name="stroke-width">${width}</CssParameter>` +
        `<CssParameter name="stroke-opacity">${opacity}</CssParameter>` +
        '</Stroke></PolygonSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>';

    // Източник: WMS слой от GeoServer на ИАГ (ACAO:* => може crossOrigin:'anonymous').
    // `sld` (по избор) замества стила по подразбиране на слоя.
    const iagSource = (ol, layer, sld) =>
        new ol.source.TileWMS({
            url: GEOSERVER,
            attributions: IAG_ATTR,
            crossOrigin: 'anonymous',
            serverType: 'geoserver',
            params: {
                LAYERS: layer,
                TILED: true,
                FORMAT: 'image/png',
                TRANSPARENT: true,
                ...(sld ? { SLD_BODY: sld } : {}),
            },
        });

    // Общ ArcGIS източник през server-side export. Слоевете са в EPSG:7801, а картата
    // е в 3857 – TileArcGISRest праща bbox/imageSR в 3857 и услугата препроектира.
    // `referer` (по избор): услугата пази плочките зад проверка на Referer, затова
    // ги теглим през GM_xmlhttpRequest с подправен Referer и ги подаваме като blob.
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

    // Овърлеи за добавяне. `source(ol)` връща OpenLayers източника; `opacity` – прозрачност.
    // `shortTitle` – уникален код; нужен е, за да ги разпознава permalink логиката на
    // kade.si (иначе при зуум слой без shortTitle се включва принудително пак).
    // Редът тук = ред в менюто (отгоре надолу); последният ред излиза най-долу.
    const OVERLAYS = [
        { title: 'ИАГ – Ловни райони', shortTitle: 'iaglov', opacity: 0.55, source: (ol) => iagSource(ol, 'IAG:lr_hunting_08_2024') },
        {
            title: 'ИАГ – Горска карта',
            shortTitle: 'iaggora',
            opacity: 0.45,
            source: (ol) => iagSource(ol, 'IAG:dleso_full_2022', softOutlineSLD('IAG:dleso_full_2022')),
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
            source: (ol) =>
                arcgisSource(ol, {
                    url: NATURA,
                    attr: NATURA_ATTR,
                    referer: NATURA_REFERER,
                    params: { format: 'PNG32', transparent: true, dpi: 90, layers: 'show:9,10,21,12,13,14,15' },
                }),
        },
    ];

    // Значка "NEW" до заглавието. ol-layerswitcher слага заглавието през innerHTML,
    // затова HTML-ът минава и преживява прерисуване на менюто.
    const NEW_BADGE = ' <span class="iag-new">NEW</span>';

    const makeLayer = (ol, { title, shortTitle, opacity, source }) =>
        new ol.layer.Tile({
            title: title + NEW_BADGE, // ol-layerswitcher показва слоя по това заглавие
            shortTitle, // код за permalink логиката на kade.si (виж бележката при OVERLAYS)
            // без type:'base' => слоят е овърлей (тикче, не радио-бутон)
            visible: false, // стартира изключен, включва се с тикчето
            zIndex: 3, // над базовата карта и над ORM/Hiking (zIndex 1)
            opacity,
            source: source(ol),
        });

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
            if (PAGE.layerSwitcher && typeof PAGE.layerSwitcher.renderPanel === 'function') {
                PAGE.layerSwitcher.renderPanel();
            }
        } catch {
            /* ако не стане – слоевете пак ще се появят при следващо отваряне на менюто */
        }

        console.log(`[kade-iag-overlay] добавени ${OVERLAYS.length} овърлея.`);
    };

    init();
})();
