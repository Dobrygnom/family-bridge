create table if not exists public.compute_providers (
  provider_id uuid primary key references auth.users(id) on delete cascade,
  public_key text not null check (length(public_key) between 32 and 256 and public_key ~ '^[A-Za-z0-9_-]+$'),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.default_compute_provider (
  singleton boolean primary key default true check (singleton),
  provider_id uuid not null references auth.users(id) on delete restrict
);

insert into public.default_compute_provider(singleton, provider_id)
values (true, 'a1f0192b-8695-4f48-939f-7adcd78ed9b7')
on conflict (singleton) do update set provider_id = excluded.provider_id;

create table if not exists public.compute_connection_requests (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references auth.users(id) on delete cascade,
  requester_id uuid not null references auth.users(id) on delete cascade,
  requester_public_key text not null check (length(requester_public_key) between 32 and 256 and requester_public_key ~ '^[A-Za-z0-9_-]+$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  response_payload text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint approved_request_has_response check (status <> 'approved' or response_payload is not null)
);

create index if not exists compute_connection_requests_provider_queue
  on public.compute_connection_requests(provider_id, status, created_at);
create index if not exists compute_connection_requests_requester
  on public.compute_connection_requests(requester_id, created_at desc);

alter table public.compute_providers enable row level security;
alter table public.default_compute_provider enable row level security;
alter table public.compute_connection_requests enable row level security;

create policy "compute provider can read its registration"
  on public.compute_providers for select
  using (provider_id = auth.uid());

create policy "compute requests are visible only to their endpoints"
  on public.compute_connection_requests for select
  using (requester_id = auth.uid() or provider_id = auth.uid());

create or replace function public.register_default_compute_provider(requested_public_key text, requested_enabled boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare expected_provider uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select provider_id into expected_provider from default_compute_provider where singleton = true;
  if expected_provider is null or auth.uid() <> expected_provider then raise exception 'not the default compute provider'; end if;
  if requested_public_key is null or length(requested_public_key) not between 32 and 256 or requested_public_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'invalid provider public key';
  end if;
  insert into compute_providers(provider_id, public_key, enabled, updated_at)
  values (auth.uid(), requested_public_key, requested_enabled, now())
  on conflict (provider_id) do update
    set public_key = excluded.public_key, enabled = excluded.enabled, updated_at = now();
  return true;
end;
$$;

create or replace function public.request_default_compute_provider(requested_public_key text)
returns table(id uuid, requester_id uuid, requester_public_key text, provider_public_key text, status text, response_payload text, created_at timestamptz, decided_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare target_provider uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  -- Serialize requests per authenticated client. This prevents two startup or
  -- retry calls from racing past the lookup and creating duplicate channels.
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  if requested_public_key is null or length(requested_public_key) not between 32 and 256 or requested_public_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'invalid requester public key';
  end if;
  select p.provider_id into target_provider
    from default_compute_provider d join compute_providers p on p.provider_id = d.provider_id
    where d.singleton = true and p.enabled = true;
  if target_provider is null then raise exception 'trusted computer is not accepting connections'; end if;
  if target_provider = auth.uid() then raise exception 'provider cannot request itself'; end if;
  if (select count(*) from compute_connection_requests r where r.requester_id = auth.uid() and r.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too many connection requests';
  end if;
  return query
    select r.id, r.requester_id, r.requester_public_key, p.public_key, r.status, r.response_payload, r.created_at, r.decided_at
    from compute_connection_requests r join compute_providers p on p.provider_id = r.provider_id
    where r.requester_id = auth.uid() and r.provider_id = target_provider and r.status in ('pending', 'approved')
    order by r.created_at desc limit 1;
  if found then return; end if;
  return query
    with inserted as (
      insert into compute_connection_requests(provider_id, requester_id, requester_public_key)
      values (target_provider, auth.uid(), requested_public_key)
      returning *
    )
    select r.id, r.requester_id, r.requester_public_key, p.public_key, r.status, r.response_payload, r.created_at, r.decided_at
    from inserted r join compute_providers p on p.provider_id = r.provider_id;
end;
$$;

create or replace function public.get_compute_connection_request(requested_request_id uuid)
returns table(id uuid, requester_id uuid, requester_public_key text, provider_public_key text, status text, response_payload text, created_at timestamptz, decided_at timestamptz)
language sql security definer set search_path = public
as $$
  select r.id, r.requester_id, r.requester_public_key, p.public_key, r.status, r.response_payload, r.created_at, r.decided_at
  from compute_connection_requests r join compute_providers p on p.provider_id = r.provider_id
  where r.id = requested_request_id and r.requester_id = auth.uid();
$$;

create or replace function public.list_compute_connection_requests()
returns table(id uuid, requester_id uuid, requester_public_key text, provider_public_key text, status text, response_payload text, created_at timestamptz, decided_at timestamptz)
language sql security definer set search_path = public
as $$
  select r.id, r.requester_id, r.requester_public_key, p.public_key, r.status, r.response_payload, r.created_at, r.decided_at
  from compute_connection_requests r join compute_providers p on p.provider_id = r.provider_id
  where r.provider_id = auth.uid() and r.status = 'pending'
  order by r.created_at asc limit 100;
$$;

create or replace function public.decide_compute_connection_request(requested_request_id uuid, requested_approved boolean, requested_response_payload text default null)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if requested_approved and (requested_response_payload is null or length(requested_response_payload) > 16384) then
    raise exception 'approved request requires a bounded encrypted response';
  end if;
  update compute_connection_requests
    set status = case when requested_approved then 'approved' else 'rejected' end,
        response_payload = case when requested_approved then requested_response_payload else null end,
        decided_at = now()
    where id = requested_request_id and provider_id = auth.uid() and status = 'pending';
  if not found then raise exception 'request is not pending for this provider'; end if;
  return true;
end;
$$;

revoke all on public.compute_providers from anon, authenticated;
revoke all on public.default_compute_provider from anon, authenticated;
revoke all on public.compute_connection_requests from anon, authenticated;
revoke all on function public.register_default_compute_provider(text, boolean) from public, anon;
revoke all on function public.request_default_compute_provider(text) from public, anon;
revoke all on function public.get_compute_connection_request(uuid) from public, anon;
revoke all on function public.list_compute_connection_requests() from public, anon;
revoke all on function public.decide_compute_connection_request(uuid, boolean, text) from public, anon;
grant select on public.compute_providers to authenticated;
grant select on public.compute_connection_requests to authenticated;
grant execute on function public.register_default_compute_provider(text, boolean) to authenticated;
grant execute on function public.request_default_compute_provider(text) to authenticated;
grant execute on function public.get_compute_connection_request(uuid) to authenticated;
grant execute on function public.list_compute_connection_requests() to authenticated;
grant execute on function public.decide_compute_connection_request(uuid, boolean, text) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.compute_connection_requests;
exception when duplicate_object then null;
end $$;
