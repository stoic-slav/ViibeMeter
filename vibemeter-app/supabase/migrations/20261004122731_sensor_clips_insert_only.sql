-- The app may only add 10 s clips: no read, update or delete with the public (anon) key.
-- Analysis reads them with the service key, which bypasses RLS.
CREATE POLICY "App inserts clips" ON public.sensor_clips FOR INSERT TO anon WITH CHECK (true);
REVOKE ALL ON public.sensor_clips FROM anon, authenticated;
GRANT INSERT ON public.sensor_clips TO anon;
