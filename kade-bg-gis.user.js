// ==UserScript==
// @name         kade.si – ИАГ/КАИС/ЗТ слоеве + инфо при клик
// @namespace    https://maps.iag.bg/
// @version      2.6.1
// @description  Добавя към kade.si прозрачни овърлеи (ловни райони и горска карта от ИАГ, кадастрални граници, защитени територии) с тикчета в менюто, и popup при клик с инфо за точката – включително режим на дейности (какво може/не може) от регистъра на ЗТ. Най-долу в менюто има тикче за вкл./изкл. на popup-а.
// @match        https://kade.si/*
// @homepageURL  https://github.com/Folktroll/iag-userscripts
// @supportURL   https://github.com/Folktroll/iag-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/Folktroll/iag-userscripts/main/kade-bg-gis.user.js
// @updateURL    https://raw.githubusercontent.com/Folktroll/iag-userscripts/main/kade-bg-gis.user.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      eea.government.bg
// @connect      maps.cavegis.com
// ==/UserScript==

(() => {
    'use strict';

    // При наличие на @grant скриптът е в sandbox – глобалните на kade.si (map, ol,
    // layerSwitcher) се достигат през unsafeWindow.
    const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // GM_xmlhttpRequest (класически) или GM.xmlHttpRequest (нов API) – нужен е за
    // area.jsp на ИАОС, който няма CORS (чете се като blob и се декодира от CP1251).
    const gmXHR =
        typeof GM_xmlhttpRequest !== 'undefined'
            ? GM_xmlhttpRequest
            : typeof GM !== 'undefined' && GM.xmlHttpRequest
              ? GM.xmlHttpRequest.bind(GM)
              : null;

    // Тегли HTML, кодиран в windows-1251 (регистърът на ИАОС), през GM_xmlhttpRequest.
    const gmGetHtml1251 = (url) =>
        new Promise((resolve, reject) => {
            if (!gmXHR) {
                reject(new Error('GM_xmlhttpRequest липсва'));
                return;
            }
            gmXHR({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300 && res.response) {
                        try {
                            resolve(new TextDecoder('windows-1251').decode(res.response));
                        } catch (e) {
                            reject(e);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.status}`));
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
    // Защитени територии – услугата, която ползва и картата на WWF (gis.wwf.bg).
    // Праща CORS, слоевете са в EPSG:32635 и услугата препроектира при export.
    const ZT = 'https://maps.cavegis.com/arcgis/rest/services/uzdp/protected_areas/MapServer';
    const ZT_ATTR =
        '<a href="https://eea.government.bg/zpo/" target="_blank">Регистър на ЗТ (ИАОС)</a>';
    // Регистърът на ИАОС – оттам вадим „Режим на дейности“ за всяка ЗТ.
    const EEA_AREA = 'https://eea.government.bg/zpo/bg/area.jsp';

    // ===========================================================================
    // 1) ОВЪРЛЕИ (слоеве с тикчета)
    // ===========================================================================

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

    // ArcGIS източник през server-side export (слоевете са в EPSG:7801/32635, картата
    // в 3857 – услугата препроектира per tile). Без Referer-трикове – КАИС и cavegis
    // са достъпни директно.
    const arcgisSource = (ol, { url, attr, params }) =>
        new ol.source.TileArcGISRest({ url, attributions: attr, params });

    // Редът тук = ред в менюто (отгоре надолу); последният ред излиза най-долу.
    // `shortTitle` – уникален код; нужен е за permalink логиката на kade.si (иначе при
    // зуум слой без shortTitle се включва принудително пак).
    // NB: „Горска карта“ като видим слой нарочно я няма – контурите претрупват
    // картата. Инфото за „Гора“ при клик идва от INFO_LAYERS (GetFeatureInfo),
    // независимо от видим слой, затова остава.
    const OVERLAYS = [
        {
            title: 'Защитени територии',
            shortTitle: 'zt',
            opacity: 0.55,
            defaultOn: true,
            source: (ol) => arcgisSource(ol, { url: ZT, attr: ZT_ATTR, params: { format: 'png32', transparent: true } }),
        },
        { title: 'ИАГ – Ловни райони', shortTitle: 'iaglov', opacity: 0.55, defaultOn: true, source: (ol) => iagTileSource(ol, 'IAG:lr_hunting_08_2024') },
        {
            title: 'Кадастър (граници)',
            shortTitle: 'kais',
            opacity: 0.8,
            source: (ol) => arcgisSource(ol, { url: KAIS, attr: KAIS_ATTR, params: { format: 'png', transparent: true } }),
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

    // --- Защитени територии: кой обект е под точката (cavegis identify) ----------
    // Връща по един запис на засегнат слой: категория (layerName), име (value) и
    // CODE1 = „Partition_categoryID_areaID“ – с него сглобяваме URL към регистъра.
    const areaUrl = ({ partition, categoryId, areaId }) =>
        `${EEA_AREA}?NEM_Partition=${partition}&categoryID=${categoryId}&areaID=${areaId}`;

    const queryProtectedAreas = async (x, y) => {
        const d = 60; // mapExtent padding (метри в 3857)
        const ext = `${x - d},${y - d},${x + d},${y + d}`;
        const url =
            `${ZT}/identify?geometry=${x},${y}&geometryType=esriGeometryPoint&sr=3857` +
            `&tolerance=2&mapExtent=${ext}&imageDisplay=256,256,96&layers=all&returnGeometry=false&f=json`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`ЗТ: HTTP ${res.status}`);
        const data = await res.json();
        const seen = new Set();
        const out = [];
        for (const r of data.results ?? []) {
            const code = r.attributes?.CODE1;
            if (!code || seen.has(code)) continue;
            seen.add(code);
            const [partition, categoryId, areaId] = String(code).split('_');
            if (!areaId) continue;
            out.push({
                code,
                partition,
                categoryId,
                areaId,
                category: r.layerName || '',
                name: r.value || r.attributes?.NAME_BG || r.attributes?.NAME1 || '',
            });
        }
        return out;
    };

    // --- Режим на дейности: парсва се от area.jsp -------------------------------
    // Редовете започват с „Забранява се …“ или „Разрешава се …“; групираме ги в
    // ❌/✅ и режем кратка „глава“ (до първата запетая/„освен“) за свитото изписване.
    const regimeHead = (s) => s.split(/,| освен | с които | с цел /)[0].trim();

    const stripTags = (h) =>
        h
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/ /g, ' ');

    const parseRegime = (rawHtml) => {
        const html = rawHtml.replace(/<!--[\s\S]*?-->/g, ''); // махаме HTML коментари
        const label = 'Режим на дейности';
        const li = html.indexOf(label);
        if (li < 0) return null;
        // Режимът е в един <p>: елементите са <strong>N.</strong>текст</span><br>.
        // Затова режем блока до първия </p> и цепим по <br> (не по „;“ – не всеки ред
        // има „;“ накрая, а понякога елементите са слепени само с номера).
        let end = html.indexOf('</p>', li);
        if (end < 0) end = html.length;
        const block = html.slice(li, end);
        const items = block
            .split(/<br\s*\/?>/i)
            .map((seg) =>
                stripTags(seg)
                    .replace(/^\s*\d+\.\s*/, '') // водещ номер „1. “
                    .replace(/\s+/g, ' ')
                    .replace(/[\s;.,]+$/, '') // завършващ „;“/„.“ (разделител в списъка)
                    .trim(),
            )
            // без празни, без боклук и без самия етикет „Режим на дейности:“
            .filter((s) => s && /[А-Яа-я]/.test(s) && !s.includes(label));
        const no = [];
        const yes = [];
        const other = [];
        for (const it of items) {
            // NB: без \b – в JS regex кирилицата е „не-дума“ и \b не хваща след „се“.
            if (/^Забранява(?:т)?\s+се(?:\s|$)/.test(it)) {
                const full = it.replace(/^Забранява(?:т)?\s+се\s*/, '');
                no.push({ full, head: regimeHead(full) });
            } else if (/^Разрешава(?:т)?\s+се(?:\s|$)/.test(it)) {
                const full = it.replace(/^Разрешава(?:т)?\s+се\s*/, '');
                yes.push({ full, head: regimeHead(full) });
            } else {
                other.push({ full: it, head: regimeHead(it) });
            }
        }
        if (!no.length && !yes.length && !other.length) return null;
        return { no, yes, other };
    };

    // Кеш по CODE1 в localStorage, за да не теглим area.jsp повторно.
    const regimeCacheKey = (code) => `iag-zt-${code}`;
    const fetchRegime = async (pa) => {
        try {
            const c = localStorage.getItem(regimeCacheKey(pa.code));
            if (c !== null) return JSON.parse(c);
        } catch {
            /* без кеш – просто теглим */
        }
        const html = await gmGetHtml1251(areaUrl(pa));
        const parsed = parseRegime(html);
        try {
            localStorage.setItem(regimeCacheKey(pa.code), JSON.stringify(parsed));
        } catch {
            /* игнорираме */
        }
        return parsed;
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

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    // Група „Не може“/„Може“: първите 3 реда + <details> за останалите.
    const renderRegimeGroup = (kind, items) => {
        if (!items || !items.length) return '';
        const cfg = {
            no: { cls: 'no', label: '❌ Не може:' },
            yes: { cls: 'yes', label: '✅ Може:' },
            other: { cls: 'other', label: 'ℹ️ Други условия:' },
        }[kind];
        const li = (it) => `<li title="${esc(it.full)}">${esc(it.head)}</li>`;
        const head = items.slice(0, 3).map(li).join('');
        let extra = '';
        if (items.length > 3) {
            const rest = items.slice(3).map(li).join('');
            extra = `<details class="iag-reg__more"><summary>още ${items.length - 3}…</summary><ul class="iag-reg__list">${rest}</ul></details>`;
        }
        return `<div class="iag-reg iag-reg--${cfg.cls}"><div class="iag-reg__lbl">${cfg.label}</div><ul class="iag-reg__list">${head}</ul>${extra}</div>`;
    };

    const renderProtected = (pa) => {
        let h = '<div class="iag-popup__sec">';
        h += `<span class="iag-popup__tag iag-popup__tag--nature">${esc(pa.category)}</span> `;
        h += `<a class="iag-popup__name" href="${esc(areaUrl(pa))}" target="_blank" rel="noopener">${esc(pa.name)}</a>`;
        const r = pa.regime;
        if (!r) {
            h += '<div class="iag-popup__muted">(режимът не е наличен – виж в регистъра)</div>';
        } else {
            h += renderRegimeGroup('no', r.no);
            h += renderRegimeGroup('yes', r.yes);
            h += renderRegimeGroup('other', r.other);
        }
        h += '</div>';
        return h;
    };

    const renderIag = (layer, records) => {
        let h = '';
        for (const lines of records) {
            const tagClass = layer.tagClass ? ` iag-popup__tag--${layer.tagClass}` : '';
            h += `<div class="iag-popup__sec"><span class="iag-popup__tag${tagClass}">${esc(layer.title)}</span>`;
            h += lines.map((l) => `<div>${esc(l)}</div>`).join('');
            h += '</div>';
        }
        return h;
    };

    const renderPopup = ({ lat, lon, protAreas, iagResults }) => {
        let html = `<div class="iag-popup__coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`;
        let any = false;
        for (const pa of protAreas) {
            any = true;
            html += renderProtected(pa);
        }
        for (const { layer, records } of iagResults) {
            if (records.length) {
                any = true;
                html += renderIag(layer, records);
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
.iag-popup{position:absolute;min-width:200px;max-width:340px;background:#fff;color:#1a1a1a;
  border:1px solid #bbb;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);
  padding:10px 12px 10px;font:13px/1.4 system-ui,Arial,sans-serif;bottom:12px;left:-50%}
.iag-popup::after{content:"";position:absolute;bottom:-9px;left:50%;margin-left:-8px;
  border:8px solid transparent;border-top-color:#fff;filter:drop-shadow(0 1px 0 #bbb)}
.iag-popup__close{position:absolute;top:4px;right:8px;color:#888;text-decoration:none;font-size:16px}
.iag-popup__close:hover{color:#000}
.iag-popup__coords{font-size:11px;color:#888;margin-bottom:6px}
.iag-popup__sec{margin-top:8px}
.iag-popup__sec:first-of-type{margin-top:0}
.iag-popup__tag{display:inline-block;font-size:11px;font-weight:700;color:#2b6a2b;
  background:#e8f3e8;border-radius:4px;padding:0 6px;margin-bottom:2px}
.iag-popup__tag--nature{color:#1d5f7a;background:#e1f0f6}
.iag-popup__tag--hunt{color:#b5651d;background:#fbe6d0}
.iag-popup__name{color:#1d5f7a;font-weight:600;text-decoration:none}
.iag-popup__name:hover{text-decoration:underline}
.iag-popup__muted{color:#888;font-size:12px;margin-top:3px}
.iag-reg{margin-top:5px}
.iag-reg__lbl{font-size:12px;font-weight:700;margin-bottom:1px}
.iag-reg--no .iag-reg__lbl{color:#b23b3b}
.iag-reg--yes .iag-reg__lbl{color:#2b7a2b}
.iag-reg--other .iag-reg__lbl{color:#555}
.iag-reg__list{margin:0;padding-left:18px}
.iag-reg__list li{margin:0;line-height:1.35}
.iag-reg__more{margin:1px 0 0}
.iag-reg__more summary{cursor:pointer;color:#1d5f7a;font-size:12px}
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
                const [iagResultsRaw, protAreas] = await Promise.all([
                    Promise.all(INFO_LAYERS.map(async (layer) => ({ layer, records: await queryInfoLayer(layer, x, y) }))),
                    queryProtectedAreas(x, y).catch(() => []),
                ]);
                // режимът за всяка засегната ЗТ (паралелно, кеширано)
                const protWithRegime = await Promise.all(
                    protAreas.map(async (pa) => ({ ...pa, regime: await fetchRegime(pa).catch(() => null) })),
                );
                // ред в popup-а: Защитени територии, после Гора, Лов
                // (INFO_LAYERS е [Лов, Гора] => reverse дава [Гора, Лов])
                const iagResults = iagResultsRaw.slice().reverse();
                body.innerHTML = renderPopup({ lat, lon, protAreas: protWithRegime, iagResults });
            } catch (err) {
                body.innerHTML = `<div class="iag-popup__empty">Грешка: ${err.message}</div>`;
            }
        });

        // --- тикче „Инфо при клик“ + разделител, най-горе в нашата група ---
        // Ред в менюто: разделител → Инфо при клик → овърлеите (ЗТ, Лов, Кадастър).
        const addInfoRow = (panel) => {
            const ul = panel && panel.querySelector('ul');
            if (!ul) return;
            if (ul.querySelector('#iag-info-toggle')) return; // вече е добавено при този render
            // първият ред със значка „NEW“, който НЕ е тикчето – това е първият наш овърлей
            const firstOurs = [...ul.querySelectorAll('li')].find(
                (li) => li.querySelector('.iag-new') && !li.classList.contains('iag-info-row'),
            );
            // разделител над нашата група
            if (!ul.querySelector('.iag-sep') && firstOurs) {
                const sep = document.createElement('li');
                sep.className = 'iag-sep';
                ul.insertBefore(sep, firstOurs);
            }
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
            // най-горе в нашата група: под разделителя, над първия овърлей
            if (firstOurs) ul.insertBefore(li, firstOurs);
            else ul.appendChild(li);
        };

        // Обвиваме renderPanel на layer switcher-а, за да добавяме тикчето след всяко
        // прерисуване (то изчиства панела при всяко отваряне).
        const ls = PAGE.layerSwitcher;
        if (ls && typeof ls.renderPanel === 'function') {
            const orig = ls.renderPanel.bind(ls);
            ls.renderPanel = () => {
                orig();
                addInfoRow(ls.panel);
            };
            ls.renderPanel();
        }

        console.log('[kade-iag] готово – овърлеи + инфо при клик.');
    };

    init();
})();
