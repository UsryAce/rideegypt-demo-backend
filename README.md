# Rahal Go — Backend API

Node.js/Express backend for the Rahal Go ride-hailing app (Egypt). Phone + OTP auth with JWT,
wallet with transactions, and a full ride lifecycle (book → cancel/complete → rate).
Data is stored in a simple JSON file (`data.json`) — zero native dependencies, deploy anywhere.

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
| POST | `/api/auth/request-otp` | `{phone}` | Sends OTP. In dev mode, response includes `devCode` |
| POST | `/api/auth/verify-otp` | `{phone, code, role?}` | Returns `{token, user, isNew}`. New users get a 30 EGP welcome bonus |

### Profile
| Method | Path | Body |
|---|---|---|
| GET | `/api/profile` | — |
| PUT | `/api/profile` | `{name?, email?, city?, language?}` |

### Wallet
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/wallet` | — | Balance + transaction history |
| POST | `/api/wallet/topup` | `{amount}` | Adds funds, records a transaction |

### Rides
| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/api/ride-types` | — | Available ride types with EGP pricing (public) |
| GET | `/api/rides/estimate` | `?type=go&distanceKm=8` | Fare + ETA estimate |
| GET | `/api/rides` | — | User's ride history |
| POST | `/api/rides` | `{from, to, type, price, paymentMethod}` | Books a ride; `paymentMethod: "wallet"` debits the wallet |
| GET | `/api/rides/:id` | — | Single ride details |
| POST | `/api/rides/:id/cancel` | — | Cancels; wallet payments are refunded |
| POST | `/api/rides/:id/complete` | — | Marks the ride completed |
| POST | `/api/rides/:id/rate` | `{rating: 1-5, comment?}` | Rate a completed ride |

### Health
`GET /api/health` → `{ok: true, service: "Rahal Go API", users: <count>}`

## Notes

- `data.json` is the entire database and is git-ignored. Delete it to reset all data.
- OTPs expire after 5 minutes; JWTs after 30 days.
- On Render's free plan the disk is ephemeral — data resets on redeploys. Fine for a demo;
  swap `db.js` for a real database before going to production.
