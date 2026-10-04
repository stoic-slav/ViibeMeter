-- Step 1 of the lockdown: the app's public key can no longer delete data. Read, insert and
-- update stay open for now, because every installed build uploads with upsert, which needs them.
-- Step 2 (after testers update to a build that uploads through server functions): drop SELECT.
DROP POLICY IF EXISTS "Allow all session operations" ON public.sessions;
DROP POLICY IF EXISTS "Allow all sensor_window operations" ON public.sensor_windows;
DROP POLICY IF EXISTS "Allow all rating operations" ON public.subjective_ratings;

CREATE POLICY "App reads sessions" ON public.sessions FOR SELECT USING (true);
CREATE POLICY "App inserts sessions" ON public.sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "App updates sessions" ON public.sessions FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "App reads windows" ON public.sensor_windows FOR SELECT USING (true);
CREATE POLICY "App inserts windows" ON public.sensor_windows FOR INSERT WITH CHECK (true);
CREATE POLICY "App updates windows" ON public.sensor_windows FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "App reads ratings" ON public.subjective_ratings FOR SELECT USING (true);
CREATE POLICY "App inserts ratings" ON public.subjective_ratings FOR INSERT WITH CHECK (true);
CREATE POLICY "App updates ratings" ON public.subjective_ratings FOR UPDATE USING (true) WITH CHECK (true);

REVOKE DELETE, TRUNCATE ON public.sessions, public.sensor_windows, public.subjective_ratings FROM anon, authenticated;
