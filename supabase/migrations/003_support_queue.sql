-- Consume the independent diagnostic lane in bounded batches.  Older clients
-- only read these rows and therefore left every heartbeat pending forever.
-- Claimed rows can be reclaimed after a crash; successful batches are retained
-- as processed history rather than deleted.
create or replace function public.claim_support_bridge_messages(
  requested_pair_id uuid,
  requested_limit integer default 100
)
returns setof public.bridge_messages
language plpgsql security definer set search_path = public
as $$
declare bounded_limit integer := greatest(1, least(coalesce(requested_limit, 100), 500));
begin
  return query
  update bridge_messages m
    set status = 'claimed', claimed_at = now()
    where m.id in (
      select id
      from bridge_messages
      where pair_id = requested_pair_id
        and recipient_id = auth.uid()
        and idempotency_key like 'support-v1:%'
        and (status = 'pending' or (status = 'claimed' and claimed_at < now() - interval '5 minutes'))
      order by created_at, id
      for update skip locked
      limit bounded_limit
    )
  returning m.*;
end;
$$;

create or replace function public.ack_support_bridge_messages(requested_message_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare affected integer;
begin
  if requested_message_ids is null or cardinality(requested_message_ids) > 500 then
    raise exception 'invalid support acknowledgement batch';
  end if;
  update bridge_messages
    set status = 'processed', processed_at = now()
    where id = any(requested_message_ids)
      and recipient_id = auth.uid()
      and status = 'claimed'
      and idempotency_key like 'support-v1:%';
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.claim_support_bridge_messages(uuid, integer) from public, anon;
revoke all on function public.ack_support_bridge_messages(uuid[]) from public, anon;
grant execute on function public.claim_support_bridge_messages(uuid, integer) to authenticated;
grant execute on function public.ack_support_bridge_messages(uuid[]) to authenticated;
