create extension if not exists pgcrypto;

create table if not exists public.family_pairs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  partner_id uuid references auth.users(id) on delete cascade,
  invite_hash text not null,
  created_at timestamptz not null default now(),
  joined_at timestamptz,
  constraint distinct_pair_members check (partner_id is null or partner_id <> owner_id)
);

create table if not exists public.bridge_messages (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references public.family_pairs(id) on delete cascade,
  conversation_id uuid not null,
  sequence_number bigint not null,
  sender_id uuid not null references auth.users(id),
  recipient_id uuid not null references auth.users(id),
  sender_agent text not null check (sender_agent in ('dima', 'katya')),
  encrypted_payload text not null,
  idempotency_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'processed', 'failed')),
  claimed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (conversation_id, sequence_number)
);

create index if not exists bridge_messages_recipient_queue
  on public.bridge_messages(recipient_id, status, created_at);

alter table public.family_pairs enable row level security;
alter table public.bridge_messages enable row level security;

create policy "pair members can read their pair"
  on public.family_pairs for select
  using (auth.uid() = owner_id or auth.uid() = partner_id);

create policy "pair members can read envelopes"
  on public.bridge_messages for select
  using (
    exists (
      select 1 from public.family_pairs p
      where p.id = pair_id and (p.owner_id = auth.uid() or p.partner_id = auth.uid())
    )
  );

create policy "pair members can insert addressed envelopes"
  on public.bridge_messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.family_pairs p
      where p.id = pair_id
        and (p.owner_id = auth.uid() or p.partner_id = auth.uid())
        and (recipient_id = p.owner_id or recipient_id = p.partner_id)
        and recipient_id <> auth.uid()
    )
  );

create or replace function public.create_family_pair(requested_invite_hash text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare created_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  insert into family_pairs(owner_id, invite_hash)
  values (auth.uid(), requested_invite_hash)
  returning id into created_id;
  return created_id;
end;
$$;

create or replace function public.join_family_pair(requested_pair_id uuid, requested_invite_hash text)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  update family_pairs
    set partner_id = auth.uid(), joined_at = now(), invite_hash = gen_random_uuid()::text
    where id = requested_pair_id
      and partner_id is null
      and invite_hash = requested_invite_hash
      and owner_id <> auth.uid();
  if not found then raise exception 'invalid or already used invite'; end if;
  return true;
end;
$$;

create or replace function public.claim_next_bridge_message(requested_pair_id uuid)
returns setof public.bridge_messages
language plpgsql security definer set search_path = public
as $$
begin
  return query
  update bridge_messages m
    set status = 'claimed', claimed_at = now()
    where m.id = (
      select id from bridge_messages
      where pair_id = requested_pair_id and recipient_id = auth.uid() and status = 'pending'
      order by sequence_number
      for update skip locked limit 1
    )
  returning m.*;
end;
$$;

create or replace function public.get_family_pair(requested_pair_id uuid)
returns table(id uuid, owner_id uuid, partner_id uuid)
language sql security definer set search_path = public
as $$
  select p.id, p.owner_id, p.partner_id
  from family_pairs p
  where p.id = requested_pair_id
    and (p.owner_id = auth.uid() or p.partner_id = auth.uid());
$$;

create or replace function public.ack_bridge_message(requested_message_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  update bridge_messages
    set status = 'processed', processed_at = now()
    where id = requested_message_id and recipient_id = auth.uid() and status = 'claimed';
  if not found then raise exception 'message is not claimable by this user'; end if;
  return true;
end;
$$;

grant execute on function public.create_family_pair(text) to authenticated;
grant execute on function public.join_family_pair(uuid, text) to authenticated;
grant execute on function public.claim_next_bridge_message(uuid) to authenticated;
grant execute on function public.ack_bridge_message(uuid) to authenticated;
grant execute on function public.get_family_pair(uuid) to authenticated;

alter publication supabase_realtime add table public.bridge_messages;
