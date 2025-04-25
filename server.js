const express = require('express');
const fetch = require('node-fetch');
const protobuf = require('protobufjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Corrected feed list (bdfm lowercase)
const FEED_URLS = [
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-NQRW',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-G',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si'
];

// Load GTFS-Realtime proto once
let FeedMessage = null;

async function loadProto() {
  const root = await protobuf.load('./gtfs-realtime.proto');
  FeedMessage = root.lookupType('transit_realtime.FeedMessage');
}

// Allow CORS for frontend
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
      console.log(`\nFetching feed: ${url}`);
      const response = await fetch(url);

      if (!response.ok) {
        console.error(`Failed to fetch ${url}: HTTP ${response.status}`);
        throw new Error(`Failed to fetch MTA feed: HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const fullBuffer = new Uint8Array(buffer);

      console.log('First 20 bytes of response:', Array.from(fullBuffer.slice(0, 20)));

      // Skip if XML
      if (fullBuffer[0] === 60) {
        console.warn(`Feed at ${url} is returning XML (not GTFS-Realtime), skipping.`);
        return;
      }

      let message;
      try {
        message = FeedMessage.decode(fullBuffer);
        console.log(`Decoded raw buffer successfully from ${url}.`);
      } catch (errorRaw) {
        console.warn(`Failed to decode raw buffer from ${url}. Trying after skipping 16 bytes.`);
        try {
          message = FeedMessage.decode(fullBuffer.slice(16));
          console.log(`Decoded buffer after skipping 16 bytes successfully from ${url}.`);
        } catch (errorSkip) {
          console.error(`Failed to decode feed at ${url} even after skipping 16 bytes.`);
          throw errorSkip;
        }
      }

      let feedTrainCount = 0;

      message.entity.forEach(entity => {
        console.log('Decoded entity:', JSON.stringify(entity, null, 2));

        if (entity.vehicle && entity.vehicle.position && entity.vehicle.position.latitude && entity.vehicle.position.longitude) {
          const vehicle = entity.vehicle;
          allTrains.push({
            id: vehicle.vehicle?.id || 'unknown',
            lat: vehicle.position.latitude,
            lon: vehicle.position.longitude,
            bearing: vehicle.position.bearing || 0,
            line: vehicle.trip?.routeId || 'Unknown'
          });
          feedTrainCount++;
        } else {
          console.warn('Entity missing position info, skipping.');
        }
      });

      console.log(`Feed ${url} contributed ${feedTrainCount} trains.`);
    });

    await Promise.all(feedPromises);

    console.log(`\nTotal trains fetched across all feeds: ${allTrains.length}`);
    res.json(allTrains);

  } catch (error) {
    console.error('Error fetching or decoding MTA feeds:', error);
    res.status(500).send('Error fetching or decoding MTA feeds');
  }
});

app.listen(PORT, () => {
  console.log(`🚂 MTA Train Proxy (debug mode) running at http://localhost:${PORT}`);
});
