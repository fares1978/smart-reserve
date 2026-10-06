# yandex-reserve-bot

Books restaurant tables by driving the Yandex Smart Reserve booking form
(`reservation.yandex.ru/partner-reserve/forms/...`) with Playwright, standing
in for the partner API until Yandex ships one.

**Read [`project.md`](project.md) first** — it covers the architecture, the
CAPTCHA gotchas, deployment and the open issues. This file is just setup.

## How it works

Playwright fills the real form using a persistent browser profile. Each step
tries a known selector first; if it no longer matches (or the read-back check
fails), the page is serialised and **Jev (TypeSafe)** picks the right element,
so a frontend change degrades to "slower" rather than "broken". Before the
irreversible submit click, Jev must confirm the form is complete.

On a CAPTCHA (Yandex SmartCaptcha — distorted Cyrillic text), it tries
**2captcha** first, looping through the 2–3 challenge chains Yandex typically
serves. If that fails for any reason, it falls back to a Telegram alert with a
**live view** link that drops staff straight into the stuck browser tab to
finish it themselves.

The CAPTCHA auto-solving exists because Yandex's own team recommended it as an
interim bridge — see "Why this exists at all" in `project.md` before changing
anything in that area.

`DRY_RUN=true` (the default) fills and verifies the form but never submits.

## Setup

```bash
cp .env.example .env     # fill in every value; see comments in that file
npm install
npx playwright install chromium
npm start
```

In Docker, Chromium is already in the image:

```bash
docker compose up -d --build
```

Required at minimum: `YANDEX_FORM_URL`, `API_KEY`, `DEFAULT_EMAIL`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Add `TYPESAFE_API_KEY` for the Jev
fallback and `TWOCAPTCHA_API_KEY` for CAPTCHA auto-solve — the service still
runs without either, just with less resilience.

## Calling it

```bash
curl -X POST http://localhost:3100/reserve \
  -H "Content-Type: application/json" -H "x-api-key: $API_KEY" \
  -d '{
    "name": "Анна Петрова",
    "phone": "+79991234567",
    "date": "2026-10-25",
    "time": "19:00",
    "guests_count": 2,
    "comment": "день рождения"
  }'
```

Responses match the Remarked n8n webhooks on purpose, so callers handle both
the same way:

```
{ "ok": true,  "status": "created",             "message": "..." }
{ "ok": false, "status": "slot_unavailable",    "message": "...", "alternatives": ["18:30","19:30"] }
{ "ok": false, "status": "needs_manual_action", "message": "..." }
{ "ok": true,  "status": "dry_run",             "message": "..." }
{ "ok": false, "status": "error",               "message": "..." }
```

`GET /slots?date=YYYY-MM-DD` (same auth header) lists the times the form
actually offers that day — a good first call before attempting a booking.
The form requires an e-mail: send `email` or set `DEFAULT_EMAIL`.

## Testing

```bash
npm test     # dry-run suite against the real form; never submits
```

## Wiring into n8n

Point an HTTP Request node at `POST /reserve` with the `x-api-key` header, the
same pattern as the Remarked webhooks.

**Note the timeout.** A CAPTCHA chain can keep the request open for one to two
minutes. Set the node's timeout accordingly, and see "Next steps" #1 in
`project.md` — making this async is the known blocker for live phone use.
