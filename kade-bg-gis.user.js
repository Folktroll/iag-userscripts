// ==UserScript==
// @name         kade.si – ИАГ/КАИС/ЗТ слоеве + инфо при клик
// @namespace    https://maps.iag.bg/
// @version      2.9.0
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
// @connect      api.opentopodata.org
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

    // Надморска височина за точка (opentopodata EU-DEM 25 м; през GM – няма CORS).
    const fetchElevation = (lat, lon) =>
        new Promise((resolve, reject) => {
            if (!gmXHR) {
                reject(new Error('GM липсва'));
                return;
            }
            gmXHR({
                method: 'GET',
                url: `https://api.opentopodata.org/v1/eudem25m?locations=${lat.toFixed(6)},${lon.toFixed(6)}`,
                onload: (res) => {
                    try {
                        const m = JSON.parse(res.responseText)?.results?.[0]?.elevation;
                        resolve(m == null ? null : Math.round(m));
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

    // ArcGIS източник през server-side export (слоевете са в EPSG:7801/32635, картата
    // в 3857 – услугата препроектира per tile). Без Referer-трикове – КАИС и cavegis
    // са достъпни директно.
    const arcgisSource = (ol, { url, attr, params }) =>
        new ol.source.TileArcGISRest({ url, attributions: attr, params });

    // Редът тук = ред в менюто (отгоре надолу); последният ред излиза най-долу.
    // `shortTitle` – уникален код; нужен е за permalink логиката на kade.si (иначе при
    // зуум слой без shortTitle се включва принудително пак).
    // NB: „Горска карта“ и „Ловни райони“ като видими слоеве нарочно ги няма –
    // претрупват картата и са излишни, щом при клик се показва инфото И се очертава
    // районът. Инфото за Гора/Лов идва от INFO_LAYERS (GetFeatureInfo), независимо от
    // видим слой, затова остава.
    const OVERLAYS = [
        {
            title: 'Защитени територии',
            shortTitle: 'zt',
            opacity: 0.55,
            defaultOn: true,
            source: (ol) => arcgisSource(ol, { url: ZT, attr: ZT_ATTR, params: { format: 'png32', transparent: true } }),
        },
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

    const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

    // Горският слой връща по ред на дървесен вид (елемент на насаждението), често в
    // няколко яруса (STAGE: „I етаж“, „Подлес“, „II етаж“…). Групираме по подотдел
    // (key_id) → по ярус, махаме дубликатите и единичните примеси (PART=0). Съставът е
    // „дял вид“ (PART+TR_SP), а възрастта (AGE) е на ярус – показваме я до състава му,
    // защото в различните яруси се различава. SLOPE е на ниво подотдел.
    const aggregateForest = (features) => {
        const stands = new Map();
        for (const p of features) {
            const sp = p.TR_SP;
            if (blank(sp) || Number(p.PART) === 0) continue; // без празни и без примес (дял 0)
            const kid = blank(p.key_id) ? '' : String(p.key_id);
            let st = stands.get(kid);
            if (!st) {
                // атрибути на ниво подотдел (еднакви по редовете) – за проходимостта
                st = {
                    key: kid,
                    slope: p.SLOPE,
                    stony: p.STONY,
                    vidpod: p.VIDPOD,
                    damage: p.DAMAGE,
                    erosion: p.EROSION,
                    humidity: p.HUMIDITY,
                    relief: p.RELIEF,
                    state: p.STATE,
                    stages: new Map(),
                };
                stands.set(kid, st);
            }
            const stageName = blank(p.STAGE) ? '' : String(p.STAGE).trim();
            let stg = st.stages.get(stageName);
            if (!stg) {
                stg = { name: stageName, species: new Map(), age: p.AGE, topPart: -1, fullness: 0, minHeight: Infinity };
                st.stages.set(stageName, stg);
            }
            const f = Number(p.FULLNESS) || 0; // пълнота, в десети (6 = 0.6)
            if (f > stg.fullness) stg.fullness = f;
            const h = Number(p.HEIGHT); // средна височина, м
            if (!Number.isNaN(h) && h > 0 && h < stg.minHeight) stg.minHeight = h;
            if (!stg.species.has(sp)) {
                stg.species.set(sp, p.PART); // PART = дял в състава
                const part = Number(p.PART) || 0;
                if (part > stg.topPart) {
                    stg.topPart = part;
                    stg.age = p.AGE; // възраст от водещия вид на яруса
                }
            }
        }
        const records = [];
        for (const st of stands.values()) {
            const lines = [];
            if (st.key) lines.push(`подотдел: ${st.key}`);
            const stageList = [...st.stages.values()].filter((s) => s.species.size);
            const single = stageList.length === 1;
            for (const stg of stageList) {
                const comp = [...stg.species.entries()]
                    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0)) // по дял, низходящо
                    .map(([sp, part]) => `${part} ${sp}`)
                    .join(', ');
                const age = blank(stg.age) || Number(stg.age) === 0 ? '' : ` · ${stg.age} г.`;
                const label = single || !stg.name ? 'състав' : stg.name;
                lines.push(`${label}: ${comp}${age}`);
            }
            lines.push(`🚶 вероятна проходимост: ${forestPassability(st)}`);
            // NB: SLOPE е среден наклон за целия подотдел (полигон, не точката) – затова
            // го маркираме, за да не се чете като локалния наклон под краката.
            if (!blank(st.slope)) lines.push(`ср. наклон (подотдел): ${st.slope}°`);
            if (lines.length) records.push(lines);
        }
        return records;
    };

    // Проходимост за планинар (многофакторен точков модел, по подобие на военния
    // Cross-Country Movement: 3 класа добра/затруднена/трудна). Сборува тежести от
    // каменливост, вид гора, повреди, структура, стръмност и ниска гъста растителност.
    // ВАЖНО: това е насока от лесовъдските атрибути на НАСАЖДЕНИЕТО – не вижда отвеси,
    // вградени в иначе полегат подотдел; за тях гледай контурите.
    const PASS_LVL = ['добра', 'затруднена', 'трудна'];
    // Предпазлив буфер: качва крайния индекс с този процент, преди да реши класа.
    // За планинар е по-безопасно да надцени трудността. 0 = неутрално; 0.25 = +25%
    // (по-предпазливо, клони към по-трудно). Тунирай след тест по познати места.
    const PASS_CAUTION = 0;
    const PASS_T = { hard: 3, med: 2 }; // прагове на суровия индекс
    const lc = (v) => String(v == null ? '' : v).toLowerCase();
    const forestPassability = (st) => {
        const factors = [];
        let score = 0;
        const add = (w, tag) => {
            score += w;
            if (tag) factors.push(tag);
        };
        // ВАЖНО: броим само ИЗВЪН-нормалните сигнали. „Средно каменливо“ (~70%),
        // издънкова гора (~80%) и разновъзрастна структура (~60%) са НОРМАТА за БГ
        // гора – ако ги броим, всичко излиза трудно. Затова ги пропускаме.
        // каменливост – само силната, и то слабо (+1). Само по себе си каменливо (дори
        // „силно“) НЕ е трудно – минава се. Става пречка в КОМБИНАЦИЯ с наклон или
        // къпини/трънки (подлес); сумирането го дава естествено.
        if (lc(st.stony).includes('силно')) add(1, 'силно каменливо');
        // вид на покритието
        const vp = lc(st.vidpod);
        const open = /поляна|просека|път|изредена/.test(vp);
        if (vp.includes('скали')) add(3, 'скали');
        // повреди (паднала дървесина)
        const dmg = lc(st.damage);
        if (/ветровал|снеголом|каламитет|бурелом|пожар/.test(dmg)) add(3, 'паднала дървесина');
        else if (/суховърш|съхнен|изсъхв/.test(dmg)) add(1, 'съхнещи дървета');
        // ерозия
        if (!blank(st.erosion)) add(1, 'ерозия');
        // влажност – само мокрите/мочурливи места (кал, буйна растителност, хлъзгаво).
        // „Свежа“/„Влажна“ са норма и се ходят нормално; „Суха“ е дори по-лесно.
        if (/мокра|преувлажнена|заблатена|мочур/.test(lc(st.humidity))) add(2, 'мокро/мочурливо');
        // падина – влажно понижение, често обрасло (NB: само „падина“, не „долна“!)
        if (/падина/.test(lc(st.relief))) add(1, 'падина');
        // ТРЪНИ/КЪПИНИ – най-тежката пречка („нямаш шанс“). Записват се в различни полета
        // (често слой с празно STAGE → „състав“) и слабо зависят от „пълнота“, затова ги
        // мерим по ДЯЛ (PART), независимо къде са. После: именуван подлес/подраст по
        // гъстота; нисък гъст етаж (млад гъсталак).
        const THORNY = /къпина|къпинак|драка|трън|глог|шипка|смрадлика|хвойна|клек|папрат/i;
        let groundVeg = false; // реална приземна пречка (блокира кредита за качество)
        for (const stg of st.stages.values()) {
            if (!stg.species.size) continue;
            const spTxt = [...stg.species.keys()].slice(0, 2).join(', ');
            const thornyPart = [...stg.species].filter(([sp]) => THORNY.test(sp)).reduce((a, [, p]) => a + (Number(p) || 0), 0);
            if (thornyPart >= 7) {
                add(4, `гъсти тръни/къпини (${spTxt})`);
                groundVeg = true;
            } else if (thornyPart >= 4) {
                add(3, `тръни/къпини (${spTxt})`);
                groundVeg = true;
            } else if (thornyPart >= 1) {
                add(1, `единични тръни/къпини (${spTxt})`);
            } else if (/подлес|подраст/i.test(stg.name)) {
                if (stg.fullness >= 6) {
                    add(3, `гъст ${stg.name.toLowerCase()} (${spTxt})`);
                    groundVeg = true;
                } else if (stg.fullness >= 3) {
                    add(2, `${stg.name.toLowerCase()} (${spTxt})`);
                    groundVeg = true;
                }
            } else if (/етаж/i.test(stg.name) && stg.minHeight <= 4 && stg.fullness >= 7) {
                add(2, `млад гъсталак (${spTxt})`);
                groundVeg = true;
            }
        }
        // Стръмност – тежи СЛАБО: стръмно „може да е трудно, но се минава“. Само по себе
        // си най-много „затруднена“, не „трудна“. NB: SLOPE е усреднен за подотдела.
        const sl = Number(st.slope) || 0;
        if (sl >= 38) add(2, 'много стръмно');
        else if (sl >= 28) add(1, 'стръмно');
        // Кредит за качество: чиста зряла затворена гора (БЕЗ подлес/тръни) е по-лесна,
        // дори с втори етаж от високи дървета → компенсира наклон/каменливо.
        const penalty = score; // индексът само от пречките (преди кредита)
        const treeStages = [...st.stages.values()].filter((s) => s.species.size && /етаж/i.test(s.name));
        const mainTree = treeStages.find((s) => /I\s*ета/i.test(s.name)) || treeStages[0];
        if (mainTree && !groundVeg && (Number(mainTree.age) || 0) >= 60 && mainTree.fullness >= 6) {
            if (/добро/i.test(lc(st.state))) {
                score -= 2;
                factors.push('✓ зряла гора, добро състояние');
            } else {
                score -= 1;
                factors.push('✓ зряла гора');
            }
        }
        if (score < 0) score = 0;
        // Предпазливо: трудността е относителна → по-добре да надценим. Кредитът за
        // качество може да смекчи трудна→затруднена, но НЕ прави „добра“, ако е имало
        // реална пречка (penalty ≥ среден праг). Така наклон/камениво не изчезват.
        if (penalty >= PASS_T.med && score < PASS_T.med) score = PASS_T.med;
        // предпазлив буфер върху индекса, после праг
        const adj = score * (1 + PASS_CAUTION);
        // открит терен (поляна/просека/път) – сваляме, ако няма тежка пречка
        const lvl = open && adj < PASS_T.hard - 1 ? 0 : adj >= PASS_T.hard ? 2 : adj >= PASS_T.med ? 1 : 0;
        return factors.length ? `${PASS_LVL[lvl]} — ${factors.join(', ')}` : PASS_LVL[lvl];
    };

    // WMS слоеве на ИАГ и показвани полета.
    const INFO_LAYERS = [
        {
            name: 'IAG:lr_hunting_08_2024',
            title: 'Лов',
            tagClass: 'hunt',
            key: null,
            geomMode: 'fid', // очертаване: WFS по featureID (чистият id работи)
            fields: [
                ['lr', ''],
                ['lovishte', 'ловище'],
            ],
            // NB: не добавяме извод „не се ловува“ за развъдник – по ЗЛОД (чл. 54) ловът
            // там е забранен, но данните в слоя не са надеждни (срещат се развъдници, в
            // които реално се ловува), затова категорично твърдение би подвело. Полето
            // „ловище: развъдник“ се показва както си е и читателят си преценява.
        },
        {
            name: 'IAG:dleso_full_2022',
            title: 'Гора',
            key: 'key_id',
            geomMode: 'cql', // очертаване: WFS по key_id (fid-- форматът не се резолвва)
            // Връща по ред на дървесен вид → теглим тези полета и ги агрегираме.
            queryFields: ['TR_SP', 'PART', 'AGE', 'SLOPE', 'STAGE', 'FULLNESS', 'HEIGHT', 'STONY', 'VIDPOD', 'DAMAGE', 'EROSION', 'HUMIDITY', 'RELIEF', 'STATE'],
            aggregate: aggregateForest,
        },
    ];

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
        // За агрегиращ слой теглим queryFields, иначе – показваните полета.
        const names = layer.aggregate ? layer.queryFields : layer.fields.map((f) => f[0]);
        const props = [...new Set([...names, ...(layer.key ? [layer.key] : [])])];
        const url =
            `${GEOSERVER}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
            `&QUERY_LAYERS=${encodeURIComponent(layer.name)}` +
            `&LAYERS=${encodeURIComponent(layer.name)}` +
            `&INFO_FORMAT=${encodeURIComponent('application/json')}` +
            // 50 – един подотдел може да има няколко вида, всеки дублиран по 2 пъти.
            `&FEATURE_COUNT=50&PROPERTYNAME=${props.join(',')}` +
            `&CRS=EPSG:3857&WIDTH=3&HEIGHT=3&I=1&J=1` +
            `&BBOX=${encodeURIComponent(bbox)}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`${layer.name}: HTTP ${res.status}`);
        const data = await res.json();
        const feats = data.features ?? [];
        const features = feats.map((f) => f.properties ?? {});

        // `values` – ключове/ид за очертаване на районите (WFS): key_id за гора, feature id за лов.
        if (layer.aggregate) {
            const seen = new Set();
            const values = [];
            for (const f of feats) {
                const kid = f.properties?.[layer.key];
                if (blank(kid) || seen.has(kid)) continue;
                seen.add(kid);
                values.push(kid);
            }
            return { records: layer.aggregate(features), values };
        }

        // Общ случай (Лов): по ред на feature, с дедупликация.
        const seen = new Set();
        const records = [];
        const values = [];
        for (const f of feats) {
            const p = f.properties ?? {};
            const lines = layer.fields.map((fd) => fmtField(fd, p)).filter(Boolean);
            if (lines.length === 0) continue;
            const dedupKey = layer.key && !blank(p[layer.key]) ? String(p[layer.key]) : lines.join('|');
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            if (layer.note) {
                const nt = layer.note(p);
                if (nt) lines.push(nt);
            }
            records.push(lines);
            if (f.id) values.push(f.id);
        }
        return { records, values };
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
            // returnGeometry=true => връща и полигона (за очертаване)
            `&tolerance=2&mapExtent=${ext}&imageDisplay=256,256,96&layers=all&returnGeometry=true&f=json`;
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
                geomRings: r.geometry || null, // ESRI геометрия (rings) в 3857 – за очертаване
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

    const buildPopup = (ol, map, onClose) => {
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
            if (onClose) onClose(); // чисти очертанията
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

    const renderIagRecord = (layer, lines) => {
        const tagClass = layer.tagClass ? ` iag-popup__tag--${layer.tagClass}` : '';
        return (
            `<div class="iag-popup__sec"><span class="iag-popup__tag${tagClass}">${esc(layer.title)}</span>` +
            lines.map((l) => `<div>${esc(l)}</div>`).join('') +
            '</div>'
        );
    };

    // Няколко резултата в една група: първите `keep`, останалите под „още N…“.
    // (Свиваме само ако скритите са поне 2 – иначе няма смисъл от бутон.)
    const withOverflow = (blocks, keep = 2) => {
        if (blocks.length <= keep + 1) return blocks.join('');
        return (
            blocks.slice(0, keep).join('') +
            `<details class="iag-more"><summary>още ${blocks.length - keep}…</summary>${blocks.slice(keep).join('')}</details>`
        );
    };

    const renderPopup = ({ lat, lon, protAreas, iagResults }) => {
        let html = `<div class="iag-popup__coords">${lat.toFixed(5)}, ${lon.toFixed(5)}<span class="iag-popup__elev"></span></div>`;
        let any = false;
        if (protAreas.length) {
            any = true;
            html += withOverflow(protAreas.map(renderProtected));
        }
        for (const { layer, records } of iagResults) {
            if (!records.length) continue;
            any = true;
            html += withOverflow(records.map((lines) => renderIagRecord(layer, lines)));
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
.iag-popup{position:absolute;min-width:250px;max-width:440px;width:max-content;background:#fff;color:#1a1a1a;
  border:1px solid #bbb;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);
  padding:10px 12px 10px;font:13px/1.4 system-ui,Arial,sans-serif;bottom:12px;left:-50%}
.iag-popup::after{content:"";position:absolute;bottom:-9px;left:50%;margin-left:-8px;
  border:8px solid transparent;border-top-color:#fff;filter:drop-shadow(0 1px 0 #bbb)}
.iag-popup__close{position:absolute;top:4px;right:8px;color:#888;text-decoration:none;font-size:16px}
.iag-popup__close:hover{color:#000}
.iag-popup__coords{font-size:11px;color:#888;margin-bottom:6px}
.iag-popup__elev{font-weight:700;color:#3a6ea5;font-size:12px}
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
.iag-more{margin-top:8px}
.iag-more>summary{cursor:pointer;color:#1d5f7a;font-size:12px;font-weight:600}
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

    // --- управление на базовите слоеве на kade.si -----------------------------
    // Излишни базови слоеве – скриваме ги от менюто по подразбиране (сравнява се
    // нормализирано: малки букви, без интервали/тирета/долни черти).
    const CLUTTER_LAYERS = [
        'sentinel-2',
        'bgtopo-100k',
        'bgtopovj-100k',
        'etk-5k-10k',
        'bgtopo-1933',
        'bgtopo-126k',
        'bgtopo-210k',
        'gkme-200k',
        'seetopo',
        // Hiking и Open Railway Map ги включваме по подразбиране, но и тях скриваме –
        // чекбоксовете им са излишни (не ги пипаш).
        'hiking',
        'openrailwaymap',
    ];
    // Слоеве, които включваме по подразбиране (веднъж при зареждане).
    const ENABLE_LAYERS = ['hiking', 'openrailwaymap'];
    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s_-]+/g, '');

    // Чекбокс „Всички базови слоеве“ – показва/скрива излишните. По подразбиране скрити.
    const LAYERS_KEY = 'iag-show-all-layers';
    let showAllLayers = false;
    try {
        showAllLayers = localStorage.getItem(LAYERS_KEY) === '1';
    } catch {
        /* default */
    }
    const saveShowAll = () => {
        try {
            localStorage.setItem(LAYERS_KEY, showAllLayers ? '1' : '0');
        } catch {
            /* игнорираме */
        }
    };

    // Скрива/показва излишните редове в панела според showAllLayers.
    const applyClutter = (ul) => {
        for (const li of ul.querySelectorAll('li')) {
            if (li.classList.contains('iag-info-row') || li.classList.contains('iag-sep') || li.classList.contains('iag-layers-row')) continue;
            const t = norm(li.textContent);
            if (CLUTTER_LAYERS.some((n) => t.includes(norm(n)))) li.style.display = showAllLayers ? '' : 'none';
        }
    };

    // Включва по подразбиране зададените слоеве (Hiking, Open Railway Map) – веднъж.
    const enableDefaultLayers = (map) => {
        const walk = (layers) => {
            layers.forEach((l) => {
                if (l.getLayers) {
                    walk(l.getLayers());
                    return;
                }
                const t = norm(l.get && l.get('title'));
                if (t && ENABLE_LAYERS.some((n) => t.includes(norm(n)))) {
                    try {
                        l.setVisible(true);
                    } catch {
                        /* игнорираме */
                    }
                }
            });
        };
        try {
            walk(map.getLayers());
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

        // включваме по подразбиране Hiking + Open Railway Map (веднъж)
        enableDefaultLayers(map);

        // --- очертаване на районите при клик ---------------------------------
        // Тънък vector слой най-отгоре; геометрията се тегли по ключ/ид (гора/лов през
        // WFS, ЗТ – от identify). Цвят по вид, съвпада с етикета в попъпа. Всичко е
        // в try: ако OL билдът на kade.si няма Vector/EsriJSON, само очертаването пада,
        // а попъпът/височината си работят.
        let highlightSource = null;
        let drawHighlights = async () => {};
        try {
            const HL_COLORS = { nature: '#1d5f7a', forest: '#2b6a2b', hunt: '#b5651d' };
            const geojson = new ol.format.GeoJSON();
            const esri = new ol.format.EsriJSON();
            highlightSource = new ol.source.Vector();
            const highlightLayer = new ol.layer.Vector({
                source: highlightSource,
                zIndex: 50,
                style: (feature) => {
                    const c = HL_COLORS[feature.get('kind')] || '#333';
                    return new ol.style.Style({
                        stroke: new ol.style.Stroke({ color: c, width: 3 }),
                        fill: new ol.style.Fill({ color: c + '22' }),
                    });
                },
            });
            map.addLayer(highlightLayer);
            const WFS = 'https://maps.iag.bg/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature';

            const fetchIagGeom = async (layer, values) => {
                if (!values || !values.length) return [];
                let url = `${WFS}&typeNames=${encodeURIComponent(layer.name)}&srsName=EPSG:3857&outputFormat=application/json`;
                if (layer.geomMode === 'fid') {
                    url += `&featureID=${values.map(encodeURIComponent).join(',')}`;
                } else {
                    const inList = values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
                    url += `&CQL_FILTER=${encodeURIComponent(`${layer.key} IN (${inList})`)}`;
                }
                const res = await fetch(url);
                if (!res.ok) return [];
                const feats = geojson.readFeatures(await res.json());
                if (layer.geomMode === 'fid') return feats;
                // гора: по няколко реда на подотдел с еднаква геометрия → по 1 на key_id
                // (иначе застъпените полигони сумират прозрачността и запълват плътно)
                const seen = new Set();
                return feats.filter((f) => {
                    const k = f.get(layer.key);
                    if (k == null || !seen.has(k)) {
                        seen.add(k);
                        return true;
                    }
                    return false;
                });
            };

            drawHighlights = async (iagResults, protAreas) => {
                // Защитени територии – геометрията вече е дошла с identify
                const nature = [];
                for (const pa of protAreas) {
                    if (!pa.geomRings) continue;
                    try {
                        const f = new ol.Feature({ geometry: esri.readGeometry(pa.geomRings) });
                        f.set('kind', 'nature');
                        nature.push(f);
                    } catch {
                        /* пропускаме невалидна геометрия */
                    }
                }
                if (nature.length) highlightSource.addFeatures(nature);
                // IAG слоеве (гора/лов) – теглят се през WFS
                const lists = await Promise.all(iagResults.map((r) => fetchIagGeom(r.layer, r.values).catch(() => [])));
                const more = [];
                lists.forEach((list, i) => {
                    const kind = iagResults[i].layer.name.includes('hunting') ? 'hunt' : 'forest';
                    list.forEach((f) => {
                        f.set('kind', kind);
                        more.push(f);
                });
            });
                if (more.length) highlightSource.addFeatures(more);
            };
        } catch (e) {
            console.warn('[kade-iag] очертаване недостъпно:', e);
        }

        // --- popup при клик ---
        const { overlay, body } = buildPopup(ol, map, () => highlightSource?.clear());

        map.on('singleclick', async (evt) => {
            if (!infoEnabled) return;
            const [x, y] = evt.coordinate; // EPSG:3857
            const [lon, lat] = ol.proj.transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
            overlay.setPosition(evt.coordinate);
            body.innerHTML = '<div class="iag-popup__empty">Зареждане…</div>';
            highlightSource?.clear(); // махаме очертанието от предишния клик
            // надморска височина – тегли се паралелно, не блокира текста
            const elevP = fetchElevation(lat, lon).catch(() => null);
            try {
                const [iagResultsRaw, protAreas] = await Promise.all([
                    Promise.all(INFO_LAYERS.map(async (layer) => ({ layer, ...(await queryInfoLayer(layer, x, y)) }))),
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
                // попълваме височината, щом дойде (елементът вече е в DOM)
                elevP.then((m) => {
                    const el = body.querySelector('.iag-popup__elev');
                    if (el && m != null) {
                        el.textContent = ` · ⛰ ${m} м`;
                        el.title = 'надморска височина';
                    }
                });
                // очертаваме районите (не блокира текста)
                drawHighlights(iagResultsRaw, protAreas);
            } catch (err) {
                body.innerHTML = `<div class="iag-popup__empty">Грешка: ${err.message}</div>`;
            }
        });

        // Прави ред с чекбокс (id, етикет, начало, при промяна). Връща <li>.
        const makeCheckRow = (cls, id, labelHtml, checked, onChange) => {
            const li = document.createElement('li');
            li.className = cls;
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = id;
            input.checked = checked;
            input.addEventListener('change', () => onChange(input.checked));
            const label = document.createElement('label');
            label.htmlFor = id;
            label.innerHTML = labelHtml;
            li.appendChild(input);
            li.appendChild(label);
            return li;
        };

        // --- нашите тикчета + разделител, най-горе в нашата група ---
        // Ред в менюто: разделител → Инфо при клик → Всички базови слоеве → овърлеите.
        const addInfoRow = (panel) => {
            const ul = panel && panel.querySelector('ul');
            if (!ul) return;
            if (!ul.querySelector('#iag-info-toggle')) {
                // първият ред със значка „NEW“, който НЕ е наш – това е първият ни овърлей
                const firstOurs = [...ul.querySelectorAll('li')].find(
                    (li) => li.querySelector('.iag-new') && !li.classList.contains('iag-info-row'),
                );
                // разделител над нашата група
                if (!ul.querySelector('.iag-sep') && firstOurs) {
                    const sep = document.createElement('li');
                    sep.className = 'iag-sep';
                    ul.insertBefore(sep, firstOurs);
                }
                const infoLi = makeCheckRow('iag-info-row', 'iag-info-toggle', 'Инфо при клик' + NEW_BADGE, infoEnabled, (on) => {
                    infoEnabled = on;
                    saveInfo();
                    if (!infoEnabled) {
                        overlay.setPosition(undefined); // скрий отворения popup
                        highlightSource?.clear(); // и очертанията
                    }
                });
                const layersLi = makeCheckRow('iag-layers-row', 'iag-layers-toggle', 'Всички базови слоеве' + NEW_BADGE, showAllLayers, (on) => {
                    showAllLayers = on;
                    saveShowAll();
                    applyClutter(ul); // покажи/скрий излишните веднага
                });
                const anchor = firstOurs || null;
                ul.insertBefore(infoLi, anchor);
                ul.insertBefore(layersLi, anchor);
            }
            applyClutter(ul); // скрий излишните базови слоеве (всеки render)
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
