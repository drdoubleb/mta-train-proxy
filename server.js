const express = require('express');
const fetch = require('node-fetch');
const protobuf = require('protobufjs');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Corrected subway feed URLs
const FEED_URLS = [
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-G',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si'
];

// Load GTFS-Realtime proto once
let FeedMessage = null;

// Load stations.json once
const stations = JSON.parse(fs.readFileSync('./stations.json', 'utf8'));

async function loadProto() {
  const root = await protobuf.load('./gtfs-realtime.proto');
  FeedMessage = root.lookupType('transit_realtime.FeedMessage');
}

// CORS for frontend access
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

      let guessedTrainsFromFeed = 0;


		message.entity.forEach(entity => {
		  if (entity.tripUpdate && entity.tripUpdate.stopTimeUpdate && entity.tripUpdate.stopTimeUpdate.length > 1) {
			const trip = entity.tripUpdate.trip;
			const stops = entity.tripUpdate.stopTimeUpdate;

			// Find prior and next stops
			const prior = stops[0];
			const next = stops[1];

			if (prior && next && stations[prior.stopId] && stations[next.stopId]) {
			  const priorStation = stations[prior.stopId];
			  const nextStation = stations[next.stopId];

			  allTrains.push({
				id: trip?.tripId || 'unknown',
				line: trip?.routeId || 'Unknown',
				priorStop: {
				  stopId: prior.stopId,
				  lat: priorStation.lat,
				  lon: priorStation.lon
				},
				nextStop: {
				  stopId: next.stopId,
				  lat: nextStation.lat,
				  lon: nextStation.lon
				},
				departureTime: Number(prior.departure?.time) || Number(prior.arrival?.time),
				arrivalTime: Number(next.arrival?.time)
			  });
			}
		  }
		});


      console.log(`Feed ${url}: ${guessedTrainsFromFeed} trains with predicted position.`);
    });

    await Promise.all(feedPromises);

    console.log(`\nTOTAL: ${allTrains.length} trains with predicted positions.`);
    res.json(allTrains);

  } catch (error) {
    console.error('Error fetching or decoding MTA feeds:', error);
    res.status(500).send('Error fetching or decoding MTA feeds');
  }
});

let lastBusFetchTime = 0;
let cachedBusData = null;

app.get('/bus-positions', async (req, res) => {
  const now = Date.now();
  const maxAge = 30 * 1000; // 30 seconds

  if (cachedBusData && (now - lastBusFetchTime < maxAge)) {
    return res.json(cachedBusData); // serve cached
  }

  try {
    //const response = await fetch(`https://bustime.mta.info/api/siri/vehicle-monitoring.json?key=${process.env.MTA_API_KEY}&VehicleMonitoringDetailLevel=normal`);
    const response = await fetch(`https://bustime.mta.info/api/siri/vehicle-monitoring.json?key=${process.env.MTA_API_KEY}`);
    const data = await response.json();

    const buses = data.Siri.ServiceDelivery.VehicleMonitoringDelivery[0].VehicleActivity.map(activity => {
      const mvj = activity.MonitoredVehicleJourney;
      return {
        id: mvj.VehicleRef?.replace(/^[^_]+_/, '') ?? '',
        route: mvj.LineRef?.replace(/^[^_]+_/, '') ?? '',
        lat: mvj.VehicleLocation?.Latitude,
        lon: mvj.VehicleLocation?.Longitude,
        bearing: mvj.Bearing
      };
    });

    cachedBusData = buses;
    lastBusFetchTime = now;

    res.json(buses);
  } catch (err) {
    console.error("Error fetching SIRI bus data:", err);
    res.status(500).send("Bus API error");
  }
});





/**
 * ----------------------
 * Bee-Line GTFS-Realtime
 * ----------------------
 * Westchester County Bee-Line exposes GTFS-RT endpoints with JSON/protobuf/XML formats.
 * We proxy them here to (a) avoid CORS issues and (b) allow light caching.
 *
 * Configure via env vars:
 *   BEELINE_BASE (default: https://wcgmvgtfs.westchestergov.com/api)
 *   BEELINE_CACHE_MS (default: 5000)
 */
