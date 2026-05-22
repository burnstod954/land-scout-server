const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const NC_URL    = 'https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/ArcGIS/rest/services/parcels/FeatureServer/0/query';
const NC_FIELDS = 'parno,ownname,mailadd,mcity,mstate,mzip,siteadd,scity,gisacres,struct,parval,parusedesc';

const VALID = ['iredell','cabarrus','union','gaston','lincoln','rowan','stanly','cleveland'];

const cache = {};
const TTL   = 1000 * 60 * 60 * 4;

app.get('/health', function(req, res) {
  res.json({ status:'LandScout v10 OK', uptime:Math.round(process.uptime()), cached:Object.keys(cache).length });
});

app.get('/clear-cache', function(req, res) {
  var count = Object.keys(cache).length;
  Object.keys(cache).forEach(function(k) { delete cache[k]; });
  res.json({ cleared: count });
});

function getLatLng(f) {
  var lat=0, lng=0, g=f.geometry;
  if (g) {
    if (typeof g.x!=='undefined'&&g.x!==null){lng=g.x;lat=g.y;}
    else if (g.rings&&g.rings[0]&&g.rings[0].length){
      var pts=g.rings[0],sl=0,sa=0;
      for(var j=0;j<pts.length;j++){sl+=pts[j][0];sa+=pts[j][1];}
      lng=sl/pts.length; lat=sa/pts.length;
    }
  }
  return {lat:lat,lng:lng};
}

app.get('/api/parcels', function(req, res) {
  var county = (req.query.county||'').toLowerCase();
  var minA   = parseFloat(req.query.min_acres)||25;
  var maxA   = parseFloat(req.query.max_acres)||2000;

  if (VALID.indexOf(county)<0) return res.status(400).json({error:'Unknown county: '+county});

  var cKey = county+'-'+minA+'-'+maxA;
  if (cache[cKey]&&(Date.now()-cache[cKey].ts<TTL)&&cache[cKey].parcels.length>0) {
    console.log('[cache] '+cKey+' -> '+cache[cKey].parcels.length);
    return res.json({county:county, parcels:cache[cKey].parcels, source:'cache'});
  }

  console.log('[fetch] '+county+' '+minA+'-'+maxA+' acres');

  var params = new URLSearchParams({
    where:             'gisacres >= '+minA+' AND gisacres <= '+maxA,
    outFields:         NC_FIELDS,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '2000',
    orderByFields:     'gisacres DESC',
    f:                 'json'
  });

  fetch(NC_URL+'?'+params, {headers:{'User-Agent':'LandScout/10.0'},timeout:45000})
  .then(function(r){
    if(!r.ok) throw new Error('NC API HTTP '+r.status);
    return r.json();
  })
  .then(function(data){
    if(data.error) throw new Error(data.error.message||JSON.stringify(data.error));
    var features=data.features||[];
    console.log('  -> '+features.length+' raw features (no bbox filter)');

    var parcels=features.map(function(f){
      var a=f.attributes||{};
      var pos=getLatLng(f);
      var acres=parseFloat(a.gisacres||0);
      return {
        pin:     (a.parno||'').trim(),
        owner:   (a.ownname||'').trim(),
        mailAddr:[a.mailadd,a.mcity,a.mstate,a.mzip].filter(Boolean).join(', '),
        siteAddr:(a.siteadd||a.scity||'').trim(),
        acres:   acres,
        struct:  a.struct==='Y',
        assessed:parseFloat(a.parval||0),
        usedesc: (a.parusedesc||'').trim(),
        zoning:'', yearbuilt:null,
        lat:pos.lat, lng:pos.lng
      };
    }).filter(function(p){return p.acres>=minA&&p.acres<=maxA;});

    console.log('  -> '+parcels.length+' parcels returned');
    if(parcels.length>0) cache[cKey]={ts:Date.now(),parcels:parcels};
    res.json({county:county, parcels:parcels, source:'live'});
  })
  .catch(function(err){
    console.error('[error] '+county+': '+err.message);
    res.status(502).json({error:err.message,county:county});
  });
});

app.listen(PORT, function(){console.log('LandScout v10 on port '+PORT);});
