// Demo data seeder — run `npm run seed` (with the server stopped) to fill
// data.json with a lively week of Rahal Go activity: riders, completed and
// rated trips across 7 days, active rides on the road right now, and a
// scheduled pickup. Safe to re-run: it rebuilds demo data from scratch.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const RIDERS = [
  {phone: '55123401', name: 'Fatima Al-Thani', city: 'Doha'},
  {phone: '55123402', name: 'Hassan Al-Mohannadi', city: 'Doha'},
  {phone: '33123403', name: 'Noora Al-Kaabi', city: 'Al Rayyan'},
  {phone: '66123404', name: 'Abdulla Al-Naimi', city: 'Doha'},
  {phone: '77123405', name: 'Maryam Al-Sada', city: 'Lusail'},
  {phone: '55123406', name: 'Jassim Al-Attiyah', city: 'Al Wakrah'},
  {phone: '33123407', name: 'Aisha Al-Malki', city: 'Doha'},
  {phone: '66123408', name: 'Saad Al-Dosari', city: 'Doha'},
];

const ROUTES = [
  {from: 'West Bay, Doha', to: 'Hamad International Airport', f: [25.3208, 51.531], t: [25.2609, 51.6138]},
  {from: 'The Pearl', to: 'Msheireb Downtown', f: [25.369, 51.545], t: [25.286, 51.533]},
  {from: 'Lusail Marina', to: 'Katara Cultural Village', f: [25.375, 51.525], t: [25.359, 51.526]},
  {from: 'Souq Waqif', to: 'Aspire Zone', f: [25.287, 51.533], t: [25.263, 51.442]},
  {from: 'Education City', to: 'West Bay, Doha', f: [25.314, 51.439], t: [25.3208, 51.531]},
  {from: 'Al Sadd', to: 'Doha Festival City', f: [25.28, 51.5], t: [25.398, 51.485]},
  {from: 'Hamad International Airport', to: 'The Pearl', f: [25.2609, 51.6138], t: [25.369, 51.545]},
];

const TYPES = [
  {name: 'Go', min: 20, spread: 40},
  {name: 'Comfort', min: 28, spread: 55},
  {name: 'Family XL', min: 35, spread: 70},
  {name: 'Business', min: 60, spread: 90},
];

const DRIVERS = ['Ahmed Al-Kuwari', 'Mohamed Al-Sulaiti', 'Khalid Al-Marri', 'Yousef Al-Emadi'];

let seq = 0;
function genId() {
  return Date.now().toString(36) + (seq++).toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 5);
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const data = {users: [], rides: [], transactions: [], otps: {}, places: [], promoRedemptions: []};

// Riders (joined over the past month)
for (const r of RIDERS) {
  data.users.push({
    id: genId(), phone: r.phone, role: 'rider', name: r.name, email: '',
    city: r.city, language: Math.random() < 0.5 ? 'Arabic' : 'English',
    rating: 5, walletBalance: 25 + Math.floor(Math.random() * 8) * 25,
    createdAt: new Date(Date.now() - (7 + Math.random() * 23) * 86400000).toISOString(),
  });
  data.transactions.push({id: genId(), userId: data.users.at(-1).id, icon: 'gift', title: 'Welcome bonus', amount: 25, date: data.users.at(-1).createdAt});
}

// A week of completed trips (heavier toward recent days and evenings)
for (let day = 6; day >= 0; day--) {
  const trips = 2 + Math.floor(Math.random() * 3) + (day < 2 ? 2 : 0);
  for (let i = 0; i < trips; i++) {
    const user = pick(data.users);
    const route = pick(ROUTES);
    const type = pick(TYPES);
    const price = type.min + Math.floor(Math.random() * type.spread);
    const created = new Date(Date.now() - day * 86400000 - (2 + Math.random() * 16) * 3600000).toISOString();
    const cancelled = Math.random() < 0.08;
    const ride = {
      id: genId(), userId: user.id, from: route.from, to: route.to,
      fromCoords: {lat: route.f[0], lng: route.f[1]}, toCoords: {lat: route.t[0], lng: route.t[1]},
      type: type.name, price, paymentMethod: Math.random() < 0.4 ? 'wallet' : 'cash',
      driver: pick(DRIVERS), status: cancelled ? 'cancelled' : 'completed',
      createdAt: created, scheduledAt: null,
    };
    if (!cancelled) {
      ride.completedAt = new Date(new Date(created).getTime() + 25 * 60000).toISOString();
      if (Math.random() < 0.75) ride.rating = Math.random() < 0.7 ? 5 : 4;
      data.transactions.push({id: genId(), userId: user.id, icon: 'trip', title: `${ride.type} Ride • ${ride.from} → ${ride.to}`, amount: -price, date: created});
    }
    data.rides.unshift(ride);
  }
}

// Rides on the road right now (visible on the live fleet map)
const activeSpecs = [
  {elapsed: 45, note: 'arriving'},
  {elapsed: 200, note: 'in_progress (early)'},
  {elapsed: 320, note: 'in_progress (late)'},
];
for (const spec of activeSpecs) {
  const user = pick(data.users);
  const route = pick(ROUTES);
  const type = pick(TYPES);
  data.rides.unshift({
    id: genId(), userId: user.id, from: route.from, to: route.to,
    fromCoords: {lat: route.f[0], lng: route.f[1]}, toCoords: {lat: route.t[0], lng: route.t[1]},
    type: type.name, price: type.min + Math.floor(Math.random() * type.spread),
    paymentMethod: 'cash', driver: pick(DRIVERS), status: 'matched',
    createdAt: new Date(Date.now() - spec.elapsed * 1000).toISOString(), scheduledAt: null,
  });
}

// One scheduled pickup for tomorrow morning
{
  const user = pick(data.users);
  const when = new Date(Date.now() + 20 * 3600000).toISOString();
  data.rides.unshift({
    id: genId(), userId: user.id, from: 'The Pearl', to: 'Hamad International Airport',
    fromCoords: {lat: 25.369, lng: 51.545}, toCoords: {lat: 25.2609, lng: 51.6138},
    type: 'Business', price: 95, paymentMethod: 'wallet', driver: pick(DRIVERS),
    status: 'scheduled', createdAt: new Date().toISOString(), scheduledAt: when,
  });
}

// Saved places for a few riders
for (const u of data.users.slice(0, 4)) {
  data.places.push({id: genId(), userId: u.id, label: 'Home', address: pick(['The Pearl', 'Al Sadd', 'Lusail', 'Al Wakrah']), createdAt: u.createdAt});
  data.places.push({id: genId(), userId: u.id, label: 'Work', address: pick(['West Bay, Doha', 'Msheireb Downtown', 'Education City']), createdAt: u.createdAt});
}

fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
console.log(`Seeded ${data.users.length} riders, ${data.rides.length} rides (${data.rides.filter(r => r.status === 'matched').length} on the road, 1 scheduled), ${data.transactions.length} transactions.`);
console.log('Start the server with `npm start` — the dashboard will be alive.');
