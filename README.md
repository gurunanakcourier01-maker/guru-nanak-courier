# Guru Nanak Courier Services

Office software and customer portal for an international courier booking counter.

- `app/` — the website (published to GitHub Pages)
  - `index.html` — staff office: dashboard, bookings, quotes, customers, GST billing, vendor rates, settings, AI chat
  - `portal.html` — customer portal: own parcels, bills, booking requests, AI chat
  - `track.html` — public parcel tracking by code
  - `print.html` — 4×6 labels and GST tax invoices
- `supabase/` — database setup and server functions (tracking, AI assistant, customer invites)

Data lives in Supabase (protected by row-level security); this repository contains no rates, customers or keys.
The only key in `app/config.js` is Supabase's publishable key, which is safe to be public.
