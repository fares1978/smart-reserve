require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { attemptReservation, listSlots } = require('./browser');
const { SerialQueue } = require('./queue');

const app = express();
app.use(express.json());

const queue = new SerialQueue({
  minDelayMs: Number(process.env.RESERVE_MIN_DELAY_MS || 5000),
  maxDelayMs: Number(process.env.RESERVE_MAX_DELAY_MS || 12000),
});

// Shared-secret auth for the n8n / ElevenLabs caller. Refuses to run open
// unless API_KEY is explicitly left empty AND ALLOW_NO_AUTH=true (local dev).
function auth(req, res, next) {
  const key = process.env.API_KEY;
  if (!key) {
    if (process.env.ALLOW_NO_AUTH === 'true') return next();
    return res.status(503).json({ ok: false, status: 'error', message: 'Server has no API_KEY configured.' });
  }
  const got = Buffer.from(String(req.get('x-api-key') || ''));
  const want = Buffer.from(key);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ ok: false, status: 'error', message: 'Unauthorized.' });
  }
  next();
}

const bad = (res, message) => res.status(400).json({ ok: false, status: 'error', message });

// Same shape as the Remarked n8n webhooks, on purpose: {ok, status, message}.
app.post('/reserve', auth, async (req, res) => {
  const { name, phone, date, time, guests_count, comment, email } = req.body || {};
  if (!name || !phone || !date || !time || !guests_count) return bad(res, 'Missing required field.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'date must be YYYY-MM-DD.');
  if (!/^\d{2}:\d{2}$/.test(time)) return bad(res, 'time must be HH:MM.');
  const guests = Number(guests_count);
  if (!Number.isInteger(guests) || guests < 1 || guests > 30) return bad(res, 'guests_count must be an integer 1-30.');
  const mail = email || process.env.DEFAULT_EMAIL;
  if (!mail) return bad(res, 'The form requires an e-mail: send "email" or set DEFAULT_EMAIL.');

  try {
    const result = await queue.enqueue(() =>
      attemptReservation({ name, phone, date, time, guests_count: guests, comment: comment || '', email: mail })
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, status: 'error', message: String(err && err.message ? err.message : err) });
  }
});

// Read-only: which slots does the form offer on a date?
app.get('/slots', auth, async (req, res) => {
  const { date } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return bad(res, 'date must be YYYY-MM-DD.');
  try {
    res.json(await queue.enqueue(() => listSlots(String(date))));
  } catch (err) {
    res.status(500).json({ ok: false, status: 'error', message: String(err && err.message ? err.message : err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 3100);
app.listen(port, () => console.log(`yandex-reserve-bot listening on :${port}`));
