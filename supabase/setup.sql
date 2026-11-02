-- Guru Nanak Courier Services: database setup (bookings + tracking)

-- People allowed to use the staff app. Add a row here after creating their login.
create table public.staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null
);

create table public.couriers (
  id bigint generated always as identity primary key,
  name text not null unique,
  trackcourier_slug text,          -- null = no automatic tracking, use the courier's site
  tracking_url text                -- courier's own tracking page
);

create table public.bookings (
  id bigint generated always as identity primary key,
  track_code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id),
  sender_name text not null,
  sender_phone text,
  receiver_name text not null,
  receiver_phone text,
  receiver_city text,
  receiver_pincode text,
  weight_kg numeric(8, 3),
  courier_id bigint not null references public.couriers (id),
  awb text,
  amount numeric(10, 2),
  paid boolean not null default false,
  -- tracking (filled by the "track" function)
  status text not null default 'booked',
  status_detail text,
  last_location text,
  checkpoints jsonb,
  customer_message text,
  last_checked_at timestamptz,
  delivered_at timestamptz
);

create index bookings_courier_id_idx on public.bookings (courier_id);
create index bookings_created_by_idx on public.bookings (created_by);
create index bookings_created_at_idx on public.bookings (created_at desc);
create index bookings_active_idx on public.bookings (last_checked_at nulls first)
  where status not in ('delivered', 'expired') and awb is not null;

-- Row Level Security: only staff can see or change data
alter table public.staff enable row level security;
alter table public.couriers enable row level security;
alter table public.bookings enable row level security;

create policy "staff see own staff row" on public.staff for select
  to authenticated using ((select auth.uid()) = user_id);

create policy "staff read couriers" on public.couriers for select
  to authenticated using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));
create policy "staff manage couriers" on public.couriers for all
  to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create policy "staff manage bookings" on public.bookings for all
  to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

grant select on public.staff to authenticated;
grant select, insert, update, delete on public.couriers, public.bookings to authenticated;

-- Customer tracking page: look up ONE parcel by its secret track code.
-- Security definer on purpose so customers need no login; it returns no names or phone numbers.
create function public.track_parcel(code text)
returns table (
  courier text, awb text, status text, status_detail text,
  last_location text, checkpoints jsonb, tracking_url text, last_checked_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select c.name, b.awb, b.status, b.status_detail, b.last_location, b.checkpoints,
         c.tracking_url, b.last_checked_at
  from public.bookings b join public.couriers c on c.id = b.courier_id
  where b.track_code = upper(trim(code));
$$;
revoke execute on function public.track_parcel(text) from public;
grant execute on function public.track_parcel(text) to anon, authenticated;

-- Starting courier list (edit tracking pages and add your small couriers later)
insert into public.couriers (name, trackcourier_slug, tracking_url) values
  ('DTDC', 'dtdc', 'https://www.dtdc.in/tracking.asp'),
  ('Delhivery', 'delhivery', 'https://www.delhivery.com/tracking'),
  ('Blue Dart', 'bluedart', 'https://www.bluedart.com/tracking'),
  ('India Post / Speed Post', 'speedpost', 'https://www.indiapost.gov.in'),
  ('Xpressbees', 'xpressbees', 'https://www.xpressbees.com/shipment/tracking'),
  ('Ekart', 'ekart', 'https://ekartlogistics.com/track'),
  ('Trackon', 'trackon', 'https://trackon.in'),
  ('Shree Maruti', 'shreemaruti', 'https://www.shreemaruti.com'),
  ('The Professional Couriers', 'professional', 'https://www.tpcindia.com');
