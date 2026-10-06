// find-venue: search Google Maps for a venue by name, to make its QR code in the app.
//
// Input { query, lat?, lng? }: a text search ("C12 Brussels"), biased to the phone's position when
// given. Returns up to 5 places and saves them to `venues` (public map data) so the live view
// can name a venue whose code is scanned. The position, if any, is not stored or logged.
//
// Secret: GOOGLE_PLACES_KEY (shared with identify-venue).

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const BIAS_RADIUS_M = 20000;

type Place = {
  id: string; displayName?: { text?: string }; formattedAddress?: string; types?: string[];
  location?: { latitude: number; longitude: number };
};

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
  if (!key) return json({ error: 'venue search not configured' }, 503);

  let query: unknown, lat: unknown, lng: unknown;
  try {
    ({ query, lat, lng } = await req.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 120) {
    return json({ error: 'bad request' }, 400);
  }
  const body: Record<string, unknown> = { textQuery: query.trim(), maxResultCount: 5 };
  if (typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: BIAS_RADIUS_M } };
  }

  try {
    const res = await fetch(PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.types,places.location',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Places ${res.status}`);
    const places: Place[] = (await res.json()).places ?? [];
    await saveVenues(places).catch(() => {});
    return json({
      venues: places.map(p => ({
        placeId: p.id, name: p.displayName?.text ?? 'Unknown venue', address: p.formattedAddress ?? null, types: p.types ?? [],
      })),
    });
  } catch (err) {
    console.error('find-venue failed:', (err as Error).message);
    return json({ error: 'search failed' }, 502);
  }
});
