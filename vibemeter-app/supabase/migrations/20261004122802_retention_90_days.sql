-- Data minimisation: the 10 s clips and the per-minute bass envelope are only needed for the
-- analysis (moment-by-moment crowd sync, automatic grouping). Remove them after 90 days; the
-- minute rows, ratings and sessions stay.
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.apply_retention() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.sensor_clips WHERE clip_start < now() - interval '90 days';
  UPDATE public.sensor_windows SET bass_envelope = NULL
   WHERE bass_envelope IS NOT NULL AND window_start < now() - interval '90 days';
$$;
REVOKE ALL ON FUNCTION public.apply_retention() FROM public, anon, authenticated;

SELECT cron.schedule('viibemeter-retention', '17 3 * * *', 'SELECT public.apply_retention()');
