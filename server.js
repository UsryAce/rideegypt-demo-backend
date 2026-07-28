const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
// Serve the marketing site (/), rider app (/app) and ops dashboard (/admin)
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'rideegypt-dev-secret-change-in-prod';
const PORT = process.env.PORT || 4000;
// DEV_MODE returns the OTP code in the API response (no SMS bill needed).
// It stays ON until you set the env var DEV_MODE=false AND provide SMS creds.
const DEV_MODE = process.env.DEV_MODE !== 'false';

// ---- Pluggable SMS sender ----
// With no SMS provider configured, this is a no-op and the code is returned
// in the API response (auto-filled in the app). To enable real SMS, set the
// TWILIO_* env vars and flip DEV_MODE=false — no extra npm packages needed
// (calls Twilio's REST API directly via Node's built-in fetch).
async function sendSms(phone, code) {
  const {TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM} = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return false;
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: phone.startsWith('+') ? phone : `+974${phone}`,
        From: TWILIO_FROM,
        Body: `Your Rahal Go verification code is ${code}`,
      }).toString(),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[SMS] Twilio error:', resp.status, err.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[SMS] send failed:', e.message);
    return false;
  }
}

// Normalize Qatari numbers to their 8-digit local form ("+974 5551 2345" -> "55512345")
function normalizePhone(phone) {
  return String(phone || '').replace(/^\+?974/, '').replace(/\D/g, '');
}

// ---- OTP rate limiting (in-memory) ----
// Max 5 OTP requests per phone per 15 minutes, and max 5 wrong verification
// attempts per phone before the code must be re-requested.
const OTP_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_REQUESTS = 5;
const OTP_MAX_ATTEMPTS = 5;
const otpRequests = new Map(); // phone -> [timestamps]
const otpAttempts = new Map(); // phone -> wrong-attempt count

function otpRateLimited(phone) {
  const now = Date.now();
  const times = (otpRequests.get(phone) || []).filter(t => now - t < OTP_WINDOW_MS);
  if (times.length >= OTP_MAX_REQUESTS) {
    otpRequests.set(phone, times);
    return true;
  }
  times.push(now);
  otpRequests.set(phone, times);
  return false;
}

// ---- Auth middleware ----
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({error: 'Missing token'});
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({error: 'Invalid token'});
  }
}

function publicUser(u) {
  if (!u) return null;
  const {id, phone, role, name, email, city, language, rating, walletBalance, createdAt} = u;
  return {id, phone, role, name, email, city, language, rating, walletBalance, createdAt};
}

// ---- Ride types & pricing (QAR) ----
const RIDE_TYPES = [
  {id: 'go', name: 'Go', nameAr: 'جو', description: 'Affordable everyday rides', descriptionAr: 'رحلات يومية بأسعار مناسبة', base: 10, perKm: 1.8, minFare: 20, seats: 4},
  {id: 'comfort', name: 'Comfort', nameAr: 'كمفورت', description: 'Newer cars, top drivers', descriptionAr: 'سيارات أحدث وأفضل السائقين', base: 14, perKm: 2.4, minFare: 28, seats: 4},
  {id: 'family', name: 'Family XL', nameAr: 'عائلي XL', description: 'SUVs and vans for up to 6', descriptionAr: 'سيارات دفع رباعي وفانات حتى ٦ ركاب', base: 18, perKm: 3.2, minFare: 35, seats: 6},
  {id: 'business', name: 'Business', nameAr: 'أعمال', description: 'Premium cars, executive service', descriptionAr: 'سيارات فاخرة وخدمة تنفيذية', base: 30, perKm: 4.5, minFare: 60, seats: 4},
];

const STATUS_AR = {
  scheduled: 'رحلة مجدولة',
  requested: 'تم الطلب',
  matched: 'تم إيجاد سائق',
  arriving: 'السائق في الطريق إليك',
  in_progress: 'الرحلة جارية',
  completed: 'اكتملت الرحلة',
  cancelled: 'أُلغيت الرحلة',
};

function estimateFare(typeId, distanceKm) {
  const type = RIDE_TYPES.find(t => t.id === typeId) || RIDE_TYPES[0];
  const km = Math.max(1, Number(distanceKm) || 5);
  return {
    type: type.name,
    typeId: type.id,
    distanceKm: km,
    price: Math.max(type.minFare, Math.round(type.base + type.perKm * km)),
    currency: 'QAR',
    etaMinutes: Math.max(3, Math.round(km * 1.8)),
  };
}

