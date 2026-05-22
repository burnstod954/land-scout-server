/**
 * LandScout Pro v5
 * Confirmed working: NC statewide parcel FeatureServer
 * Fix: correct bbox format, no county field filter (bbox only), cache busting
 */
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Confirmed working NC statewide parcel endpoint
const NC_PARCELS = 'https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/ArcGIS/rest/services/parcels/FeatureServer/0/query';

// Bounding boxes in WGS84 — converted to Web Mercator for this service
// Service uses WKID 102719 (NC State Plane) but accepts inSR=4326
const COUNTIES = {
  mecklenburg: { name: 'Mecklenburg', xmin:-81.07, ymin:34.99, xmax:-80.54, ymax:35.52 },
  iredell:     { name: 'Iredell',     xmin:-80.97, ymin:35.46, xmax:-80.44, ymax:35.97 },
  cabarrus:    { name: 'Cabarrus',    xmin:-80.67, ymin:35.21, xmax:-80.20, ymax:35.60 },
  union:       { name: 'Union',       xmin:-80.89, ymin:34.81, xmax:-80.10, ymax:35.26 },
  gaston:      { name: 'Gaston',      xmin:-81.56, ymin:35.06, xmax:-80.90, ymax:35.50 },
  lincoln:     { name: 'Lincoln',     xmin:-81.55, ymin:35.37, xmax:-81.01, ymax:35.73 },
  rowan:       { name: 'Rowan',       xmin:-80.57, ymin:35.48, xmax:-80.01, ymax:35.88 },
  stanly:      { name: 'Stanly',      xmin:-80.50, ymin:35.11, xmax:-79.89, ymax:35.51 },
  cleveland:   { name: 'Cleveland',   xmin:-81.76, ymin:35.07, xmax:-81.36, ymax:35.58 },
};

const OUT_FIELDS = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,scity,gisacres,struct,parval,parusedesc';

// Simple in-memory cache
const cache = {};
const TTL   = 1000 * 60 * 60 * 4; // 4 hours

app.get('/health', (req, res) => {
  const cacheKeys = Object.keys(cache);
  res.json({ status: 'LandScout v5 OK', uptime: Math.round(process.uptime()), cachedQueries: cacheKeys.length });
});

// Cache clear endpoint — hit this if results are stale
app.get('/clear-cache', (req, res) => {
  const count = Object.keys(cache).length;
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ cleared: count });
});

app.get('/api/parcels', async (req, res) => {
  const { county, min_acres = '25', max_acres = '2000' } = req.query;
  if (!county) return res.status(400).json({ error: 'county param required' });

  const def = COUNTIES[county.toLowerCase()];
  if (!def) return res.status(400).json({ error: `Unknown county: ${county}. Valid: ${Object.keys(COUNTIES).join(', ')}` });

  const minA = parseFloat(min_acres);
  const maxA = parseFloat(max_acres);
  const cKey = `${county}-${minA}-${maxA}`;

  if (cache[cKey] && Date.now() - cache[cKey].ts < TTL && cache[cKey].parcels.length > 0) {
    console.log(`[cache hit] ${cKey} → ${cache[cKey].parcels.length} parcels`);
    return res.json({ county: def.name, parcels: cache[cKey].parcels, source: 'cache' });
  }

  console.log(`[fetch] ${def.name} ${minA}–${maxA} acres`);

  try {
    // Query by bounding box + acreage — confirmed working approach
    const geometry = JSON.stringify({
      xmin: def.xmin, ymin: def.ymin,
      xmax: def.xmax, ymax: def.ymax,
      spatialReference: { wkid: 4326 }
    });

    const params = new URLSearchParams({
      where:             `gisacres >= ${minA} AND gisacres <= ${maxA}`,
      geometry,
      geometryType:      'esriGeometryEnvelope',
      inSR:              '4326',
      spatialRel:        'esriSpatialRelIntersects',
      outFields:         OUT_FIELDS,
      returnGeometry:    'true',
      outSR:             '4326',
      resultRecordCount: '2000',
      orderByFields:     'gisacres DESC',
      f:                 'json'
    });

    const r = await fetch(`${NC_PARCELS}?${params}`, {
      headers: { 'User-Agent': 'LandScout/5.0' },
      timeout: 45000
    });

    if (!r.ok) throw new Error(`NC API returned HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    const features = data.features || [];
    console.log(`  → ${features.length} raw features returned`);

    const parcels = features.map(f => {
      const a = f.attributes || {};
      let lat = 0, lng = 0;
      const g = f.geometry;
      if (g) {
        if (g.x !== undefined) { lng = g.x; lat = g.y; }
        else if (g.rings?.[0]?.length) {
          const pts = g.rings[0];
          lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
          lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        }
      }
      return {
        pin:      (a.parno    || '').trim(),
        owner:    (a.ownname  || '').trim(),
        mailAddr: [a.mailadd, a.mcity, a.mstate, a.mzip].filter(Boolean).join(', '),
        siteAddr: (a.siteadd  || a.scity || '').trim(),
        acres:    parseFloat(a.gisacres || 0),
        struct:   a.struct === 'Y',
        assessed: parseFloat(a.parval   || 0),
        usedesc:  (a.parusedesc || '').trim(),
        zoning:   '', yearbuilt: null,
        lat, lng
      };
    }).filter(p => p.acres >= minA && p.acres <= maxA);

    console.log(`  → ${parcels.length} parcels after filtering`);

    // Only cache non-empty results
    if (parcels.length > 0) {
      cache[cKey] = { ts: Date.now(), parcels };
    }

    res.json({ county: def.name, parcels, source: 'live' });

  } catch (err) {
    console.error(`[error] ${def.name}:`, err.message);
    res.status(502).json({ error: err.message, county: def.name });
  }
});

app.listen(PORT, () => console.log(`LandScout v5 on port ${PORT}`));
