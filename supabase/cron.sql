-- APPLIED to project guru-nanak-courier on 2026-10-30 (migration "schedule_tracking_checks").
-- Checks all active parcels at 9:00 and 18:00 India time (03:30 and 12:30 UTC).
-- Needs a Vault secret named cron_secret, equal to the CRON_SECRET Edge Function secret.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://vsnmwkfczhwqvqyjmqfz.supabase.co', 'project_url');

select cron.schedule(
  'track-active-parcels',
  '30 3,12 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/track',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
