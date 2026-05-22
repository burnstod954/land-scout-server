/**
 * LandScout Pro v3
 * Single reliable source: NC statewide parcel FeatureServer
 * Hosted by Esri on ArcGIS Online — public, no auth, no county blocking
 * All 100 NC counties in one standardized dataset
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

// NC statewide parcel layer — Esri ArcGIS Online hosted, public
const NC_PARCELS = 'https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/ArcGIS/rest/services/parcels/FeatureServer/0/query';

const COUNTY_NAMES = {
  mecklenburg: 'MECKLENBURG',
  iredell:     'IREDELL',
  cabarrus:    'CABARRUS',
  union:       'UNION',
  gaston:      'GASTON',
  lincoln:     'LINCOLN',
  rowan:       'ROWAN',
  stanly:      'STANLY',
  cleveland:   'CLEVELAND',
  york:        'YORK'   // SC — not in this NC dataset, handled separately
};

// Cache: countyKey+minAcres+maxAcres -> {ts, parcels}
const cache = {};
const TTL   = 1000 * 60 * 60 * 6; // 6 hours

app.get('/health', (req, res) => {
  res.json({ status: 'LandScout v3 OK', source: 'NC Statewide Parcel FeatureServer (Esri AGOL)', uptime: Math.round(process.uptime()) });
});

app.get('/api/parcels', async (req, res) => {
  const { county, min_acres = '25', max_acres = '2000' } = req.query;
  if (!county) return res.status(400).json({ error: 'county param required' });

  const countyUpper = COUNTY_NAMES[county.toLowerCase()];
  if (!countyUpper) return res.status(400).json({ error: `Unknown county key: ${county}` });

  const minA = parseFloat(min_acres);
  const maxA = parseFloat(max_acres);
  const cKey = `${county}-${minA}-${maxA}`;

  if (cache[cKey] && Date.now() - cache[cKey].ts < TTL) {
    console.log(`[cache] ${cKey} → ${cache[cKey].parcels.length} parcels`);
    return res.json({ county, parcels: cache[cKey].parcels, source: 'cache' });
  }

  try {
    console.log(`[fetch] ${county} ${minA}–${maxA} acres`);

    const where = `UPPER(county_nam)='${countyUpper}' AND gisacres>=${minA} AND gisacres<=${maxA}`;
    const fields = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,gisacres,struct,parval,parusedesc,improvval,saledate,scity';

    const params = new URLSearchParams({
      where,
      outFields:         fields,
      returnGeometry:    'true',
      outSR:             '4326',
      resultRecordCount: '2000',
      orderByFields:     'gisacres DESC',
      f:                 'json'
    });

    const r = await fetch(`${NC_PARCELS}?${params}`, {
      headers: { 'User-Agent': 'LandScout/3.0' },
      timeout: 45000
    });

    if (!r.ok) throw new Error(`NC Parcel API returned HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(`API error: ${JSON.stringify(data.error)}`);

    const parcels = (data.features || []).map(f => {
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
        pin:      (a.parno  || '').trim(),
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
    });

    cache[cKey] = { ts: Date.now(), parcels };
    console.log(`[done] ${county}: ${parcels.length} parcels`);
    res.json({ county, parcels, source: 'live' });

  } catch (err) {
    console.error(`[error] ${county}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/counties', (req, res) => {
  res.json(Object.keys(COUNTY_NAMES).map(k => ({ key: k, name: k.charAt(0).toUpperCase() + k.slice(1) })));
});

app.listen(PORT, () => console.log(`LandScout v3 on port ${PORT}`));
