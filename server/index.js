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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

function formatDateRuDMY(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const p = iso.split('-');
  if (p.length !== 3) return iso;
  const [y, m, d] = p;
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

/** @param {string|number} chatId */
async function tgSendMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN не задан — уведомления в Telegram отключены');
    return { skipped: true };
  }
  if (chatId == null || chatId === '') return { skipped: true };
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const msg = data.description || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

async function notifyAdminsNewOrder(order) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const lines = order.items
    .map((i) => `• ${i.name} × ${i.qty} — ${i.price * i.qty} ₽`)
    .join('\n');
  const when = order.meetingDate
    ? `${formatDateRuDMY(order.meetingDate)}, ${order.meetingTime}`
    : `${order.meetingAddress}, время ${order.meetingTime}`;
  const text =
    `🔔 Новый заказ №${order.orderNumber}\n\n` +
    `Покупатель: ${order.telegramUsername}\n` +
    `TG user id: ${order.clientTelegramUserId || 'не указан'}\n` +
    `${when}\n` +
    `Итого: ${order.total} ₽\n\n` +
    lines;
  for (const adminId of adminIds) {
    try {
      await tgSendMessage(adminId, text);
    } catch (e) {
      console.error('Telegram админу', adminId, e.message);
    }
  }
}

async function notifyBuyerOrderConfirmed(order) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const uid = order.clientTelegramUserId;
  if (!uid) return;
  const when = order.meetingDate
    ? `${formatDateRuDMY(order.meetingDate)} в ${order.meetingTime}`
    : `${order.meetingAddress}, ${order.meetingTime}`;
  const text =
    `✅ Ваш заказ №${order.orderNumber} принят.\n\n` +
    `Администратор подтвердил заказ. Встреча: ${when}.\n` +
    `Спасибо за заказ!`;
  try {
    await tgSendMessage(uid, text);
  } catch (e) {
    console.error('Telegram покупателю', uid, e.message);
  }
}

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
  const {
    items,
    meetingTime,
    telegramUsername,
    meetingAddress,
    clientTelegramUserId,
    meetingYear,
    meetingMonth,
    meetingDay,
  } = body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'empty_items' });
  }
  const tg = typeof telegramUsername === 'string' ? telegramUsername.trim() : '';
  const time = typeof meetingTime === 'string' ? meetingTime.trim() : '';
  const y = Math.floor(Number(meetingYear));
  const mo = Math.floor(Number(meetingMonth));
  const d = Math.floor(Number(meetingDay));
  if (!time || !tg || !Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    return res.status(400).json({ error: 'invalid_meeting_date' });
  }
  const check = new Date(y, mo - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) {
    return res.status(400).json({ error: 'invalid_meeting_date' });
  }
  const meetingDate = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

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
    meetingDate,
    meetingYear: y,
    meetingMonth: mo,
    meetingDay: d,
    meetingAddress: meetingAddress || 'Адрес встречи',
    telegramUsername: tg,
    clientTelegramUserId: clientTelegramUserId != null ? String(clientTelegramUserId) : null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };

  orders.unshift(order);
  saveOrders(orders);
  res.json({ order });

  notifyAdminsNewOrder(order).catch((e) => console.error('notifyAdminsNewOrder', e));
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
  if (o.status === 'confirmed') {
    return res.json({ order: o });
  }
  o.status = 'confirmed';
  o.confirmedAt = new Date().toISOString();
  saveOrders(orders);
  res.json({ order: o });

  notifyBuyerOrderConfirmed(o).catch((e) => console.error('notifyBuyerOrderConfirmed', e));
});

app.listen(PORT, () => {
  console.log(`NAKUR API слушает порт ${PORT}, статика: ${parentDir}`);
});
