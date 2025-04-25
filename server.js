app.get('/trains', async (req, res) => {
  try {
    const allTrains = [];

    const feedPromises = FEED_IDS.map(async (feedId) => {
      const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${feedId ? `-${feedId}` : ''}`;
      const response = await fetch(url); // 👈 No API key header anymore
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
