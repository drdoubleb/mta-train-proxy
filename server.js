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
  vehiclepositions: {},
  tripupdates: {},
  servicealerts: {},
};

function normalizeBeeLineFormat(format = 'json') {
  const normalized = String(format).trim().toLowerCase();

  if (normalized === 'protobuf' || normalized === 'proto' || normalized === 'pb') {
    return 'gtfs.proto';
  }

  if (normalized === 'gtfs' || normalized === 'gtfs-rt' || normalized === 'gtfsrt') {
    return 'gtfs.proto';
  }

  if (normalized === 'xml' || normalized === 'json' || normalized === 'gtfs.proto') {
    return normalized;
  }

  return 'json';
}

// Lightweight CORS for everything (safe since we only expose public transit data)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function fetchBeeLineFeed(feed, format = 'json') {
  const now = Date.now();
  const normalizedFormat = normalizeBeeLineFormat(format);
  const feedCache = beelineCache[feed] || (beelineCache[feed] = {});
  const cache = feedCache[normalizedFormat];
  const isJson = normalizedFormat === 'json';

  if (cache && (now - cache.ts) < BEELINE_CACHE_MS && cache.body) {
    return { body: cache.body, contentType: cache.contentType, normalizedFormat, fromCache: true };
  }

  const url = `${BEELINE_BASE}/${feed}?format=${encodeURIComponent(normalizedFormat)}`;
  const upstream = await fetch(url, {
    timeout: 8000,
    headers: {
      Accept: isJson ? 'application/json' : '*/*',
      'User-Agent': 'mta-train-proxy/1.0'
    }
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return { upstreamError: true, status: upstream.status, bodyText: text };
  }

  const contentType = upstream.headers.get('content-type') || (isJson ? 'application/json' : 'application/octet-stream');
  const bodyBuf = await upstream.buffer();

  feedCache[normalizedFormat] = { ts: now, body: bodyBuf, contentType };

  return { body: bodyBuf, contentType, normalizedFormat, fromCache: false };
}

async function proxyBeeLine(feed, format = 'json', res) {
  try {
    const result = await fetchBeeLineFeed(feed, format);
    if (result.upstreamError) {
      const reason = result.bodyText ? `: ${result.bodyText.slice(0, 200)}` : '';
      res.status(result.status).send(`Bee-Line upstream error ${result.status}${reason}`);
      return;
    }

    res.type(result.contentType).send(result.body);
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
    const result = await fetchBeeLineFeed('vehiclepositions', 'json');
    if (result.upstreamError) {
      const reason = result.bodyText ? `: ${result.bodyText.slice(0, 200)}` : '';
      return res.status(result.status).send(`Bee-Line vehicles upstream error ${result.status}${reason}`);
    }

    const data = JSON.parse(result.body.toString('utf8'));
    const entities = (data?.entity || data?.entities || []).filter(e => e.vehicle && e.vehicle.position);

    const markers = entities.map(e => {
      const position = e.vehicle?.position || {};
      const trip = e.vehicle?.trip || {};
      const vehicle = e.vehicle?.vehicle || {};

      return {
        id: e.id || vehicle.id || null,
        lat: position.latitude ?? position.lat,
        lon: position.longitude ?? position.lon,
        bearing: position.bearing,
        speed: position.speed,
        route_id: trip.route_id || trip.routeId || null,
        trip_id: trip.trip_id || trip.tripId || null,
        timestamp: e.vehicle?.timestamp,
        label: vehicle.label || null,
      };
    }).filter(m => Number.isFinite(m.lat) && Number.isFinite(m.lon));

    res.json({ count: markers.length, vehicles: markers });
  } catch (err) {
    console.error('[Bee-Line] vehicles error:', err.message || err);
    res.status(502).send('Bee-Line vehicles error');
  }
});

app.listen(PORT, () => {
  console.log(`🚂 MTA Train Proxy (TripUpdate guessing) running at http://localhost:${PORT}`);
});
