// Dry-run against the REAL form (never submits: DRY_RUN is forced on).
//   node test/run.js                 known selectors only
//   MOCK_JEV=1 DISABLE_KNOWN=true node test/run.js   route every step through a mock Jev
// Telegram is blanked so a failed run can't message anyone.
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DRY_RUN = 'true';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reserve-test-'));
process.env.PROFILE_DIR = path.join(process.env.DATA_DIR, 'profile');
require('dotenv').config();
process.env.DRY_RUN = 'true';

// Stand-in for Jev: keyword-match the step description against element lines.
// Verifies the plumbing (snapshot -> ids -> locator -> cache), not Jev's quality.
const RULES = [
  [/first name/i, /name=first_name/], [/last name/i, /name=last_name/], [/phone/i, /name=phone/],
  [/e-mail/i, /name=email/], [/wishes/i, /name=wishes/], [/"\+"/, /ui-counter-plus/], [/"−"/, /ui-counter-minus/],
  [/Забронировать/, /text="Забронировать"/], [/reservation date field/i, /value="\d\d\.\d\d\.\d{4}"/],
];
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { questions } = JSON.parse(body);
        const answers = {};
        for (const [k, q] of Object.entries(questions)) {
          if (q.type === 'noul') answers[k] = { type: 'noul', noul: 0.95 };
          else {
            const rule = RULES.find(([d]) => d.test(q.instructions));
            const hit = rule && Object.entries(q.criteria).find(([id, line]) => id !== 'none' && rule[1].test(line));
            answers[k] = { type: 'choice', choice: hit ? hit[0] : 'none', confidence: hit ? 0.95 : 0.2, probabilities: {} };
          }
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ answers }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

(async () => {
  let srv;
  if (process.env.MOCK_JEV) {
    srv = await startMock();
    process.env.JEV_URL = `http://127.0.0.1:${srv.address().port}`;
    process.env.TYPESAFE_API_KEY = 'mock';
  }
  const { attemptReservation, listSlots } = require('../src/browser');
  // Must match the restaurant's own timezone (see src/browser.js), not Moscow.
  const tz = process.env.RESTAURANT_TIMEZONE || 'Europe/Kaliningrad';
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const plus = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
  const base = { name: 'Тест Тестов', phone: '+79991234567', guests_count: 4, comment: 'ТЕСТ, не готовить', email: 'test@example.com' };

  const cases = [
    ['evening slot, default date', { ...base, date: iso(today), time: '19:00', guests_count: 2 }],
    ['other day, 4 guests, day slot', { ...base, date: plus(3), time: '13:00' }],
    ['next month', { ...base, date: plus(40), time: '18:30' }],
    ['unoffered slot', { ...base, date: iso(today), time: '03:15' }],
  ];
  let failed = 0;
  for (const [label, d] of cases) {
    if (process.env.DISABLE_KNOWN === 'true' && label !== cases[0][0]) continue; // mock can't pick calendar arrows
    const r = await attemptReservation(d);
    const expected = label === 'unoffered slot' ? 'slot_unavailable' : 'dry_run';
    const pass = r.status === expected;
    if (!pass) failed++;
    console.log(pass ? 'PASS' : 'FAIL', label, '->', r.status, r.message || '', r.alternatives ? `(offered: ${r.alternatives.join(' ')})` : '');
  }
  console.log('slots today:', JSON.stringify(await listSlots(iso(today))));
  console.log('decision log:', path.join(process.env.DATA_DIR, 'decisions.log'));
  if (srv) srv.close();
  process.exit(failed ? 1 : 0);
})();
