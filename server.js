const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'rideegypt-dev-secret-change-in-prod';
const PORT = process.env.PORT || 4000;
// DEV_MODE returns the OTP code in the API response (no SMS bill needed).
// It stays ON until you set the env var DEV_MODE=false AND provide SMS creds.
const DEV_MODE = process.env.DEV_MODE !== 'false';

// ---- Pluggable SMS sender ----
// With no SMS provider configured, this is a no-op and the code is returned
// in the API response (auto-filled in the app). To enable real SMS, set the
// TWILIO_* env vars and `npm i twilio`, then flip DEV_MODE=false.
async function sendSms(phone, code) {
  const {TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM} = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return false;
  try {
    const twilio = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
    await twilio.messages.create({
      to: phone.startsWith('+') ? phone : `+974${phone}`,
      from: TWILIO_FROM,
      body: `Your Rahal Go verification code is ${code}`,
    });
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
  {id: 'go', name: 'Go', description: 'Affordable everyday rides', base: 10, perKm: 1.8, minFare: 20, seats: 4},
  {id: 'comfort', name: 'Comfort', description: 'Newer cars, top drivers', base: 14, perKm: 2.4, minFare: 28, seats: 4},
  {id: 'family', name: 'Family XL', description: 'SUVs and vans for up to 6', base: 18, perKm: 3.2, minFare: 35, seats: 6},
  {id: 'business', name: 'Business', description: 'Premium cars, executive service', base: 30, perKm: 4.5, minFare: 60, seats: 4},
];

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
  if (!db.checkOtp(phone, code)) {
    return res.status(400).json({error: 'Invalid or expired code'});
  }
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

app.get('/api/rides', auth, (req, res) => {
  res.json({rides: db.ridesForUser(req.userId)});
});

app.post('/api/rides', auth, (req, res) => {
  const {from, to, type, price, paymentMethod} = req.body;
  const fare = Number(price);
  if (!Number.isFinite(fare) || fare < 0) {
    return res.status(400).json({error: 'Invalid price'});
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
    type: type || 'Comfort',
    price: fare,
    paymentMethod: paymentMethod || 'cash',
    driver: driver.name,
    driverInfo: driver,
    status: 'matched',
  });
  db.addTransaction({
    userId: req.userId,
    icon: 'trip',
    title: `${ride.type} Ride • ${ride.from} → ${ride.to}`,
    amount: -ride.price,
  });
  res.json({ride});
});

app.get('/api/rides/:id', auth, (req, res) => {
  const ride = db.findRide(req.params.id, req.userId);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  res.json({ride});
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
  res.json({ride: updated});
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
  res.json({ride: updated});
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
  res.json({ride: updated});
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚕 Rahal Go API running on http://0.0.0.0:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   DEV_MODE=${DEV_MODE} (OTP codes returned in API response)\n`);
});
