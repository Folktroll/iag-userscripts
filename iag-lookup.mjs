#!/usr/bin/env node
// Връща смислената информация за дадена GPS точка от картите на ИАГ.
// Пита слоевете: ловни райони (lr_hunting_08_2024) и горска карта (dleso_full_2022).
//
// Употреба:  node iag-lookup.mjs <lat> <lon>
//   напр.:   node iag-lookup.mjs 43.189 25.093
//
// Приема също "lat,lon" като един аргумент (както се копира от Google Maps).

const BASE = 'https://maps.iag.bg/geoserver/wms';

// Слоеве и кои полета да показваме. `key` е уникалното поле за дедупликация.
// Всяко поле: [атрибут, етикет, мерна единица?]; празен етикет = само стойността.
const LAYERS = [
    {
        name: 'IAG:lr_hunting_08_2024',
        title: 'Лов',
        key: null, // няма отделен ключ – дедуплицираме по всички показани полета
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

// WGS84 (lat/lon) -> Web Mercator (EPSG:3857) — CRS-а, който картата използва за заявки.
const toMercator = (lat, lon) => {
    const R = 20037508.34;
    const x = (lon * R) / 180;
    const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (R / 180);
    return [x, y];
};

const parseArgs = (argv) => {
    const raw = argv.slice(2).join(' ').replace(',', ' ').trim().split(/\s+/);
    const lat = Number(raw[0]);
    const lon = Number(raw[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
};

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

const fmtValue = (v, unit) => {
    let s = typeof v === 'number' ? Math.round(v * 100) / 100 : String(v).trim();
    if (!unit) return `${s}`;
    return unit === '°' ? `${s}${unit}` : `${s} ${unit}`; // градусите се пишат слято
};

// Форматира едно поле; връща null ако стойността е празна.
const fmtField = ([attr, label, unit], props) => {
    const v = props[attr];
    if (blank(v)) return null;
    const val = fmtValue(v, unit);
    return label ? `${label}: ${val}` : val;
};

const queryLayer = async (layer, x, y) => {
    const d = 3; // мъничка bbox (±3 м) около точката
    const bbox = `${x - d},${y - d},${x + d},${y + d}`;
    const props = layer.fields.map((f) => f[0]).concat(layer.key ? [layer.key] : []);
    const url =
        `${BASE}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
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

const main = async () => {
    const coords = parseArgs(process.argv);
    if (!coords) {
        console.error('Употреба: node iag-lookup.mjs <lat> <lon>   (напр. 43.189 25.093)');
        process.exit(1);
    }
    const [x, y] = toMercator(coords.lat, coords.lon);

    const results = await Promise.all(
        LAYERS.map(async (layer) => ({ layer, records: await queryLayer(layer, x, y) })),
    );

    let any = false;
    for (const { layer, records } of results) {
        for (const lines of records) {
            any = true;
            if (lines.length === 1) {
                console.log(`[${layer.title}] ${lines[0]}`);
            } else {
                console.log(`[${layer.title}]`);
                for (const line of lines) console.log(`  ${line}`);
            }
        }
    }
    if (!any) console.log('(няма данни за тази точка)');
};

main().catch((err) => {
    console.error('Неуспех:', err.message);
    process.exit(3);
});