// ---- Health ----
app.get('/api/health', (req, res) => {
  res.json({ok: true, service: 'Rahal Go API', users: db.data.users.length});
});

// ---- Auth: request OTP ----
app.post('/api/auth/request-otp', async (req, res) => {
  // Qatari mobile numbers are 8 digits (starting 3, 5, 6, or 7), optionally with +974
  const phone = normalizePhone(req.body.phone);
  if (phone.length !== 8 || !'3567'.includes(phone[0])) {
    return res.status(400).json({error: 'Valid Qatari phone number required (8 digits)'});
  }
  if (otpRateLimited(phone)) {
    return res.status(429).json({error: 'Too many OTP requests. Try again in a few minutes.'});
  }
  otpAttempts.delete(phone);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.setOtp(phone, code);
  console.log(`[OTP] ${phone} -> ${code}`);
  // Try to send a real SMS (no-op until Twilio creds are set).
  await sendSms(phone, code);
  // In dev mode we also return the code so the app can auto-fill it (no SMS bill).
  // In production with SMS enabled, set DEV_MODE=false so the code is NOT returned.
  const response = {sent: true, phone};
  if (DEV_MODE) response.devCode = code;
  res.json(response);
});

// ---- Auth: verify OTP ----
app.post('/api/auth/verify-otp', (req, res) => {
  const {code, role} = req.body;
  const phone = normalizePhone(req.body.phone);
  const attempts = otpAttempts.get(phone) || 0;
  if (attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({error: 'Too many wrong attempts. Request a new code.'});
  }
  if (!db.checkOtp(phone, code)) {
    otpAttempts.set(phone, attempts + 1);
    return res.status(400).json({error: 'Invalid or expired code'});
  }
  otpAttempts.delete(phone);
  db.clearOtp(phone);
  let user = db.findUserByPhone(phone);
  let isNew = false;
  if (!user) {
    isNew = true;
    user = db.createUser({phone, role: role || 'rider'});
    // Seed a little demo history so the app feels alive
    db.addTransaction({userId: user.id, icon: 'gift', title: 'Welcome bonus', amount: 25});
    db.updateUser(user.id, {walletBalance: 25});
    user = db.findUserById(user.id);
  }
  const token = jwt.sign({userId: user.id}, JWT_SECRET, {expiresIn: '30d'});
  res.json({token, user: publicUser(user), isNew});
});

// ---- Profile ----
app.get('/api/profile', auth, (req, res) => {
  const user = db.findUserById(req.userId);
  res.json({user: publicUser(user)});
});

