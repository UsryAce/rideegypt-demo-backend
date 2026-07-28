# Rahal Go — Platform

Complete demo platform for Rahal Go, a Qatar 🇶🇦 ride-hailing service. One Node.js/Express
server hosts the API **and** all three web surfaces:

| Surface | URL | What it is |
|---|---|---|
| Marketing website | `/` | Futuristic landing page with 3D animated hero, live ride tiers, EN/AR |
| Rider app | `/app/` | Full booking experience: OTP login, live GPS tracking map, wallet, promos, trips |
| Operations dashboard | `/admin/` | Mission-control: live fleet map, KPIs, charts, rides & riders tables |

Backend: phone + OTP auth with JWT, wallet in QAR with transactions, promo codes, saved
places, scheduled rides, live tracking simulation, and a full ride lifecycle
(book → cancel/complete → rate). Data is stored in a simple JSON file (`data.json`) —
zero native dependencies, deploy anywhere.

## Quick start

```bash
npm install
npm run seed   # optional: fill the platform with a week of demo activity
npm start
# 🚕 Rahal Go API running on http://0.0.0.0:4000
```

The rider app at `/app/` is an installable PWA (manifest + service worker + offline shell) —
on a phone, "Add to Home Screen" gives a standalone full-screen app with its own icon.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `JWT_SECRET` | dev value | Sign/verify JWTs — **set a strong value in production** |
| `DEV_MODE` | `true` | When true, OTP codes are returned in the API response (no SMS needed) |
| `TWILIO_SID` / `TWILIO_TOKEN` / `TWILIO_FROM` | — | Optional: send real OTP SMS via Twilio's REST API (built-in `fetch`, no extra packages). Set these and `DEV_MODE=false` |
| `ADMIN_KEY` | `rahal-admin-dev` | Key for the operations dashboard and `/api/admin/*` — **set a strong value in production** |

## Deploy (Render.com)

The repo includes a `render.yaml` blueprint: in Render choose **New + → Blueprint** and connect
this repo. Render auto-generates `JWT_SECRET` and health-checks `/api/health`.

## API

All authenticated endpoints require `Authorization: Bearer <token>`.

### Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/request-otp` | `{phone}` | Qatari mobile (8 digits, starts 3/5/6/7; `+974` prefix accepted). In dev mode, response includes `devCode`. Rate-limited: 5 requests / phone / 15 min |
| POST | `/api/auth/verify-otp` | `{phone, code, role?}` | Returns `{token, user, isNew}`. New users get a 25 QAR welcome bonus. 5 wrong attempts locks the code until re-requested |

### Profile
| Method | Path | Body |
|---|---|---|
| GET | `/api/profile` | — |
| PUT | `/api/profile` | `{name?, email?, city?, language?}` |

### Wallet & promos
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/wallet` | — | Balance (QAR) + transaction history |
| POST | `/api/wallet/topup` | `{amount}` | Adds funds, records a transaction |
| POST | `/api/promo/redeem` | `{code}` | One-time wallet credit (e.g. `RAHAL25`, `WELCOMEQA`, `DOHA10`) |

### Rides
| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/api/ride-types` | — | Go / Comfort / Family XL / Business with QAR pricing (public) |
| GET | `/api/rides/estimate` | `?type=go&distanceKm=8` | Fare + ETA estimate (respects minimum fare) |
| GET | `/api/rides` | — | User's ride history |
| POST | `/api/rides` | `{from, to, type, price, paymentMethod, scheduledAt?}` | Books a ride; `paymentMethod: "wallet"` debits the wallet. Pass `scheduledAt` (ISO, up to 7 days ahead) to pre-book — the ride stays `scheduled` and its tracking timeline starts at that time |
| GET | `/api/rides/:id` | — | Single ride details |
| GET | `/api/rides/:id/track` | — | Live tracking: simulated driver GPS, phase (`matched → arriving → in_progress → completed`), progress %, ETA. Poll every few seconds from the app |
| POST | `/api/rides/:id/cancel` | — | Cancels; wallet payments are refunded |
| POST | `/api/rides/:id/complete` | — | Marks the ride completed |
| POST | `/api/rides/:id/rate` | `{rating: 1-5, comment?}` | Rate a completed ride |

### Saved places
| Method | Path | Body |
|---|---|---|
| GET | `/api/places` | — |
| POST | `/api/places` | `{label, address}` (e.g. `Home`, `The Pearl, Doha`) |
| DELETE | `/api/places/:id` | — |

### Admin (requires `x-admin-key` header)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/admin/login` | Validate a key: `{key}` → `{ok}` |
| GET | `/api/admin/stats` | KPIs: users, rides by status, revenue, wallet float, avg rating, 7-day ride/revenue series |
| GET | `/api/admin/rides?limit=50` | Recent rides with rider phone/name |
| GET | `/api/admin/users` | All riders |
| GET | `/api/admin/live` | Live fleet: computed GPS position, phase, progress and ETA for every ride on the road |

### Health
`GET /api/health` → `{ok: true, service: "Rahal Go API", users: <count>}`

## Notes

- All amounts are in Qatari Riyal (QAR). Default pickup/dropoff demo values are Doha locations.
- **Arabic support:** ride types include `nameAr`/`descriptionAr`, and every ride response includes
  `statusAr` (e.g. `"السائق في الطريق إليك"`) so the app can render Arabic directly.
- **Tracking simulation:** a booked ride plays out in real time — driver assigned at booking,
  arrives at pickup after ~2 minutes, trip runs ~5 minutes to the dropoff, then auto-completes.
  Booking accepts optional `fromLat/fromLng/toLat/toLng`; defaults are West Bay → Hamad Airport.
- `data.json` is the entire database and is git-ignored. Delete it to reset all data.
- OTPs expire after 5 minutes; JWTs after 30 days.
- On Render's free plan the disk is ephemeral — data resets on redeploys. Fine for a demo;
  swap `db.js` for a real database before going to production.
