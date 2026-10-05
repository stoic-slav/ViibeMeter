-- venues and live_views are reached only through live_venues() / log_live_view() and the
-- service role; the public key needs no table privileges (RLS already returned no rows).
revoke all on table public.venues, public.live_views from anon, authenticated;
