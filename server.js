const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // Allow all browser requests
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'LandScout server running', version: '1.0' });
});

// Proxy all Regrid API calls
app.get('/api/parcels', async (req, res) => {
  try {
    const { geoid, min_acres, max_acres, token, page = 1 } = req.query;

    if (!token) return res.status(400).json({ error: 'Missing token' });
    if (!geoid)  return res.status(400).json({ error: 'Missing geoid' });

    const url = new URL('https://app.regrid.com/api/v2/parcels/query');
    url.searchParams.set('fields[geoid][eq]',        geoid);
    url.searchParams.set('fields[ll_gisacre][gte]',  min_acres || 25);
    url.searchParams.set('fields[ll_gisacre][lte]',  max_acres || 2000);
    url.searchParams.set('limit',                    '100');
    url.searchParams.set('page',                     page);
    url.searchParams.set('return_geometry',          'true');
    url.searchParams.set('return_custom',            'false');
    url.searchParams.set('token',                    token);

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'LandScout-Proxy/1.0' }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: `Regrid API error ${response.status}`,
        detail: text.slice(0, 300)
      });
    }

    const data = await response.json();
    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`LandScout proxy running on port ${PORT}`));
