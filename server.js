const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Confirmed working - correct field names verified from screenshot
const MECK_URL    = 'https://gis.charlottenc.gov/arcgis/rest/services/PLN/VacantLand/MapServer/0/query';
const MECK_FIELDS = 'pid,ownerlastname,ownerfirstname,siteaddr,totalac,municipality,mailaddr1,mailaddr2,city,state,zipcode,totalvalue,descpropertyuse,landusecode,yearbuilt';

const NC_URL    = 'https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/ArcGIS/rest/services/parcels/FeatureServer/0/query';
const NC_FIELDS = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,scity,gisacres,struct,parval,parusedesc';

const COUNTY_BOXES = {
  iredell:   { ymin:35.46, ymax:35.97, xmin:-80.97, xmax:-80.44 },
  cabarrus:  { ymin:35.21, ymax:35.60, xmin:-80.67, xmax:-80.20 },
  union:     { ymin:34.81, ymax:35.26, xmin:-80.89, xmax:-80.10 },
  gaston:    { ymin:35.06, ymax:35.50, xmin:-81.56, xmax:-80.90 },
  lincoln:   { ymin:35.37, ymax:35.73, xmin:-81.55, xmax:-81.01 },
  rowan:     { ymin:35.48, ymax:35.88, xmin:-80.57, xmax:-80.01 },
  stanly:    { ymin:35.11, ymax:35.51, xmin:-80.50, xmax:-79.89 },
  cleveland: { ymin:35.07, ymax:35.58, xmin:-81.76, xmax:-81.36 }
};

const cache = {};
const TTL   = 1000 * 60 * 60 * 4;

app.get('/health', function(req, res) {
  res.json({ status:'LandScout v8 OK', uptime:Math.round(process.uptime()), cached:Object.keys(cache).length });
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

function fetchMecklenburg(minA, maxA) {
  var params = new URLSearchParams({
    where:             'totalac >= ' + minA + ' AND totalac <= ' + maxA,
    outFields:         MECK_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '2000',
    orderByFields:     'totalac DESC',
    f:                 'json'
  });

  return fetch(MECK_URL + '?' + params, {
    headers: { 'User-Agent': 'LandScout/8.0' },
    timeout: 45000
  })
  .then(function(r) {
    if (!r.ok) throw new Error('Mecklenburg API HTTP ' + r.status);
    return r.json();
  })
  .then(function(data) {
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    var features = data.features || [];
    console.log('  -> Mecklenburg: ' + features.length + ' raw features');

    return features.map(function(f) {
      var a = f.attributes || {};
      var pos = getLatLng(f);
      var last  = (a.ownerlastname  || '').trim();
      var first = (a.ownerfirstname || '').trim();
      var owner = last + (first ? ', ' + first : '');
      if (!owner.trim()) owner = 'Unknown';
      return {
        pin:      (a.pid       || '').trim(),
        owner:    owner,
        mailAddr: [a.mailaddr1, a.mailaddr2, a.city, a.state, a.zipcode].filter(Boolean).join(', '),
        siteAddr: (a.siteaddr  || '').trim(),
        acres:    parseFloat(a.totalac    || 0),
        struct:   false,
        assessed: parseFloat(a.totalvalue || 0),
        usedesc:  (a.descpropertyuse || a.landusecode || '').trim(),
        zoning:   '', yearbuilt: a.yearbuilt || null,
        lat: pos.lat, lng: pos.lng
      };
    }).filter(function(p) { return p.acres >= minA && p.acres <= maxA; });
  });
}

function fetchNcCounty(county, minA, maxA) {
  var box = COUNTY_BOXES[county];
  if (!box) throw new Error('No bbox for: ' + county);

  var params = new URLSearchParams({
    where:             'gisacres >= ' + minA + ' AND gisacres <= ' + maxA,
    outFields:         NC_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '2000',
    orderByFields:     'gisacres DESC',
    f:                 'json'
  });

  return fetch(NC_URL + '?' + params, {
    headers: { 'User-Agent': 'LandScout/8.0' },
    timeout: 45000
  })
  .then(function(r) {
    if (!r.ok) throw new Error('NC API HTTP ' + r.status);
    return r.json();
  })
  .then(function(data) {
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    var features = data.features || [];
    console.log('  -> ' + county + ': ' + features.length + ' raw, filtering by bbox');

    var parcels = [];
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var a = f.attributes || {};
      var pos = getLatLng(f);
      if (!pos.lat || !pos.lng) continue;
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
    return parcels;
  });
}

app.get('/api/parcels', function(req, res) {
  var county = (req.query.county || '').toLowerCase();
  var minA   = parseFloat(req.query.min_acres) || 25;
  var maxA   = parseFloat(req.query.max_acres) || 2000;
  var valid  = ['mecklenburg','iredell','cabarrus','union','gaston','lincoln','rowan','stanly','cleveland'];

  if (valid.indexOf(county) < 0) return res.status(400).json({ error: 'Unknown county: ' + county });

  var cKey = county + '-' + minA + '-' + maxA;
  if (cache[cKey] && (Date.now() - cache[cKey].ts < TTL) && cache[cKey].parcels.length > 0) {
    console.log('[cache] ' + cKey + ' -> ' + cache[cKey].parcels.length);
    return res.json({ county: county, parcels: cache[cKey].parcels, source: 'cache' });
  }

  console.log('[fetch] ' + county + ' ' + minA + '-' + maxA + ' acres');

  var promise = (county === 'mecklenburg')
    ? fetchMecklenburg(minA, maxA)
    : fetchNcCounty(county, minA, maxA);

  promise
    .then(function(parcels) {
      console.log('  -> ' + parcels.length + ' parcels for ' + county);
      if (parcels.length > 0) cache[cKey] = { ts: Date.now(), parcels: parcels };
      res.json({ county: county, parcels: parcels, source: 'live' });
    })
    .catch(function(err) {
      console.error('[error] ' + county + ': ' + err.message);
      res.status(502).json({ error: err.message, county: county });
    });
});

app.listen(PORT, function() { console.log('LandScout v8 on port ' + PORT); });
