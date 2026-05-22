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

// County name filters — matched against ownname/scity heuristically
// Primary filter is acreage only (confirmed working), then we filter by county in JS
const COUNTY_CITIES = {
  mecklenburg: ['CHARLOTTE','HUNTERSVILLE','CORNELIUS','DAVIDSON','PINEVILLE','MATTHEWS','MINT HILL','STALLINGS','HARRISBURG'],
  iredell:     ['MOORESVILLE','STATESVILLE','TROUTMAN','HARMONY','LOVE VALLEY','BARIUM SPRINGS','DAVIDSON'],
  cabarrus:    ['CONCORD','KANNAPOLIS','HARRISBURG','MOUNT PLEASANT','MIDLAND','LOCUST'],
  union:       ['MONROE','WAXHAW','INDIAN TRAIL','STALLINGS','MARVIN','WEDDINGTON','MATTHEWS','MINERAL SPRINGS'],
  gaston:      ['GASTONIA','BELMONT','BESSEMER CITY','CHERRYVILLE','CRAMERTON','DALLAS','LOWELL','MCADENVILLE','MOUNT HOLLY','STANLEY'],
  lincoln:     ['LINCOLNTON','IRON STATION','DENVER','VALE','STANLEY'],
  rowan:       ['SALISBURY','SPENCER','CHINA GROVE','LANDIS','KANNAPOLIS','GRANITE QUARRY','ROCKWELL'],
  stanly:      ['ALBEMARLE','NORWOOD','BADIN','NEW LONDON','OAKBORO','RICHFIELD','STANFIELD'],
  cleveland:   ['SHELBY','KINGS MOUNTAIN','BOILING SPRINGS','LATTIMORE','FALLSTON','MOORESBORO','POLKVILLE']
};

const COUNTY_BBOXES_WGS84 = {
  mecklenburg: { xmin:-81.07, ymin:34.99, xmax:-80.54, ymax:35.52 },
  iredell:     { xmin:-80.97, ymin:35.46, xmax:-80.44, ymax:35.97 },
  cabarrus:    { xmin:-80.67, ymin:35.21, xmax:-80.20, ymax:35.60 },
  union:       { xmin:-80.89, ymin:34.81, xmax:-80.10, ymax:35.26 },
  gaston:      { xmin:-81.56, ymin:35.06, xmax:-80.90, ymax:35.50 },
  lincoln:     { xmin:-81.55, ymin:35.37, xmax:-81.01, ymax:35.73 },
  rowan:       { xmin:-80.57, ymin:35.48, xmax:-80.01, ymax:35.88 },
  stanly:      { xmin:-80.50, ymin:35.11, xmax:-79.89, ymax:35.51 },
  cleveland:   { xmin:-81.76, ymin:35.07, xmax:-81.36, ymax:35.58 }
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

function inBbox(lat, lng, bbox) {
  return lat >= bbox.ymin && lat <= bbox.ymax && lng >= bbox.xmin && lng <= bbox.xmax;
}

app.get('/api/parcels', function(req, res) {
  var county = (req.query.county || '').toLowerCase();
  var minA   = parseFloat(req.query.min_acres) || 25;
  var maxA   = parseFloat(req.query.max_acres) || 2000;
  var bbox   = COUNTY_BBOXES_WGS84[county];

  if (!bbox) return res.status(400).json({ error:'Unknown county: ' + county });

  var cKey = county + '-' + minA + '-' + maxA;
  if (cache[cKey] && (Date.now() - cache[cKey].ts < TTL) && cache[cKey].parcels.length > 0) {
    console.log('[cache] ' + cKey + ' -> ' + cache[cKey].parcels.length);
    return res.json({ county:county, parcels:cache[cKey].parcels, source:'cache' });
  }

  console.log('[fetch] ' + county + ' ' + minA + '-' + maxA + ' acres (no bbox filter)');

  // Query acreage only — NO geometry filter (confirmed working approach)
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
    console.log('  -> ' + features.length + ' raw features from NC API');

    var parcels = [];
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var a = f.attributes || {};
      var lat = 0, lng = 0;
      var g = f.geometry;
      if (g) {
        if (typeof g.x !== 'undefined') { lng = g.x; lat = g.y; }
        else if (g.rings && g.rings[0] && g.rings[0].length) {
          var pts = g.rings[0];
          var sumLng = 0, sumLat = 0;
          for (var j = 0; j < pts.length; j++) { sumLng += pts[j][0]; sumLat += pts[j][1]; }
          lng = sumLng / pts.length;
          lat = sumLat / pts.length;
        }
      }

      // Filter by bounding box using returned WGS84 coordinates
      if (lat === 0 && lng === 0) continue;
      if (!inBbox(lat, lng, bbox)) continue;

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
        zoning:'', yearbuilt:null, lat:lat, lng:lng
      });
    }

    console.log('  -> ' + parcels.length + ' parcels in ' + county + ' bbox');
    if (parcels.length > 0) cache[cKey] = { ts:Date.now(), parcels:parcels };
    res.json({ county:county, parcels:parcels, source:'live', total_nc:features.length });
  })
  .catch(function(err) {
    console.error('[error] ' + county + ': ' + err.message);
    res.status(502).json({ error:err.message, county:county });
  });
});

app.listen(PORT, function() { console.log('LandScout v5 on port ' + PORT); });
