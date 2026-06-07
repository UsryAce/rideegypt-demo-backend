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
      to: phone.startsWith('+') ? phone : `+2${phone}`,
      from: TWILIO_FROM,
      body: `Your Ride Egypt verification code is ${code}`,
    });
    return true;
  } catch (e) {
    console.error('[SMS] send failed:', e.message);
    return false;
  }
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

// ---- Health ----
app.get('/api/health', (req, res) => {
  res.json({ok: true, service: 'RideEgypt API', users: db.data.users.length});
});

// ---- Auth: request OTP ----
app.post('/api/auth/request-otp', async (req, res) => {
  const {phone} = req.body;
  if (!phone || phone.length < 8) {
    return res.status(400).json({error: 'Valid phone number required'});
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
  const {phone, code, role} = req.body;
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
    db.addTransaction({userId: user.id, icon: 'gift', title: 'Welcome bonus', amount: 30});
    db.updateUser(user.id, {walletBalance: 30});
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

// ---- Rides ----
app.get('/api/rides', auth, (req, res) => {
  res.json({rides: db.ridesForUser(req.userId)});
});

app.post('/api/rides', auth, (req, res) => {
  const {from, to, type, price, paymentMethod} = req.body;
  const user = db.findUserById(req.userId);
  if (paymentMethod === 'wallet') {
    if (user.walletBalance < price) {
      return res.status(400).json({error: 'Insufficient wallet balance'});
    }
    db.updateUser(req.userId, {walletBalance: user.walletBalance - price});
  }
  const ride = db.createRide({
    userId: req.userId,
    from: from || 'Maadi, Cairo',
    to: to || 'Cairo International Airport',
    type: type || 'Comfort',
    price: Number(price) || 0,
    driver: 'Ahmed Hassan',
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚕 RideEgypt API running on http://0.0.0.0:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   DEV_MODE=${DEV_MODE} (OTP codes returned in API response)\n`);
});
