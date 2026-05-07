const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const parentDir = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '5809093672')
  .split(',')
  .map((s) => String(s.trim()))
  .filter(Boolean);

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.error('orders load error', e);
  }
  return [];
}

function saveOrders(list) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('orders save error', e);
  }
}

let orders = loadOrders();

function isAdminHeader(req) {
  const uid = req.headers['x-telegram-user-id'];
  if (uid == null || uid === '') return false;
  return adminIds.includes(String(uid));
}

function generateOrderNumber() {
  const used = new Set(orders.map((o) => String(o.orderNumber)));
  for (let attempt = 0; attempt < 80; attempt++) {
    const n = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    if (!used.has(n)) return n;
  }
  return String(Date.now() % 1000).padStart(3, '0');
}

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '512kb' }));

app.use(express.static(parentDir, { index: 'index.html' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const { items, meetingTime, telegramUsername, meetingAddress, clientTelegramUserId } = body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'empty_items' });
  }
  const tg = typeof telegramUsername === 'string' ? telegramUsername.trim() : '';
  const time = typeof meetingTime === 'string' ? meetingTime.trim() : '';
  if (!time || !tg) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const normalizedItems = items.map((i) => ({
    id: String(i.id ?? ''),
    name: String(i.name ?? ''),
    price: Number(i.price ?? 0),
    qty: Math.max(0, Math.floor(Number(i.qty ?? 0))),
  }));

  if (normalizedItems.some((i) => !i.qty || i.price < 0)) {
    return res.status(400).json({ error: 'invalid_items' });
  }

  const total = normalizedItems.reduce((sum, i) => sum + i.price * i.qty, 0);

  const order = {
    id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    orderNumber: generateOrderNumber(),
    status: 'processing',
    items: normalizedItems,
    total,
    meetingTime: time,
    meetingAddress: meetingAddress || 'Адрес встречи',
    telegramUsername: tg,
    clientTelegramUserId: clientTelegramUserId != null ? String(clientTelegramUserId) : null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  orders.unshift(order);
  saveOrders(orders);
  res.json({ order });
});

app.get('/api/orders/my', (req, res) => {
  const telegram = String(req.query.telegram || '').trim().toLowerCase();
  const userId = req.query.userId != null ? String(req.query.userId) : '';

  const mine = orders.filter((o) => {
    const ot = (o.telegramUsername || '').toLowerCase();
    if (telegram && ot === telegram) return true;
    if (userId && o.clientTelegramUserId && String(o.clientTelegramUserId) === userId) return true;
    return false;
  });

  res.json({ orders: mine });
});

app.get('/api/orders/admin', (req, res) => {
  if (!isAdminHeader(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ orders: [...orders] });
});

app.patch('/api/orders/:orderId/confirm', (req, res) => {
  if (!isAdminHeader(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const id = req.params.orderId;
  const o = orders.find((x) => x.id === id);
  if (!o) {
    return res.status(404).json({ error: 'not_found' });
  }
  o.status = 'confirmed';
  o.confirmedAt = new Date().toISOString();
  saveOrders(orders);
  res.json({ order: o });
});

app.listen(PORT, () => {
  console.log(`NAKUR API слушает порт ${PORT}, статика: ${parentDir}`);
});
