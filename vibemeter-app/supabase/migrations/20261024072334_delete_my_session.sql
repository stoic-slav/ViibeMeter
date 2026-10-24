-- Swipe-to-delete on the session list: a phone deletes ONE of its own sessions, with its ratings,
-- recap answers and (by cascade) minute readings, clips and edit fingerprints.
create or replace function public.delete_my_session(p_device_id text, p_session_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_device_id is null or length(p_device_id) < 30 or length(p_device_id) > 64 then
    raise exception 'invalid device id';
  end if;
  -- only the phone that created the session may delete it
  if not exists (select 1 from public.sessions where id = p_session_id and device_id = p_device_id) then
    return false;
  end if;
  delete from public.subjective_ratings where session_id = p_session_id and device_id = p_device_id;
  delete from public.song_feedback where session_id = p_session_id and device_id = p_device_id;
  delete from public.edit_prints where session_id = p_session_id and device_id = p_device_id;
  delete from public.sessions where id = p_session_id and device_id = p_device_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.delete_my_session(text, uuid) from public;
grant execute on function public.delete_my_session(text, uuid) to anon, authenticated;
