// moments: upload and delete the opt-in "best moment" audio clips (build 29).
//
// The clips are short (about 15 s) and come from a person's strongest dancing, only from people
// who switched on "Send my best moments to improve the audio" (off by default). They go to the
// private `moments` bucket; nobody can read them with the public key. Every call carries the
// phone's anonymous device ID and only touches that device's own clips.
//
//   POST ?action=upload&device=…&id=<uuid>&layer=raw|clean&started=<ms>&dur=<ms>[&session=…&event=…
//        &venue=…&isrc=…&score=…&bass=…&rustle=…&db=…]   body: audio/wav bytes
//   POST ?action=delete&device=…&id=<uuid>      one clip
//   POST ?action=delete&device=…&session=<uuid> a session's clips
//   POST ?action=delete&device=…&all=1          all of the device's clips
//
// Clips are kept 14 days (expires_at, set by the table default); expired ones are removed on every call here and by
// analysis/clip_enhance.py --sweep. Uses the built-in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'moments';
const MAX_BYTES = 3 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const num = (v: string | null) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

async function removeClips(rows: { id: string; has_clean: boolean; device_id: string }[]) {
  if (rows.length === 0) return;
  const paths = rows.flatMap(r => [`${r.device_id}/${r.id}-raw.wav`, `${r.device_id}/${r.id}-clean.wav`]);
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw new Error(error.message);
  const { error: dbError } = await supabase.from('moment_clips').delete().in('id', rows.map(r => r.id));
  if (dbError) throw new Error(dbError.message);
}

async function sweepExpired() {
  const { data } = await supabase.from('moment_clips').select('id, has_clean, device_id').lt('expires_at', new Date().toISOString()).limit(200);
  if (data?.length) await removeClips(data);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = new URL(req.url);
  const q = url.searchParams;
  const action = q.get('action');
  const device = q.get('device') ?? '';
  if (device.length < 30 || device.length > 64 || !/^[\w-]+$/.test(device)) return json({ error: 'bad device' }, 400);

  try {
    sweepExpired().catch(() => {});

    if (action === 'upload') {
      const id = q.get('id') ?? '';
      const layer = q.get('layer');
      const started = num(q.get('started'));
      const dur = num(q.get('dur'));
      if (!UUID.test(id) || (layer !== 'raw' && layer !== 'clean') || started == null || dur == null) return json({ error: 'bad request' }, 400);
      const session = q.get('session');
      if (session && !UUID.test(session)) return json({ error: 'bad session' }, 400);

      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length < 1000 || bytes.length > MAX_BYTES) return json({ error: 'bad size' }, 413);
      // A WAV file starts with RIFF....WAVE
      const head = new TextDecoder().decode(bytes.slice(0, 4)) + new TextDecoder().decode(bytes.slice(8, 12));
      if (head !== 'RIFFWAVE') return json({ error: 'not a wav' }, 415);

      // The row belongs to one device: refuse to write another device's id
      const { data: existing } = await supabase.from('moment_clips').select('device_id').eq('id', id).maybeSingle();
      if (existing && existing.device_id !== device) return json({ error: 'forbidden' }, 403);

      const { error } = await supabase.storage.from(BUCKET).upload(`${device}/${id}-${layer}.wav`, bytes, { contentType: 'audio/wav', upsert: true });
      if (error) throw new Error(error.message);

      if (layer === 'raw') {
        const { error: dbError } = await supabase.from('moment_clips').upsert({
          id, device_id: device, session_id: session || null, started_at: new Date(started).toISOString(), duration_ms: Math.round(dur),
          event_code: q.get('event') || null, venue_place_id: q.get('venue') || null, song_isrc: q.get('isrc') || null,
          score: num(q.get('score')), bass_share: num(q.get('bass')), rustle_share: num(q.get('rustle')), avg_db: num(q.get('db')),
        });
        if (dbError) throw new Error(dbError.message);
      } else {
        await supabase.from('moment_clips').update({ has_clean: true }).eq('id', id).eq('device_id', device);
      }
      return json({ ok: true });
    }

    if (action === 'delete') {
      let query = supabase.from('moment_clips').select('id, has_clean, device_id').eq('device_id', device);
      const id = q.get('id'), session = q.get('session');
      if (id) { if (!UUID.test(id)) return json({ error: 'bad id' }, 400); query = query.eq('id', id); }
      else if (session) { if (!UUID.test(session)) return json({ error: 'bad session' }, 400); query = query.eq('session_id', session); }
      else if (q.get('all') !== '1') return json({ error: 'say what to delete' }, 400);
      const { data, error } = await query.limit(1000);
      if (error) throw new Error(error.message);
      await removeClips(data ?? []);
      return json({ ok: true, deleted: data?.length ?? 0 });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    console.error('moments error:', (err as Error).message);
    return json({ error: 'server error' }, 500);
  }
});