app.put('/api/profile', auth, (req, res) => {
  const allowed = ['name', 'email', 'city', 'language'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  const user = db.updateUser(req.userId, patch);
  res.json({user: publicUser(user)});
});

// ---- Wallet ----
app.get('/api/wallet', auth, (req, res) => {
  const user = db.findUserById(req.userId);
  res.json({
    balance: user.walletBalance,
    transactions: db.transactionsForUser(req.userId),
  });
});

app.post('/api/wallet/topup', auth, (req, res) => {
  const amount = Number(req.body.amount) || 0;
  if (amount <= 0) return res.status(400).json({error: 'Invalid amount'});
  const user = db.findUserById(req.userId);
  const newBalance = user.walletBalance + amount;
  db.updateUser(req.userId, {walletBalance: newBalance});
  db.addTransaction({userId: req.userId, icon: 'topup', title: 'Wallet Top-Up', amount});
  res.json({balance: newBalance, transactions: db.transactionsForUser(req.userId)});
});

// ---- Ride types & fare estimate ----
app.get('/api/ride-types', (req, res) => {
  res.json({types: RIDE_TYPES});
});

app.get('/api/rides/estimate', auth, (req, res) => {
  const {type, distanceKm} = req.query;
  res.json({estimate: estimateFare(type, distanceKm)});
});

// ---- Rides ----
const DEMO_DRIVERS = [
  {name: 'Ahmed Al-Kuwari', car: 'Toyota Camry', plate: '248 315', rating: 4.9},
  {name: 'Mohamed Al-Sulaiti', car: 'Nissan Altima', plate: '512 947', rating: 4.8},
  {name: 'Khalid Al-Marri', car: 'Hyundai Sonata', plate: '873 106', rating: 4.7},
  {name: 'Yousef Al-Emadi', car: 'GMC Yukon', plate: '634 758', rating: 4.9},
];

// Attach Arabic status label for the app UI
function rideView(ride) {
  return ride ? {...ride, statusAr: STATUS_AR[ride.status] || ride.status} : null;
}

app.get('/api/rides', auth, (req, res) => {
  res.json({rides: db.ridesForUser(req.userId).map(rideView)});
});

app.post('/api/rides', auth, (req, res) => {
  const {from, to, type, price, paymentMethod, fromLat, fromLng, toLat, toLng, scheduledAt} = req.body;
  const fare = Number(price);
  if (!Number.isFinite(fare) || fare < 0) {
    return res.status(400).json({error: 'Invalid price'});
  }
  // Optional pre-booking: schedule a ride up to 7 days ahead
  let scheduled = null;
  if (scheduledAt) {
    const ts = new Date(scheduledAt).getTime();
    if (!Number.isFinite(ts)) return res.status(400).json({error: 'Invalid scheduledAt date'});
    if (ts < Date.now()) return res.status(400).json({error: 'scheduledAt must be in the future'});
    if (ts > Date.now() + 7 * 24 * 3600 * 1000) {
      return res.status(400).json({error: 'Rides can be scheduled at most 7 days ahead'});
    }
    scheduled = new Date(ts).toISOString();
  }
  const user = db.findUserById(req.userId);
  if (paymentMethod === 'wallet') {
    if (user.walletBalance < fare) {
      return res.status(400).json({error: 'Insufficient wallet balance'});
    }
    db.updateUser(req.userId, {walletBalance: user.walletBalance - fare});
  }
  const driver = DEMO_DRIVERS[Math.floor(Math.random() * DEMO_DRIVERS.length)];
  const ride = db.createRide({
    userId: req.userId,
    from: from || 'West Bay, Doha',
    to: to || 'Hamad International Airport',
    // Default coords: West Bay -> Hamad International Airport
    fromCoords: {lat: Number(fromLat) || 25.3208, lng: Number(fromLng) || 51.531},
    toCoords: {lat: Number(toLat) || 25.2609, lng: Number(toLng) || 51.6138},
    type: type || 'Comfort',
    price: fare,
    paymentMethod: paymentMethod || 'cash',
    driver: driver.name,
    driverInfo: driver,
    status: scheduled ? 'scheduled' : 'matched',
    scheduledAt: scheduled,
  });
  db.addTransaction({
    userId: req.userId,
    icon: 'trip',
    title: `${ride.type} Ride • ${ride.from} → ${ride.to}`,
    amount: -ride.price,
  });
  res.json({ride: rideView(ride)});
});

app.get('/api/rides/:id', auth, (req, res) => {
  const ride = db.findRide(req.params.id, req.userId);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  res.json({ride: rideView(ride)});
});

// ---- Live tracking (simulated) ----
// The demo "trip" plays out in real time from booking:
//   0-30s   matched   (driver assigned)
//   30-120s arriving  (driver drives to the pickup point)
//   120s+   in_progress (pickup -> dropoff over 5 minutes), then completed
const ARRIVE_AT = 30, PICKUP_AT = 120, TRIP_SECONDS = 300;

function lerp(a, b, t) {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

// Pure computation of a ride's live tracking state — shared by the rider
// track endpoint and the admin live-fleet endpoint.
function computeTracking(ride) {
  const from = ride.fromCoords || {lat: 25.3208, lng: 51.531};
  const to = ride.toCoords || {lat: 25.2609, lng: 51.6138};
  // Scheduled rides start their timeline at the scheduled time, not booking time
  const anchor = new Date(ride.scheduledAt || ride.createdAt).getTime();
  const elapsed = (Date.now() - anchor) / 1000;

  let status, progress, driverLocation, etaMinutes;
  if (elapsed < 0) {
    status = 'scheduled';
    progress = 0;
    driverLocation = null;
    etaMinutes = Math.ceil(-elapsed / 60) + Math.ceil(PICKUP_AT / 60);
  } else if (ride.status === 'completed' || elapsed >= PICKUP_AT + TRIP_SECONDS) {
    status = 'completed';
    progress = 1;
    driverLocation = to;
    etaMinutes = 0;
  } else if (elapsed >= PICKUP_AT) {
    status = 'in_progress';
    progress = (elapsed - PICKUP_AT) / TRIP_SECONDS;
    driverLocation = {lat: lerp(from.lat, to.lat, progress), lng: lerp(from.lng, to.lng, progress)};
    etaMinutes = Math.ceil((TRIP_SECONDS - (elapsed - PICKUP_AT)) / 60);
  } else if (elapsed >= ARRIVE_AT) {
    status = 'arriving';
    progress = 0;
    // Driver approaches the pickup point from a nearby offset
    const t = (elapsed - ARRIVE_AT) / (PICKUP_AT - ARRIVE_AT);
    driverLocation = {lat: lerp(from.lat + 0.012, from.lat, t), lng: lerp(from.lng - 0.012, from.lng, t)};
    etaMinutes = Math.ceil((PICKUP_AT - elapsed) / 60);
  } else {
    status = 'matched';
    progress = 0;
    driverLocation = {lat: from.lat + 0.012, lng: from.lng - 0.012};
    etaMinutes = Math.ceil(PICKUP_AT / 60);
  }

  return {
    status,
    statusAr: STATUS_AR[status],
    driverLocation,
    pickup: from,
    dropoff: to,
    progress: Math.round(progress * 100) / 100,
    etaMinutes,
  };
}

// Persist a computed status transition so ride history stays truthful
function persistTransition(ride, tracking) {
  if (tracking.status === ride.status) return ride;
  const patch = {status: tracking.status};
  if (tracking.status === 'completed') patch.completedAt = new Date().toISOString();
  return db.updateRide(ride.id, ride.userId, patch);
}

app.get('/api/rides/:id/track', auth, (req, res) => {
  let ride = db.findRide(req.params.id, req.userId);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  if (ride.status === 'cancelled') {
    return res.json({ride: rideView(ride), tracking: null});
  }
  const tracking = computeTracking(ride);
  ride = persistTransition(ride, tracking);
  res.json({ride: rideView(ride), tracking});
});

app.post('/api/rides/:id/cancel', auth, (req, res) => {
  const ride = db.findRide(req.params.id, req.userId);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  if (ride.status === 'completed' || ride.status === 'cancelled') {
    return res.status(400).json({error: `Ride already ${ride.status}`});
  }
  // Refund wallet payments on cancellation
  if (ride.paymentMethod === 'wallet' && ride.price > 0) {
    const user = db.findUserById(req.userId);
    db.updateUser(req.userId, {walletBalance: user.walletBalance + ride.price});
    db.addTransaction({
      userId: req.userId,
      icon: 'refund',
      title: `Refund • Cancelled ${ride.type} Ride`,
      amount: ride.price,
    });
  }
  const updated = db.updateRide(ride.id, req.userId, {status: 'cancelled'});
  res.json({ride: rideView(updated)});
});

app.post('/api/rides/:id/complete', auth, (req, res) => {
  const ride = db.findRide(req.params.id, req.userId);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  if (ride.status === 'completed' || ride.status === 'cancelled') {
    return res.status(400).json({error: `Ride already ${ride.status}`});
  }
  const updated = db.updateRide(ride.id, req.userId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  res.json({ride: rideView(updated)});
});

app.post('/api/rides/:id/rate', auth, (req, res) => {
  const ride = db.findRide(req.params.id, req.userId);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  if (ride.status !== 'completed') {
    return res.status(400).json({error: 'Only completed rides can be rated'});
  }
  const rating = Number(req.body.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({error: 'Rating must be between 1 and 5'});
  }
  const updated = db.updateRide(ride.id, req.userId, {rating, comment: req.body.comment || ''});
  res.json({ride: rideView(updated)});
});

// ---- Saved places ----
app.get('/api/places', auth, (req, res) => {
  res.json({places: db.placesForUser(req.userId)});
});

app.post('/api/places', auth, (req, res) => {
  const {label, address} = req.body;
  if (!label || !address) {
    return res.status(400).json({error: 'label and address are required'});
  }
  const place = db.addPlace({userId: req.userId, label, address});
  res.json({place, places: db.placesForUser(req.userId)});
});

app.delete('/api/places/:id', auth, (req, res) => {
  if (!db.removePlace(req.params.id, req.userId)) {
    return res.status(404).json({error: 'Place not found'});
  }
  res.json({places: db.placesForUser(req.userId)});
});

// ---- Promo codes ----
// One-time wallet-credit promos (QAR). Add/adjust codes here.
const PROMO_CODES = {
  RAHAL25: {credit: 25, title: 'Promo RAHAL25'},
  WELCOMEQA: {credit: 15, title: 'Promo WELCOMEQA'},
  DOHA10: {credit: 10, title: 'Promo DOHA10'},
};

app.post('/api/promo/redeem', auth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const promo = PROMO_CODES[code];
  if (!promo) return res.status(400).json({error: 'Invalid promo code'});
  if (db.hasRedeemedPromo(req.userId, code)) {
    return res.status(400).json({error: 'Promo code already used'});
  }
  db.redeemPromo(req.userId, code);
  const user = db.findUserById(req.userId);
  const newBalance = user.walletBalance + promo.credit;
  db.updateUser(req.userId, {walletBalance: newBalance});
  db.addTransaction({userId: req.userId, icon: 'gift', title: promo.title, amount: promo.credit});
  res.json({credit: promo.credit, balance: newBalance});
});

// ---- Admin API (ops dashboard) ----
// Protected by a shared key. Set ADMIN_KEY in production.
const ADMIN_KEY = process.env.ADMIN_KEY || 'rahal-admin-dev';

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({error: 'Invalid admin key'});
  next();
}

app.post('/api/admin/login', (req, res) => {
  if ((req.body.key || '') !== ADMIN_KEY) {
    return res.status(401).json({error: 'Invalid admin key'});
  }
  res.json({ok: true});
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const rides = db.data.rides;
  const byStatus = {};
  for (const r of rides) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const revenue = rides.filter(r => r.status === 'completed').reduce((s, r) => s + (r.price || 0), 0);
  const walletTotal = db.data.users.reduce((s, u) => s + (u.walletBalance || 0), 0);
  // Rides per day, last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    days.push({
      date: key,
      rides: rides.filter(r => (r.createdAt || '').slice(0, 10) === key).length,
      revenue: rides.filter(r => r.status === 'completed' && (r.createdAt || '').slice(0, 10) === key)
        .reduce((s, r) => s + (r.price || 0), 0),
    });
  }
  const ratings = rides.filter(r => r.rating).map(r => r.rating);
  res.json({
    users: db.data.users.length,
    ridesTotal: rides.length,
    ridesByStatus: byStatus,
    activeRides: rides.filter(r => ['matched', 'arriving', 'in_progress'].includes(r.status)).length,
    scheduledRides: byStatus.scheduled || 0,
    revenue,
    walletTotal,
    avgRating: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 100) / 100 : null,
    promoRedemptions: db.data.promoRedemptions.length,
    ridesByDay: days,
    currency: 'QAR',
  });
});

app.get('/api/admin/rides', adminAuth, (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const rides = db.data.rides.slice(0, limit).map(r => {
    const u = db.findUserById(r.userId);
    return {...rideView(r), riderPhone: u ? u.phone : null, riderName: u ? u.name : null};
  });
  res.json({rides});
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  res.json({users: db.data.users.map(publicUser)});
});

// Live fleet: every ride currently on the road, with computed positions —
// powers the dashboard's real-time map.
app.get('/api/admin/live', adminAuth, (req, res) => {
  const active = [];
  for (let ride of db.data.rides) {
    if (['completed', 'cancelled'].includes(ride.status)) continue;
    const tracking = computeTracking(ride);
    ride = persistTransition(ride, tracking) || ride;
    if (['completed', 'cancelled'].includes(tracking.status)) continue;
    active.push({
      rideId: ride.id,
      type: ride.type,
      from: ride.from,
      to: ride.to,
      price: ride.price,
      driver: ride.driver,
      ...tracking,
    });
  }
  res.json({fleet: active, count: active.length});
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚕 Rahal Go API running on http://0.0.0.0:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   DEV_MODE=${DEV_MODE} (OTP codes returned in API response)\n`);
});
