const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app = express();
const PORT = process.env.PORT || 3000;

const MTA_API_KEY = process.env.MTA_API_KEY;

// Multiple feeds (cover all NYC subway lines)
const FEED_IDS = ['1', '26', '16', '21']; // 1 = numbered lines, 26 = lettered lines, 16 = L, 21 = 7

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/trains', async (req, res) => {
  try {
    const allTrains = [];

    const feedPromises = FEED_IDS.map(async (feedId) => {
      const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${feedId ? `-${feedId}` : ''}`;
      const response = await fetch(url, { headers: { 'x-api-key': MTA_API_KEY } });
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
    console.error(error);
    res.status(500).send('Error fetching MTA feed');
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running at http://localhost:${PORT}`);
});