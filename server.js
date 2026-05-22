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

// Charlotte metro county bounding boxes in WGS84
const COUNTIES = {
  mecklenburg: { name:'Mecklenburg', ymin:34.99, ymax:35.52, xmin:-81.07, xmax:-80.54 },
  iredell:     { name:'Iredell',     ymin:35.46, ymax:35.97, xmin:-80.97, xmax:-80.44 },
  cabarrus:    { name:'Cabarrus',    ymin:35.21, ymax:35.60, xmin:-80.67, xmax:-80.20 },
  union:       { name:'Union',       ymin:34.81, ymax:35.26, xmin:-80.89, xmax:-80.10 },
  gaston:      { name:'Gaston',      ymin:35.06, ymax:35.50, xmin:-81.56, xmax:-80.90 },
  lincoln:     { name:'Lincoln',     ymin:35.37, ymax:35.73, xmin:-81.55, xmax:-81.01 },
  rowan:       { name:'Rowan',       ymin:35.48, ymax:35.88, xmin:-80.57, xmax:-80.01 },
  stanly:      { name:'Stanly',      ymin:35.11, ymax:35.51, xmin:-80.50, xmax:-79.89 },
  cleveland:   { name:'Cleveland',   ymin:35.07, ymax:35.58, xmin:-81.76, xmax:-81.36 }
};

// Cache: only store non-empty results
const cache = {};
const TTL   = 1000 * 60 * 60 * 4;

app.get('/health', function(req, res) {
  res.json({ status:'LandScout v6 OK', uptime:Math.round(process.uptime()), cached:Object.keys(cache).length });
});

app.get('/clear-cache', function(req, res) {
  var count = Object.keys(cache).length;
  Object.keys(cache).forEach(function(k) { delete cache[k]; });
  res.json({ cleared: count });
});

function inBox(lat, lng, box) {
  return lat >= box.ymin && lat <= box.ymax && lng >= box.xmin && lng <= box.xmax;
}

app.get('/api/parcels', function(req, res) {
  var county = (req.query.county || '').toLowerCase();
  var minA   = parseFloat(req.query.min_acres) || 25;
  var maxA   = parseFloat(req.query.max_acres) || 2000;
  var box    = COUNTIES[county];

  if (!box) return res.status(400).json({ error:'Unknown county: ' + county });

  var cKey = county + '-' + minA + '-' + maxA;
  if (cache[cKey] && (Date.now() - cache[cKey].ts < TTL) && cache[cKey].parcels.length > 0) {
    console.log('[cache] ' + cKey + ' -> ' + cache[cKey].parcels.length);
    return res.json({ county:box.name, parcels:cache[cKey].parcels, source:'cache' });
  }

  console.log('[fetch] ' + box.name + ' ' + minA + '-' + maxA + ' acres');

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
    headers: { 'User-Agent':'LandScout/6.0' },
    timeout: 45000
  })
  .then(function(r) {
    if (!r.ok) throw new Error('NC API HTTP ' + r.status);
    return r.json();
  })
  .then(function(data) {
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    var features = data.features || [];
    console.log('  -> ' + features.length + ' raw features from NC API');

    var parcels = [];
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
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

      if (!lat || !lng) continue;
      // Filter: only keep parcels inside this county's bounding box
      if (!inBox(lat, lng, box)) continue;

      var acres = parseFloat(a.gisacres || 0);
      if (acres < minA || acres > maxA) continue;

      parcels.push({
        pin:      (a.parno      || '').trim(),
        owner:    (a.ownname    || '').trim(),
        mailAddr: [a.mailadd, a.mcity, a.mstate, a.mzip].filter(Boolean).join(', '),
        siteAddr: (a.siteadd    || a.scity || '').trim(),
        acres:    acres,
        struct:   a.struct === 'Y',
        assessed: parseFloat(a.parval     || 0),
        usedesc:  (a.parusedesc || '').trim(),
        zoning:   '',
        yearbuilt: null,
        lat: lat,
        lng: lng
      });
    }

    console.log('  -> ' + parcels.length + ' parcels inside ' + box.name + ' bbox');
    if (parcels.length > 0) cache[cKey] = { ts:Date.now(), parcels:parcels };
    res.json({ county:box.name, parcels:parcels, source:'live', total_raw:features.length });
  })
  .catch(function(err) {
    console.error('[error] ' + box.name + ': ' + err.message);
    res.status(502).json({ error:err.message, county:box.name });
  });
});

app.listen(PORT, function() { console.log('LandScout v6 on port ' + PORT); });
