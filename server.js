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
const OUT_FIELDS = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,scity,gisacres,struct,parval,parusedesc';

// County name as it appears in the scity/mcity fields returned by NC API
const COUNTY_KEYS = {
  mecklenburg:'mecklenburg', iredell:'iredell', cabarrus:'cabarrus',
  union:'union', gaston:'gaston', lincoln:'lincoln',
  rowan:'rowan', stanly:'stanly', cleveland:'cleveland'
};

const cache = {};
const TTL   = 1000 * 60 * 60 * 4;

app.get('/health', function(req, res) {
  res.json({ status:'LandScout v5 OK', uptime:Math.round(process.uptime()), cached:Object.keys(cache).length });
});

app.get('/clear-cache', function(req, res) {
  var count = Object.keys(cache).length;
  Object.keys(cache).forEach(function(k) { delete cache[k]; });
  res.json({ cleared: count });
});

// Debug endpoint — shows raw data so we can see coordinates
app.get('/api/debug', function(req, res) {
  var minA = parseFloat(req.query.min_acres) || 25;
  var params = new URLSearchParams({
    where:             'gisacres >= ' + minA + ' AND gisacres <= 100',
    outFields:         OUT_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '5',
    f:                 'json'
  });
  fetch(NC_PARCELS + '?' + params, { headers:{'User-Agent':'LandScout/5.0'}, timeout:30000 })
    .then(function(r){ return r.json(); })
    .then(function(data){ res.json(data); })
    .catch(function(e){ res.status(500).json({error:e.message}); });
});

app.get('/api/parcels', function(req, res) {
  var county = (req.query.county || '').toLowerCase();
  var minA   = parseFloat(req.query.min_acres) || 25;
  var maxA   = parseFloat(req.query.max_acres) || 2000;

  if (!COUNTY_KEYS[county]) {
    return res.status(400).json({ error:'Unknown county: ' + county });
  }

  var cKey = county + '-' + minA + '-' + maxA;
  if (cache[cKey] && (Date.now() - cache[cKey].ts < TTL) && cache[cKey].parcels.length > 0) {
    console.log('[cache] ' + cKey + ' -> ' + cache[cKey].parcels.length);
    return res.json({ county:county, parcels:cache[cKey].parcels, source:'cache' });
  }

  console.log('[fetch] ' + county + ' ' + minA + '-' + maxA + ' acres');

  // No geometry filter — just acreage. Return ALL results, let frontend filter.
  var params = new URLSearchParams({
    where:             'gisacres >= ' + minA + ' AND gisacres <= ' + maxA,
    outFields:         OUT_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '2000',
    orderByFields:     'gisacres DESC',
    f:                 'json'
  });

  fetch(NC_PARCELS + '?' + params, {
    headers: { 'User-Agent':'LandScout/5.0' },
    timeout: 45000
  })
  .then(function(r) {
    if (!r.ok) throw new Error('NC API HTTP ' + r.status);
    return r.json();
  })
  .then(function(data) {
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    var features = data.features || [];
    console.log('  -> ' + features.length + ' raw features, exceeded=' + data.exceededTransferLimit);

    // Log first feature geometry so we can see what coordinates look like
    if (features.length > 0) {
      console.log('  -> sample geometry:', JSON.stringify(features[0].geometry).slice(0,200));
      console.log('  -> sample attrs:', JSON.stringify(features[0].attributes));
    }

    var parcels = features.map(function(f) {
      var a = f.attributes || {};
      var lat = 0, lng = 0;
      var g = f.geometry;
      if (g) {
        if (typeof g.x !== 'undefined' && g.x !== null) {
          lng = g.x; lat = g.y;
        } else if (g.rings && g.rings[0] && g.rings[0].length) {
          var pts = g.rings[0];
          var sl = 0, sa = 0;
          for (var j = 0; j < pts.length; j++) { sl += pts[j][0]; sa += pts[j][1]; }
          lng = sl / pts.length;
          lat = sa / pts.length;
        }
      }
      return {
        pin:      (a.parno      || '').trim(),
        owner:    (a.ownname    || '').trim(),
        mailAddr: [a.mailadd, a.mcity, a.mstate, a.mzip].filter(Boolean).join(', '),
        siteAddr: (a.siteadd    || a.scity || '').trim(),
        acres:    parseFloat(a.gisacres   || 0),
        struct:   a.struct === 'Y',
        assessed: parseFloat(a.parval     || 0),
        usedesc:  (a.parusedesc || '').trim(),
        zoning:'', yearbuilt:null,
        lat: lat, lng: lng
      };
    });

    console.log('  -> returning ' + parcels.length + ' parcels (NO bbox filter)');
    if (parcels.length > 0) cache[cKey] = { ts:Date.now(), parcels:parcels };
    res.json({ county:county, parcels:parcels, source:'live', total_raw:features.length });
  })
  .catch(function(err) {
    console.error('[error] ' + county + ': ' + err.message);
    res.status(502).json({ error:err.message, county:county });
  });
});

app.listen(PORT, function() { console.log('LandScout v5 on port ' + PORT); });
