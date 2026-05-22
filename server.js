/**
 * LandScout Pro v2 — Self-contained parcel server
 * Pulls directly from county open data + NC state sources
 * No paid API required. Free forever.
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory cache ────────────────────────────────────────────────────────
const cache = {};   // { countyKey: { ts, parcels[] } }
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

// ── County source definitions ──────────────────────────────────────────────
// Each entry defines HOW to pull data for that county.
// Strategy: try ArcGIS FeatureServer with pagination first;
//           fall back to NC OneMap state service.
const COUNTIES = {
  mecklenburg: {
    name: 'Mecklenburg',
    // Mecklenburg publishes via Charlotte ArcGIS — tax parcel ownership
    sources: [
      {
        type: 'arcgis',
        url: 'https://gis.charlottenc.gov/arcgis/rest/services/CountyData/Parcels/MapServer/0/query',
        acreField: 'ACRES',
        pinField:  'PIN',
        ownerField:'OWNER',
        addrField: 'SITEADDR',
        mailFields:['OWNADDR','OWNCITY','OWNSTATE','OWNZIP'],
        useField:  'LANDUSEDESC',
        zoneField: 'ZONING',
        structField:null,
        ybField:   null,
        valField:  'TOTALVAL',
        townField: 'TOWNSHIP',
        latField:  null,
        lngField:  null,
      }
    ],
    bbox: { xmin:-81.07, ymin:34.99, xmax:-80.54, ymax:35.52 }
  },
  iredell: {
    name: 'Iredell',
    sources: [
      {
        type: 'arcgis',
        url: 'https://icgis.co.iredell.nc.us/arcgis/rest/services/Data/TaxSQL_Parcels/FeatureServer/0/query',
        acreField: 'ACRES',
        pinField:  'PARCEL_ID',
        ownerField:'OWNER',
        addrField: 'SITE_ADDRESS',
        mailFields:['MAIL_ADDRESS','MAIL_CITY','MAIL_STATE','MAIL_ZIP'],
        useField:  'LAND_USE',
        zoneField: 'ZONING',
        structField:null, ybField:null, valField:'TOTAL_VALUE', townField:'TOWNSHIP',
        latField:null, lngField:null,
      }
    ],
    bbox: { xmin:-80.97, ymin:35.46, xmax:-80.44, ymax:35.97 }
  },
  cabarrus: {
    name: 'Cabarrus',
    sources: [
      {
        type: 'arcgis',
        url: 'https://gis.cabarruscounty.us/arcgis/rest/services/Parcels/MapServer/0/query',
        acreField: 'GISACRES',
        pinField:  'PARCELID',
        ownerField:'OWNER1',
        addrField: 'SITEADDRESS',
        mailFields:['MAILADDRESS','MAILCITY','MAILSTATE','MAILZIP'],
        useField:  'LANDUSE',
        zoneField: 'ZONE_',
        structField:null, ybField:null, valField:null, townField:null,
        latField:null, lngField:null,
      }
    ],
    bbox: { xmin:-80.67, ymin:35.21, xmax:-80.20, ymax:35.60 }
  },
  union: {
    name: 'Union',
    sources: [
      {
        type: 'arcgis',
        url: 'https://gis.unioncountync.gov/arcgis/rest/services/Public/Parcels/MapServer/0/query',
        acreField: 'GISACRES',
        pinField:  'PARCELID',
        ownerField:'OWNER',
        addrField: 'SITEADDRESS',
        mailFields:['MAILADDR','MAILCITY','MAILSTATE','MAILZIP'],
        useField:  'LANDUSEDESC',
        zoneField: 'ZONING',
        structField:null, ybField:null, valField:null, townField:null,
        latField:null, lngField:null,
      }
    ],
    bbox: { xmin:-80.89, ymin:34.81, xmax:-80.10, ymax:35.26 }
  },
  gaston: {
    name: 'Gaston',
    sources: [
      {
        type: 'arcgis',
        url: 'https://gis.gastongov.com/arcgis/rest/services/Public/Parcels/MapServer/0/query',
        acreField: 'ACRES',
        pinField:  'PARCELNUMBER',
        ownerField:'OWNER',
        addrField: 'PHYSADDR',
        mailFields:['MAILADDR','MAILCITY','MAILSTATE','MAILZIP'],
        useField:  'LANDUSE',
        zoneField: 'ZONING',
        structField:null, ybField:null, valField:null, townField:null,
        latField:null, lngField:null,
      }
    ],
    bbox: { xmin:-81.56, ymin:35.06, xmax:-80.90, ymax:35.50 }
  },
  lincoln: {
    name: 'Lincoln',
    sources: [{ type:'nconemap', geoid:'37109' }],
    bbox: { xmin:-81.55, ymin:35.37, xmax:-81.01, ymax:35.73 }
  },
  rowan: {
    name: 'Rowan',
    sources: [{ type:'nconemap', geoid:'37159' }],
    bbox: { xmin:-80.57, ymin:35.48, xmax:-80.01, ymax:35.88 }
  },
  stanly: {
    name: 'Stanly',
    sources: [{ type:'nconemap', geoid:'37167' }],
    bbox: { xmin:-80.50, ymin:35.11, xmax:-79.89, ymax:35.51 }
  },
  cleveland: {
    name: 'Cleveland',
    sources: [{ type:'nconemap', geoid:'37045' }],
    bbox: { xmin:-81.76, ymin:35.07, xmax:-81.36, ymax:35.58 }
  },
  york: {
    name: 'York SC',
    sources: [
      {
        type: 'arcgis',
        url: 'https://gis.yorkcountygov.com/arcgis/rest/services/Parcels/MapServer/0/query',
        acreField: 'ACRES',
        pinField:  'PIN',
        ownerField:'OWNER',
        addrField: 'SITEADDRESS',
        mailFields:['MAILADDR','MAILCITY','MAILSTATE','MAILZIP'],
        useField:  'LANDUSE',
        zoneField: 'ZONING',
        structField:null, ybField:null, valField:null, townField:null,
        latField:null, lngField:null,
      }
    ],
    bbox: { xmin:-81.41, ymin:34.78, xmax:-80.78, ymax:35.14 }
  }
};

// ── NC OneMap fallback (state-run, open) ───────────────────────────────────
const NCONEMAP_URL = 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query';

async function fetchNcOneMap(geoid, minAcres, maxAcres, bbox) {
  const geometry = JSON.stringify({
    xmin: bbox.xmin, ymin: bbox.ymin,
    xmax: bbox.xmax, ymax: bbox.ymax,
    spatialReference: { wkid: 4326 }
  });
  const params = new URLSearchParams({
    where:          `GISACRES >= ${minAcres} AND GISACRES <= ${maxAcres}`,
    geometry, geometryType: 'esriGeometryEnvelope',
    inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields:      'PARNO,OWNNAME,OWNADDR,OWNCITY,OWNSTATE,OWNZIP,SITEADD,GISACRES,TOWNSHIP,LANDUSEDESC,REID',
    returnGeometry: 'true', outSR: '4326',
    resultRecordCount: '1000', f: 'json'
  });
  const r = await fetch(`${NCONEMAP_URL}?${params}`, {
    headers: { 'User-Agent': 'LandScout/2.0' }, timeout: 30000
  });
  if (!r.ok) throw new Error(`NC OneMap HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(`NC OneMap: ${d.error.message}`);
  return (d.features || []).map(f => {
    const a = f.attributes;
    let lat = 0, lng = 0;
    const g = f.geometry;
    if (g?.type === 'Point') { lat = g.coordinates[1]; lng = g.coordinates[0]; }
    else if (g?.x) { lng = g.x; lat = g.y; }
    return {
      pin: a.PARNO || a.REID || '',
      owner: (a.OWNNAME || '').trim(),
      siteAddr: (a.SITEADD || '').trim(),
      mailAddr: [a.OWNADDR, a.OWNCITY, a.OWNSTATE, a.OWNZIP].filter(Boolean).join(', '),
      acres: parseFloat(a.GISACRES || 0),
      usedesc: a.LANDUSEDESC || '',
      zoning: '', struct: false, yearbuilt: null, assessed: 0,
      township: a.TOWNSHIP || '', lat, lng
    };
  });
}

// ── ArcGIS FeatureServer paginated fetch ───────────────────────────────────
async function fetchArcGIS(src, minAcres, maxAcres, bbox, countyName) {
  const geometry = JSON.stringify({
    xmin: bbox.xmin, ymin: bbox.ymin,
    xmax: bbox.xmax, ymax: bbox.ymax,
    spatialReference: { wkid: 4326 }
  });
  const where = `${src.acreField} >= ${minAcres} AND ${src.acreField} <= ${maxAcres}`;
  const params = new URLSearchParams({
    where, geometry, geometryType: 'esriGeometryEnvelope',
    inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: '*', returnGeometry: 'true', outSR: '4326',
    resultRecordCount: '1000', f: 'json'
  });
  const r = await fetch(`${src.url}?${params}`, {
    headers: { 'User-Agent': 'LandScout/2.0' }, timeout: 30000
  });
  if (!r.ok) throw new Error(`${countyName} ArcGIS HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(`${countyName}: ${d.error.message}`);

  return (d.features || []).map(f => {
    const a = f.attributes || {};
    let lat = 0, lng = 0;
    const g = f.geometry;
    if (g) {
      if (g.x !== undefined) { lng = g.x; lat = g.y; }
      else if (g.rings?.[0]?.length) {
        const pts = g.rings[0];
        lng = pts.reduce((s,p)=>s+p[0],0)/pts.length;
        lat = pts.reduce((s,p)=>s+p[1],0)/pts.length;
      }
    }
    // If geometry is in Web Mercator (~EPSG:3857), convert to WGS84
    if (Math.abs(lng) > 180) { lng = lng / 20037508.34 * 180; lat = Math.atan(Math.exp(lat/20037508.34*Math.PI))*360/Math.PI-90; }

    const getF = (field) => field ? (a[field] || '') : '';
    const mailParts = (src.mailFields || []).map(f => a[f] || '').filter(Boolean);

    return {
      pin:       (getF(src.pinField) || '').toString().trim(),
      owner:     (getF(src.ownerField) || '').trim(),
      siteAddr:  (getF(src.addrField) || '').trim(),
      mailAddr:  mailParts.join(', '),
      acres:     parseFloat(a[src.acreField] || 0),
      usedesc:   (getF(src.useField) || '').trim(),
      zoning:    (getF(src.zoneField) || '').trim(),
      struct:    src.structField ? !!a[src.structField] : false,
      yearbuilt: src.ybField ? (a[src.ybField] || null) : null,
      assessed:  src.valField ? (parseFloat(a[src.valField]) || 0) : 0,
      township:  (getF(src.townField) || '').trim(),
      lat, lng
    };
  });
}

// ── Load county data ───────────────────────────────────────────────────────
async function loadCounty(key, minAcres, maxAcres) {
  const def = COUNTIES[key];
  if (!def) throw new Error(`Unknown county: ${key}`);

  const errors = [];
  for (const src of def.sources) {
    try {
      if (src.type === 'nconemap') {
        return await fetchNcOneMap(src.geoid, minAcres, maxAcres, def.bbox);
      } else if (src.type === 'arcgis') {
        return await fetchArcGIS(src, minAcres, maxAcres, def.bbox, def.name);
      }
    } catch (e) {
      errors.push(e.message);
      console.warn(`[${def.name}] source failed, trying next:`, e.message);
    }
  }
  // All county sources failed — fall back to NC OneMap if we have a geoid
  const ncSrc = def.sources.find(s => s.geoid);
  if (!ncSrc) {
    // Try NC OneMap with county name as last resort
    const geoidMap = {
      mecklenburg:'37119', iredell:'37097', cabarrus:'37025',
      union:'37179', gaston:'37071', lincoln:'37109',
      rowan:'37159', stanly:'37167', cleveland:'37045', york:'45091'
    };
    const geoid = geoidMap[key];
    if (geoid) {
      try { return await fetchNcOneMap(geoid, minAcres, maxAcres, def.bbox); }
      catch(e) { errors.push(`NC OneMap fallback: ${e.message}`); }
    }
  }
  throw new Error(`All sources failed for ${def.name}: ${errors.join(' | ')}`);
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'LandScout Pro v2 running', counties: Object.keys(COUNTIES), uptime: process.uptime() });
});

app.get('/api/parcels', async (req, res) => {
  const { county, min_acres = 25, max_acres = 2000 } = req.query;
  if (!county) return res.status(400).json({ error: 'Missing county param' });
  if (!COUNTIES[county]) return res.status(400).json({ error: `Unknown county: ${county}. Valid: ${Object.keys(COUNTIES).join(', ')}` });

  const cacheKey = `${county}-${min_acres}-${max_acres}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`[cache hit] ${cacheKey} — ${cached.parcels.length} parcels`);
    return res.json({ county: COUNTIES[county].name, source: 'cache', parcels: cached.parcels });
  }

  try {
    console.log(`[fetch] ${county} ${min_acres}-${max_acres} acres`);
    const parcels = await loadCounty(county, parseFloat(min_acres), parseFloat(max_acres));
    cache[cacheKey] = { ts: Date.now(), parcels };
    console.log(`[done] ${county}: ${parcels.length} parcels`);
    res.json({ county: COUNTIES[county].name, source: 'live', parcels });
  } catch (err) {
    console.error(`[error] ${county}:`, err.message);
    res.status(502).json({ error: err.message, county });
  }
});

app.get('/api/counties', (req, res) => {
  res.json(Object.entries(COUNTIES).map(([k,v]) => ({ key: k, name: v.name })));
});

app.listen(PORT, () => console.log(`LandScout Pro v2 running on port ${PORT}`));
