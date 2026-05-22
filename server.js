const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// NC statewide parcel service - confirmed working (no bbox, acreage where-clause only)
const NC_PARCELS = 'https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/ArcGIS/rest/services/parcels/FeatureServer/0/query';
const OUT_FIELDS = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,scity,gisacres,struct,parval,parusedesc';

// NC State Plane bounding boxes (WKID 102719 / FIPS 3200, feet)
// Converted from WGS84 using Lambert Conformal Conic projection for NC
const COUNTIES = {
  mecklenburg: { name:'Mecklenburg', xmin:1290000, ymin:450000, xmax:1480000, ymax:620000 },
  iredell:     { name:'Iredell',     xmin:1310000, ymin:600000, xmax:1500000, ymax:780000 },
  cabarrus:    { name:'Cabarrus',    xmin:1450000, ymin:490000, xmax:1620000, ymax:640000 },
  union:       { name:'Union',       xmin:1380000, ymin:330000, xmax:1640000, ymax:540000 },
  gaston:      { name:'Gaston',      xmin:1130000, ymin:400000, xmax:1320000, ymax:590000 },
  lincoln:     { name:'Lincoln',     xmin:1100000, ymin:540000, xmax:1290000, ymax:700000 },
  rowan:       { name:'Rowan',       xmin:1470000, ymin:590000, xmax:1680000, ymax:740000 },
  stanly:      { name:'Stanly',      xmin:1540000, ymin:420000, xmax:1750000, ymax:580000 },
  cleveland:   { name:'Cleveland',   xmin:1000000, ymin:390000, xmax:1200000, ymax:580000 }
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

// Fetch one page of results using objectId offset pagination
function fetchPage(where, bbox, offset) {
  var params = new URLSearchParams({
    where:             where,
    geometry:          JSON.stringify({ xmin:bbox.xmin, ymin:bbox.ymin, xmax:bbox.xmax, ymax:bbox.ymax, spatialReference:{ wkid:102719 } }),
    geometryType:      'esriGeometryEnvelope',
    spatialRel:        'esriSpatialRelIntersects',
    outFields:         OUT_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '2000',
    resultOffset:      String(offset),
    orderByFields:     'OBJECTID ASC',
    f:                 'json'
  });

  return fetch(NC_PARCELS + '?' + params, {
    headers: { 'User-Agent':'LandScout/5.0' },
    timeout: 45000
  }).then(function(r) {
    if (!r.ok) throw new Error('NC API HTTP ' + r.status);
    return r.json();
  }).then(function(data) {
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data;
  });
}

function parseFeature(f) {
  var a = f.attributes || {};
  var lat = 0, lng = 0;
  var g = f.geometry;
  if (g) {
    if (typeof g.x !== 'undefined') { lng = g.x; lat = g.y; }
    else if (g.rings && g.rings[0] && g.rings[0].length) {
      var pts = g.rings[0];
      lng = pts.reduce(function(s,p){ return s+p[0]; }, 0) / pts.length;
      lat = pts.reduce(function(s,p){ return s+p[1]; }, 0) / pts.length;
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
    zoning:'', yearbuilt:null, lat:lat, lng:lng
  };
}

app.get('/api/parcels', function(req, res) {
  var county = (req.query.county || '').toLowerCase();
  var minA   = parseFloat(req.query.min_acres) || 25;
  var maxA   = parseFloat(req.query.max_acres) || 2000;
  var def    = COUNTIES[county];

  if (!def) return res.status(400).json({ error:'Unknown county: ' + county + '. Valid: ' + Object.keys(COUNTIES).join(', ') });

  var cKey = county + '-' + minA + '-' + maxA;
  if (cache[cKey] && (Date.now() - cache[cKey].ts < TTL) && cache[cKey].parcels.length > 0) {
    console.log('[cache] ' + cKey + ' -> ' + cache[cKey].parcels.length);
    return res.json({ county:def.name, parcels:cache[cKey].parcels, source:'cache' });
  }

  console.log('[fetch] ' + def.name + ' ' + minA + '-' + maxA + ' acres');

  var where = 'gisacres >= ' + minA + ' AND gisacres <= ' + maxA;

  fetchPage(where, def, 0)
    .then(function(data) {
      var features = data.features || [];
      var exceeded = data.exceededTransferLimit;
      console.log('  -> page 1: ' + features.length + ' features, exceeded=' + exceeded);

      var parcels = features.map(parseFeature).filter(function(p) {
        return p.acres >= minA && p.acres <= maxA;
      });

      console.log('  -> ' + parcels.length + ' parcels after filter');
      if (parcels.length > 0) cache[cKey] = { ts:Date.now(), parcels:parcels };
      res.json({ county:def.name, parcels:parcels, source:'live', exceeded:exceeded });
    })
    .catch(function(err) {
      console.error('[error] ' + def.name + ': ' + err.message);
      res.status(502).json({ error:err.message, county:def.name });
    });
});

app.listen(PORT, function() { console.log('LandScout v5 on port ' + PORT); });
