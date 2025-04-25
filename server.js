const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings').default; // <-- this is the fix!

const app = express();
const PORT = process.env.PORT || 3000;

const FEED_IDS = ['1', '26', '16', '21']; // Covers 1-6, A-E, L, 7 trains

// Enable CORS so your frontend can fetch from this proxy
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/trains', async (req, res) => {
  try {
    const allTrains = [];

    const feedPromises = FEED_IDS.map(async (feedId) => {
      const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${feedId ? `-${feedId}` : ''}`;
      console.log(`Fetching feed: ${url}`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`Failed to fetch ${url}: HTTP ${response.status}`);
        throw new Error(`Failed to fetch MTA feed: HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const feed = GtfsRealtimeBindings.FeedMessage.decode(new Uint8Array(buffer));

      feed.entity.forEach(entity => {
        if (entity.vehicle && entity.vehicle.position) {
          const vehicle = entity.vehicle;
          allTrains.push({
            id: vehicle.vehicle && vehicle.vehicle.id ? vehicle.vehicle.id : 'unknown',
            lat: vehicle.position.latitude,
            lon: vehicle.position.longitude,
            bearing: vehicle.position.bearing || 0,
            line: vehicle.trip && vehicle.trip.routeId ? vehicle.trip.routeId : 'Unknown'
          });
        }
      });
    });

    await Promise.all(feedPromises);

    res.json(allTrains);

  } catch (error) {
    console.error('Error fetching MTA feeds:', error);
    res.status(500).send('Error fetching MTA feeds');
  }
});

app.listen(PORT, () => {
  console.log(`🚂 MTA Train Proxy running at http://localhost:${PORT}`);
});
