const express = require('express');
const fetch = require('node-fetch');
const protobuf = require('protobufjs');

const app = express();
const PORT = process.env.PORT || 3000;

// List of correct NYC subway feeds
const FEED_URLS = [
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-NQRW',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-BDFM',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-G',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si'
];

// Load GTFS-Realtime proto once
let FeedMessage = null;

async function loadProto() {
  await protobuf.load('./gtfs-realtime.proto');
  FeedMessage = root.lookupType('transit_realtime.FeedMessage');
}

// Allow CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/trains', async (req, res) => {
  try {
    if (!FeedMessage) {
      await loadProto();
    }

    const allTrains = [];

    const feedPromises = FEED_URLS.map(async (url) => {
      console.log(`Fetching feed: ${url}`);
      const response = await fetch(url);

      if (!response.ok) {
        console.error(`Failed to fetch ${url}: HTTP ${response.status}`);
        throw new Error(`Failed to fetch MTA feed: HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const message = FeedMessage.decode(new Uint8Array(buffer));

      message.entity.forEach(entity => {
        if (entity.vehicle && entity.vehicle.position) {
          const vehicle = entity.vehicle;
          allTrains.push({
            id: vehicle.vehicle?.id || 'unknown',
            lat: vehicle.position.latitude,
            lon: vehicle.position.longitude,
            bearing: vehicle.position.bearing || 0,
            line: vehicle.trip?.routeId || 'Unknown'
          });
        }
      });
    });

    await Promise.all(feedPromises);

    res.json(allTrains);

  } catch (error) {
    console.error('Error fetching or decoding MTA feeds:', error);
    res.status(500).send('Error fetching or decoding MTA feeds');
  }
});

app.listen(PORT, () => {
  console.log(`🚂 MTA Train Proxy (protobufjs version) running at http://localhost:${PORT}`);
});
