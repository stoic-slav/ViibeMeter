// nearby-clubs: which night clubs are around here? (build 32, arrival nudges)
//
// When someone says "Yes, I'm going out tonight", the phone asks for the clubs near it, so the
// operating system can watch those few places and show "Start measuring?" when the person walks
// in, even with the app closed. The app sends its position rounded to ~1 km; this function asks
// Google Places (New) for up to 15 night clubs within 15 km and returns their public place ID,
// name and location. The position is used for this one lookup only: it is never stored or logged.
// The places themselves (public map data) are saved to `venues`, like identify-venue does.
//
// Secret: GOOGLE_PLACES_KEY (the same one identify-venue uses).

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const RADIUS_M = 15000;
const MAX_CLUBS = 15;

type Place = { id: string; displayName?: { text?: string }; types?: string[]; location?: { latitude: number; longitude: number } };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function saveVenues(places: Place[]): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key || places.length === 0) return;
  await fetch(`${url}/rest/v1/venues?on_conflict=place_id`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(places.map(p => ({
      place_id: p.id, name: p.displayName?.text ?? 'Unknown venue', types: p.types ?? [],
      lat: p.location?.latitude ?? null, lng: p.location?.longitude ?? null, updated_at: new Date().toISOString(),
    }))),
  });
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const key = Deno.env.get('GOOGLE_PLACES_KEY');
  if (!key) return json({ error: 'venue lookup not configured' }, 503);

  let lat: number, lng: number;
  try {
    ({ lat, lng } = await req.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json({ error: 'bad request' }, 400);
  }
  // Whatever precision the app sent, treat it as ~1 km: this is a city-level question
  lat = Math.round(lat * 100) / 100;
  lng = Math.round(lng * 100) / 100;

  try {
    const res = await fetch(PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.location',
      },
      body: JSON.stringify({
        includedTypes: ['night_club'],
        maxResultCount: MAX_CLUBS,
        rankPreference: 'DISTANCE',
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: RADIUS_M } },
      }),
    });
    if (!res.ok) throw new Error(`Places ${res.status}`);
    const places: Place[] = ((await res.json()).places ?? []).filter((p: Place) => p.id && p.location);
    await saveVenues(places).catch(() => {});
    return json({
      clubs: places.map(p => ({ placeId: p.id, name: p.displayName?.text ?? null, lat: p.location!.latitude, lng: p.location!.longitude })),
    });
  } catch (err) {
    // No position in the log, only the failure
    console.error('nearby-clubs failed:', (err as Error).message);
    return json({ error: 'lookup failed' }, 502);
  }
});
