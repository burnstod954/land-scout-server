/**
 * LandScout Pro v4
 * NC Statewide Parcel FeatureServer (Esri AGOL) — public, no auth
 * Fixed: county field is "cntyname" not "county_nam"
 * Fallback: bbox query if county name filter fails
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

const NC_PARCELS = 'https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/ArcGIS/rest/services/parcels/FeatureServer/0/query';

// County definitions: name variants + bounding box (WGS84) as fallback
const COUNTIES = {
  mecklenburg: { names: ['MECKLENBURG'],          bbox: '-81.07,34.99,-80.54,35.52' },
  iredell:     { names: ['IREDELL'],               bbox: '-80.97,35.46,-80.44,35.97' },
  cabarrus:    { names: ['CABARRUS'],              bbox: '-80.67,35.21,-80.20,35.60' },
  union:       { names: ['UNION'],                 bbox: '-80.89,34.81,-80.10,35.26' },
  gaston:      { names: ['GASTON'],                bbox: '-81.56,35.06,-80.90,35.50' },
  lincoln:     { names: ['LINCOLN'],               bbox: '-81.55,35.37,-81.01,35.73' },
  rowan:       { names: ['ROWAN'],                 bbox: '-80.57,35.48,-80.01,35.88' },
  stanly:      { names: ['STANLY'],                bbox: '-80.50,35.11,-79.89,35.51' },
  cleveland:   { names: ['CLEVELAND'],             bbox: '-81.76,35.07,-81.36,35.58' },
};

const OUT_FIELDS = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,scity,gisacres,struct,parval,parusedesc,improvval';

const cache = {};
const TTL   = 1000 * 60 * 60 * 6;

async function queryParcels(where, bbox) {
  const params = new URLSearchParams({
    where,
    outFields:         OUT_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '2000',
    orderByFields:     'gisacres DESC',
    f:                 'json'
  });

  // Add bbox geometry filter as additional spatial filter
  if (bbox) {
    const [xmin, ymin, xmax, ymax] = bbox.split(',');
    params.set('geometry', JSON.stringify({ xmin: +xmin, ymin: +ymin, xmax: +xmax, ymax: +ymax, spatialReference: { wkid: 4326 } }));
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }

  const r = await fetch(`${NC_PARCELS}?${params}`, {
    headers: { 'User-Agent': 'LandScout/4.0' },
    timeout: 45000
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.features || [];
}

function parseFeature(f) {
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
    pin:      (a.parno   || '').trim(),
    owner:    (a.ownname || '').trim(),
    mailAddr: [a.mailadd, a.mcity, a.mstate, a.mzip].filter(Boolean).join(', '),
    siteAddr: (a.siteadd || a.scity || '').trim(),
    acres:    parseFloat(a.gisacres || 0),
    struct:   a.struct === 'Y',
    assessed: parseFloat(a.parval || 0),
    usedesc:  (a.parusedesc || '').trim(),
    zoning:   '',
    yearbuilt: null,
    lat, lng
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'LandScout v4 OK', uptime: Math.round(process.uptime()) });
});

app.get('/api/parcels', async (req, res) => {
  const { county, min_acres = '25', max_acres = '2000' } = req.query;
  if (!county) return res.status(400).json({ error: 'county param required' });

  const def = COUNTIES[county.toLowerCase()];
  if (!def) return res.status(400).json({ error: `Unknown county: ${county}` });

  const minA = parseFloat(min_acres);
  const maxA = parseFloat(max_acres);
  const cKey = `${county}-${minA}-${maxA}`;

  if (cache[cKey] && Date.now() - cache[cKey].ts < TTL) {
    return res.json({ county, parcels: cache[cKey].parcels, source: 'cache' });
  }

  console.log(`[fetch] ${county} ${minA}–${maxA} acres`);

  // Strategy 1: try "cntyname" field (NC cadastral standard)
  // Strategy 2: try "county_nam" 
  // Strategy 3: bbox-only query (most reliable, slightly broader)
  const acreWhere  = `gisacres >= ${minA} AND gisacres <= ${maxA}`;
  const strategies = [
    { label: 'cntyname',    where: `cntyname = '${def.names[0]}' AND ${acreWhere}`,          bbox: def.bbox },
    { label: 'county_name', where: `county_name = '${def.names[0]}' AND ${acreWhere}`,       bbox: def.bbox },
    { label: 'co_name',     where: `co_name = '${def.names[0]}' AND ${acreWhere}`,           bbox: def.bbox },
    { label: 'bbox-only',   where: acreWhere,                                                 bbox: def.bbox },
  ];

  let features = [], usedStrategy = '';
  for (const s of strategies) {
    try {
      console.log(`  trying strategy: ${s.label}`);
      features = await queryParcels(s.where, s.bbox);
      usedStrategy = s.label;
      console.log(`  success with ${s.label}: ${features.length} features`);
      break;
    } catch (e) {
      console.warn(`  ${s.label} failed:`, e.message);
    }
  }

  if (!features.length && usedStrategy === '') {
    return res.status(502).json({ error: `All query strategies failed for ${county}` });
  }

  const parcels = features.map(parseFeature).filter(p => p.acres >= minA && p.acres <= maxA);
  cache[cKey] = { ts: Date.now(), parcels };
  console.log(`[done] ${county}: ${parcels.length} parcels (strategy: ${usedStrategy})`);
  res.json({ county, parcels, source: 'live', strategy: usedStrategy });
});

app.listen(PORT, () => console.log(`LandScout v4 on port ${PORT}`));
