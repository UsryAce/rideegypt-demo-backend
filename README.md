# Rahal Go — Backend API

Node.js/Express backend for the Rahal Go ride-hailing app (Qatar 🇶🇦). Phone + OTP auth with JWT,
wallet in QAR with transactions, promo codes, saved places, and a full ride lifecycle
(book → cancel/complete → rate). Data is stored in a simple JSON file (`data.json`) —
zero native dependencies, deploy anywhere.

## Quick start

```bash
npm install
npm start
# 🚕 Rahal Go API running on http://0.0.0.0:4000
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `JWT_SECRET` | dev value | Sign/verify JWTs — **set a strong value in production** |
| `DEV_MODE` | `true` | When true, OTP codes are returned in the API response (no SMS needed) |
| `TWILIO_SID` / `TWILIO_TOKEN` / `TWILIO_FROM` | — | Optional: send real OTP SMS via Twilio (`npm i twilio`, then set `DEV_MODE=false`) |

## Deploy (Render.com)

The repo includes a `render.yaml` blueprint: in Render choose **New + → Blueprint** and connect
this repo. Render auto-generates `JWT_SECRET` and health-checks `/api/health`.

## API

All authenticated endpoints require `Authorization: Bearer <token>`.

### Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/request-otp` | `{phone}` | Qatari mobile (8 digits, starts 3/5/6/7; `+974` prefix accepted). In dev mode, response includes `devCode` |
| POST | `/api/auth/verify-otp` | `{phone, code, role?}` | Returns `{token, user, isNew}`. New users get a 25 QAR welcome bonus |

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
| POST | `/api/rides` | `{from, to, type, price, paymentMethod}` | Books a ride; `paymentMethod: "wallet"` debits the wallet |
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
