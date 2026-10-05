// identify-venue: which club (or else bar) is the phone in?
//
// The app sends its position rounded to ~11 m. This function asks Google Places (New) for the
// closest night club within 150 m, falling back to the closest bar or pub, and returns that
// place. The position is used for this one lookup only: it is never stored or logged. The
// place itself (public map data) is saved to `venues` so live_venues() can name it.
//
// Secret: GOOGLE_PLACES_KEY (Dashboard → Edge Functions → Secrets).

const RADIUS_M = 150;
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const TYPE_TIERS = [['night_club'], ['bar', 'pub']];

type Place = { id: string; displayName?: { text?: string }; types?: string[]; location?: { latitude: number; longitude: number } };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function nearest(key: string, lat: number, lng: number, types: string[]): Promise<Place | null> {
  const res = await fetch(PLACES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.location',
    },
    body: JSON.stringify({
      includedTypes: types,
      maxResultCount: 1,
      rankPreference: 'DISTANCE',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: RADIUS_M } },
    }),
  });
  if (!res.ok) throw new Error(`Places ${res.status}`);
  const data = await res.json();
  return data.places?.[0] ?? null;
}

async function saveVenue(p: Place): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/venues?on_conflict=place_id`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      place_id: p.id, name: p.displayName?.text ?? 'Unknown venue', types: p.types ?? [],
      lat: p.location?.latitude ?? null, lng: p.location?.longitude ?? null, updated_at: new Date().toISOString(),
    }),
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

  try {
    for (const types of TYPE_TIERS) {
      const p = await nearest(key, lat, lng, types);
      if (!p) continue;
      await saveVenue(p).catch(() => {});
      const d = p.location ? Math.round(distanceM(lat, lng, p.location.latitude, p.location.longitude)) : null;
      return json({ placeId: p.id, name: p.displayName?.text ?? null, types: p.types ?? [], distanceM: d });
    }
    return json({ placeId: null });
  } catch (err) {
    // No position in the log, only the failure
    console.error('identify-venue failed:', (err as Error).message);
    return json({ error: 'lookup failed' }, 502);
  }
});
