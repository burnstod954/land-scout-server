const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// NC statewide parcel service - confirmed working
const NC_URL    = 'https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/ArcGIS/rest/services/parcels/FeatureServer/0/query';
const NC_FIELDS = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,scity,gisacres,struct,parval,parusedesc';

// Charlotte metro county bounding boxes WGS84
const COUNTY_BOXES = {
  iredell:     { name:'Iredell',   ymin:35.46, ymax:35.97, xmin:-80.97, xmax:-80.44 },
  cabarrus:    { name:'Cabarrus',  ymin:35.21, ymax:35.60, xmin:-80.67, xmax:-80.20 },
  union:       { name:'Union',     ymin:34.81, ymax:35.26, xmin:-80.89, xmax:-80.10 },
  gaston:      { name:'Gaston',    ymin:35.06, ymax:35.50, xmin:-81.56, xmax:-80.90 },
  lincoln:     { name:'Lincoln',   ymin:35.37, ymax:35.73, xmin:-81.55, xmax:-81.01 },
  rowan:       { name:'Rowan',     ymin:35.48, ymax:35.88, xmin:-80.57, xmax:-80.01 },
  stanly:      { name:'Stanly',    ymin:35.11, ymax:35.51, xmin:-80.50, xmax:-79.89 },
  cleveland:   { name:'Cleveland', ymin:35.07, ymax:35.58, xmin:-81.76, xmax:-81.36 }
};

const cache = {};
const TTL   = 1000 * 60 * 60 * 4;

app.get('/health', function(req, res) {
  res.json({ status:'LandScout v9 OK', uptime:Math.round(process.uptime()), cached:Object.keys(cache).length });
});

app.get('/clear-cache', function(req, res) {
  var count = Object.keys(cache).length;
  Object.keys(cache).forEach(function(k) { delete cache[k]; });
  res.json({ cleared: count });
});

function getLatLng(f) {
  var lat = 0, lng = 0;
  var g = f.geometry;
  if (g) {
    if (typeof g.x !== 'undefined' && g.x !== null) { lng = g.x; lat = g.y; }
    else if (g.rings && g.rings[0] && g.rings[0].length) {
      var pts = g.rings[0], sl = 0, sa = 0;
      for (var j = 0; j < pts.length; j++) { sl += pts[j][0]; sa += pts[j][1]; }
      lng = sl / pts.length; lat = sa / pts.length;
    }
  }
  return { lat: lat, lng: lng };
}

app.get('/api/parcels', function(req, res) {
  var county = (req.query.county || '').toLowerCase();
  var minA   = parseFloat(req.query.min_acres) || 25;
  var maxA   = parseFloat(req.query.max_acres) || 2000;
  var box    = COUNTY_BOXES[county];

  if (!box) return res.status(400).json({ error: 'Unknown county: ' + county });

  var cKey = county + '-' + minA + '-' + maxA;
  if (cache[cKey] && (Date.now() - cache[cKey].ts < TTL) && cache[cKey].parcels.length > 0) {
    console.log('[cache] ' + cKey + ' -> ' + cache[cKey].parcels.length);
    return res.json({ county: box.name, parcels: cache[cKey].parcels, source: 'cache' });
  }

  console.log('[fetch] ' + box.name + ' ' + minA + '-' + maxA + ' acres');

  var params = new URLSearchParams({
    where:             'gisacres >= ' + minA + ' AND gisacres <= ' + maxA,
    outFields:         NC_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '2000',
    orderByFields:     'gisacres DESC',
    f:                 'json'
  });

  fetch(NC_URL + '?' + params, {
    headers: { 'User-Agent': 'LandScout/9.0' },
    timeout: 45000
  })
  .then(function(r) {
    if (!r.ok) throw new Error('NC API HTTP ' + r.status);
    return r.json();
  })
  .then(function(data) {
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    var features = data.features || [];
    console.log('  -> ' + features.length + ' raw features, filtering to ' + box.name + ' bbox');

    var parcels = [];
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var a = f.attributes || {};
      var pos = getLatLng(f);

      // Skip if no coordinates
      if (!pos.lat || !pos.lng) continue;

      // Keep only parcels inside this county's bounding box
      if (pos.lat < box.ymin || pos.lat > box.ymax || pos.lng < box.xmin || pos.lng > box.xmax) continue;

      var acres = parseFloat(a.gisacres || 0);
      if (acres < minA || acres > maxA) continue;

      parcels.push({
        pin:      (a.parno    || '').trim(),
        owner:    (a.ownname  || '').trim(),
        mailAddr: [a.mailadd, a.mcity, a.mstate, a.mzip].filter(Boolean).join(', '),
        siteAddr: (a.siteadd  || a.scity || '').trim(),
        acres:    acres,
        struct:   a.struct === 'Y',
        assessed: parseFloat(a.parval || 0),
        usedesc:  (a.parusedesc || '').trim(),
        zoning:   '', yearbuilt: null,
        lat: pos.lat, lng: pos.lng
      });
    }

    console.log('  -> ' + parcels.length + ' parcels in ' + box.name);
    if (parcels.length > 0) cache[cKey] = { ts: Date.now(), parcels: parcels };
    res.json({ county: box.name, parcels: parcels, source: 'live', total_raw: features.length });
  })
  .catch(function(err) {
    console.error('[error] ' + box.name + ': ' + err.message);
    res.status(502).json({ error: err.message, county: box.name });
  });
});

app.listen(PORT, function() { console.log('LandScout v9 on port ' + PORT); });
