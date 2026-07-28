// Simple JSON-file database — zero native dependencies, runs on any Node version.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const defaultData = {
  users: [], // {id, phone, role, name, email, city, language, rating, walletBalance, createdAt}
  rides: [], // {id, userId, from, to, type, price, status, driver, rating, createdAt}
  transactions: [], // {id, userId, icon, title, amount, date}
  otps: {}, // phone -> {code, expiresAt}
  places: [], // {id, userId, label, address, createdAt}
  promoRedemptions: [], // {userId, code, date}
};

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('DB load error:', e.message);
  }
  return JSON.parse(JSON.stringify(defaultData));
}

let data = load();
// Backfill collections added after the DB file was first created
for (const key of Object.keys(defaultData)) {
  if (!(key in data)) data[key] = JSON.parse(JSON.stringify(defaultData[key]));
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  data,
  save,
  genId,

  // Users
  findUserByPhone(phone) {
    return data.users.find(u => u.phone === phone);
  },
  findUserById(id) {
    return data.users.find(u => u.id === id);
  },
  createUser(user) {
    const u = {
      id: genId(),
      phone: user.phone,
      role: user.role || 'rider',
      name: user.name || 'New User',
      email: user.email || '',
      city: user.city || 'Doha',
      language: user.language || 'English',
      rating: 5.0,
      walletBalance: 0,
      createdAt: new Date().toISOString(),
    };
    data.users.push(u);
    save();
    return u;
  },
  updateUser(id, patch) {
    const user = data.users.find(x => x.id === id);
    if (!user) return null;
    Object.assign(user, patch);
    save();
    return user;
  },

  // OTP
  setOtp(phone, code) {
    data.otps[phone] = {code, expiresAt: Date.now() + 5 * 60 * 1000};
    save();
  },
  checkOtp(phone, code) {
    const o = data.otps[phone];
    if (!o) return false;
    if (Date.now() > o.expiresAt) return false;
    return o.code === code;
  },
  clearOtp(phone) {
    delete data.otps[phone];
    save();
  },

  // Rides
  createRide(ride) {
    const r = {id: genId(), createdAt: new Date().toISOString(), status: 'requested', ...ride};
    data.rides.unshift(r);
    save();
    return r;
  },
  ridesForUser(userId) {
    return data.rides.filter(r => r.userId === userId);
  },
  findRide(id, userId) {
    return data.rides.find(r => r.id === id && r.userId === userId);
  },
  updateRide(id, userId, patch) {
    const ride = data.rides.find(r => r.id === id && r.userId === userId);
    if (!ride) return null;
    Object.assign(ride, patch);
    save();
    return ride;
  },

  // Saved places
  placesForUser(userId) {
    return data.places.filter(p => p.userId === userId);
  },
  addPlace(place) {
    const p = {id: genId(), createdAt: new Date().toISOString(), ...place};
    data.places.push(p);
    save();
    return p;
  },
  removePlace(id, userId) {
    const i = data.places.findIndex(p => p.id === id && p.userId === userId);
    if (i === -1) return false;
    data.places.splice(i, 1);
    save();
    return true;
  },

  // Promo redemptions
  hasRedeemedPromo(userId, code) {
    return data.promoRedemptions.some(r => r.userId === userId && r.code === code);
  },
  redeemPromo(userId, code) {
    data.promoRedemptions.push({userId, code, date: new Date().toISOString()});
    save();
  },

  // Transactions
  addTransaction(tx) {
    const t = {id: genId(), date: new Date().toISOString(), ...tx};
    data.transactions.unshift(t);
    save();
    return t;
  },
  transactionsForUser(userId) {
    return data.transactions.filter(t => t.userId === userId);
  },
};
