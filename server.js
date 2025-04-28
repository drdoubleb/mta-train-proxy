const express = require('express');
const fetch = require('node-fetch');
const protobuf = require('protobufjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Corrected feed URLs (lowercase bdfm)
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

// Enable CORS
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

      // Skip if it's XML
      if (fullBuffer[0] === 60) {
        console.warn(`Feed at ${url} returned XML, skipping.`);
        return;
      }

      let message;
      try {
        message = FeedMessage.decode(fullBuffer);
        console.log(`Decoded raw buffer successfully from ${url}.`);
      } catch (errorRaw) {
        console.warn(`Failed raw decode from ${url}. Trying after skipping 16 bytes.`);
        try {
          message = FeedMessage.decode(fullBuffer.slice(16));
          console.log(`Decoded buffer after skipping 16 bytes from ${url}.`);
        } catch (errorSkip) {
          console.error(`Failed decoding even after skipping 16 bytes at ${url}`);
          throw errorSkip;
        }
      }

      let validTrainsFromFeed = 0;

      message.entity.forEach(entity => {
        if (entity.vehicle && entity.vehicle.position && entity.vehicle.position.latitude && entity.vehicle.position.longitude) {
          const vehicle = entity.vehicle;
          allTrains.push({
            id: vehicle.vehicle?.id || 'unknown',
            lat: vehicle.position.latitude,
            lon: vehicle.position.longitude,
            bearing: vehicle.position.bearing || 0,
            line: vehicle.trip?.routeId || 'Unknown'
          });
          validTrainsFromFeed++;
        }
      });

      console.log(`Feed ${url}: ${validTrainsFromFeed} valid trains with GPS.`);
    });

    await Promise.all(feedPromises);

    console.log(`\nTOTAL: ${allTrains.length} live trains fetched across all feeds.`);
    res.json(allTrains);

  } catch (error) {
    console.error('Error fetching or decoding MTA feeds:', error);
    res.status(500).send('Error fetching or decoding MTA feeds');
  }
});

app.listen(PORT, () => {
  console.log(`🚂 MTA Train Proxy (clean mode) running at http://localhost:${PORT}`);
});