const BEELINE_BASE = process.env.BEELINE_BASE || 'https://wcgmvgtfs.westchestergov.com/api';
const BEELINE_CACHE_MS = parseInt(process.env.BEELINE_CACHE_MS || '5000', 10);

let beelineCache = {
  vehiclepositions: { ts: 0, body: null, contentType: 'application/json' },
  tripupdates: { ts: 0, body: null, contentType: 'application/json' },
  servicealerts: { ts: 0, body: null, contentType: 'application/json' },
};

// Lightweight CORS for everything (safe since we only expose public transit data)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function proxyBeeLine(feed, format = 'json', res) {
  try {
    const now = Date.now();
    const cache = beelineCache[feed];
    const isJson = format.toLowerCase() === 'json';

    if (cache && (now - cache.ts) < BEELINE_CACHE_MS && cache.body) {
      res.type(cache.contentType).send(cache.body);
      return;
    }

    const url = `${BEELINE_BASE}/${feed}?format=${encodeURIComponent(format)}`;

    const upstream = await fetch(url, {
      // Not sending credentials or headers; Bee-Line endpoints are anonymous public
      timeout: 8000
    });

    if (!upstream.ok) {
      res.status(upstream.status).send(`Bee-Line upstream error ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get('content-type') || (isJson ? 'application/json' : 'application/octet-stream');
    let bodyBuf = await upstream.buffer();

    // Update cache
    if (beelineCache[feed]) {
      beelineCache[feed].ts = now;
      beelineCache[feed].body = bodyBuf;
      beelineCache[feed].contentType = contentType;
    }

    res.type(contentType).send(bodyBuf);
  } catch (err) {
    console.error(`[Bee-Line] Proxy error for ${feed}:`, err.message || err);
    res.status(502).send('Bee-Line proxy error');
  }
}

// Raw pass-throughs (choose ?format=json|gtfs.proto|xml)
app.get('/beeline/vehiclepositions', async (req, res) => {
  const format = req.query.format || 'json';
  await proxyBeeLine('vehiclepositions', format, res);
});

app.get('/beeline/tripupdates', async (req, res) => {
  const format = req.query.format || 'json';
  await proxyBeeLine('tripupdates', format, res);
});

app.get('/beeline/servicealerts', async (req, res) => {
  const format = req.query.format || 'json';
  await proxyBeeLine('servicealerts', format, res);
});

/**
 * Convenience endpoint: /beeline/vehicles (JSON only)
 * Returns a trimmed array of vehicle markers for easy mapping.
 */
app.get('/beeline/vehicles', async (req, res) => {
  try {
    const upstream = await fetch(`${BEELINE_BASE}/vehiclepositions?format=json`, { timeout: 8000 });
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Bee-Line vehicles upstream error ${upstream.status}`);
    }
    const data = await upstream.json();
    const entities = (data?.entity || []).filter(e => e.vehicle && e.vehicle.position);

    const markers = entities.map(e => ({
      id: e.id || e.vehicle?.vehicle?.id || null,
      lat: e.vehicle?.position?.latitude,
      lon: e.vehicle?.position?.longitude,
      bearing: e.vehicle?.position?.bearing,
      speed: e.vehicle?.position?.speed,
      route_id: e.vehicle?.trip?.route_id || e.vehicle?.trip?.routeId || null,
      trip_id: e.vehicle?.trip?.trip_id || e.vehicle?.trip?.tripId || null,
      timestamp: e.vehicle?.timestamp,
      label: e.vehicle?.vehicle?.label || null,
    })).filter(m => typeof m.lat === 'number' && typeof m.lon === 'number');

    res.json({ count: markers.length, vehicles: markers });
  } catch (err) {
    console.error('[Bee-Line] vehicles error:', err.message || err);
    res.status(502).send('Bee-Line vehicles error');
  }
});

app.listen(PORT, () => {
  console.log(`🚂 MTA Train Proxy (TripUpdate guessing) running at http://localhost:${PORT}`);
});
