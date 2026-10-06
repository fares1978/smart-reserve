# Yandex Smart Reserve automation — developer handoff

## What this is

An HTTP service that books restaurant tables by driving the public Yandex
Smart Reserve booking form in a real browser (Playwright). Smart Reserve has
no public API yet, so this stands in for one until Yandex ships theirs
(promised around end of 2026 — see "Why this exists at all").

It is called by n8n / an ElevenLabs voice agent the same way an API would be:

```
POST /reserve   → books a table
GET  /slots     → lists the times the form offers on a date
GET  /health
```

**Scope is create-only, deliberately.** No availability check against existing
bookings, no cancel, no modify — Smart Reserve exposes no way to query or
manage bookings without a full account session and a lot more UI navigation.

## Status

**Working end to end in production**, including fully automated CAPTCHA
solving. A booking was created automatically on 2026-09-26 with a
three-challenge CAPTCHA chain solved without human involvement.

The human fallback (Telegram alert + live browser view) remains in place for
anything the automation can't finish, and is tested and working.

### Verified
- Form filling: guest count, date (incl. month navigation), time slots
  (incl. День/Вечер tabs), all guest fields, each with read-back checks
- Jev (TypeSafe) pre-submit gate and element-location fallback
- Real submission and success detection
- CAPTCHA detection → 2captcha auto-solve → booking completes
- CAPTCHA detection → Telegram alert → staff resolve via noVNC live view
- Deployed on a VPS behind Caddy with automatic HTTPS

### Known gaps
- **Latency is unacceptable for live calls.** A CAPTCHA chain took ~78s, and
  `/reserve` holds the HTTP connection open throughout. See "Next steps" #1.
- **`PANEL_TIME_OFFSET_MINUTES` is a workaround with an open question** — see
  the caveat in `.env.example`. Nobody has confirmed whether Yandex sends
  guests a confirmation that would show the shifted (wrong) time.
- **A CAPTCHA appeared on essentially every submission** during development.
  The rate from a different IP or a warmed-up profile is unknown.
- Only Russian (+7) phone numbers are handled; others raise and hand off.
- 2captcha solves maybe 40–60% of individual challenges, and chains compound
  that. Expect the human fallback to still be used regularly.

## Why this exists at all (important context)

The client is an established Yandex partner in direct contact with Yandex
reps, who know automation is being used ahead of their official API.

**The CAPTCHA auto-solving via 2captcha was recommended by Yandex's own team**
as an interim bridge until that API ships. This matters: the project
originally and deliberately ruled out defeating CAPTCHAs, and only reversed
that position after Yandex suggested it. That recommendation was **verbal,
with no written record** — worth getting in writing if it's ever questioned.

If you extend this: using a commercial vision/LLM API to solve CAPTCHAs is
prohibited by essentially every such provider's terms (Anthropic, OpenAI and
Google included), independent of Yandex's position. 2captcha is a dedicated
solving service, which is a different thing contractually.

## Architecture

```
src/index.js      Express: POST /reserve, GET /slots, x-api-key auth, validation
src/browser.js    Persistent Playwright context, attempt flow, handoff, success reporting
src/form.js       Widget drivers, pre-submit gate, outcome detection, CAPTCHA solving
src/resolver.js   known selector → Jev fallback → selector cache
src/snapshot.js   Serialises the page to compact text for Jev
src/jev.js        TypeSafe/Jev client
src/twocaptcha.js 2captcha image-to-text client
src/queue.js      Serial queue + randomised delay between bookings
src/telegram.js   Alerts (success, CAPTCHA handoff, failure)
src/log.js        JSONL decision log (deliberately no guest PII)
test/run.js       Dry-run suite against the real form
```

### The Jev layer

Every element lookup goes through `resolver.js`: try a known CSS selector
first, and if it misses (or the action's read-back check fails), serialise the
page and ask **Jev** (TypeSafe's decision model) to pick the right element from
the visible candidates. Successful Jev picks are cached as selectors.

The intent is that when Yandex changes the frontend, this degrades to "slower"
rather than "broken". Verified by disabling known selectors entirely — Jev
picked all seven form fields at 0.92–0.99 confidence.

Jev also gates the irreversible submit click and classifies the post-submit
screen.

**Jev confidence is noisy — do not trust single readings.** Observed: correct,
complete forms scoring anywhere from 0.62 to 0.91; the confirmation screen
reading "success" five times consecutively at 0.66–0.74. Two separate bugs came
from single-shot thresholds set too high on small samples. Where it matters,
the code now requires *several consecutive* moderate readings (the streak logic
in `browser.js`) rather than one confident one.

## The CAPTCHA path

Yandex uses **Yandex SmartCaptcha** — a distorted-Cyrillic-text image with a
text answer box. On detection:

1. Wait for the challenge to actually render (gotcha #1)
2. Screenshot the challenge image
3. Send to 2captcha with `languagePool: "rn"` (gotcha #2)
4. Type the answer, click «Отправить»
5. If a CAPTCHA is still present, loop — **chains of 2–3 are normal**
6. On success, confirm the booking; otherwise fall through to the human handoff

### Gotchas that cost a full night of debugging

**1. Detection fires before the challenge is visible.** `.smart-captcha` is
the *invisible* pre-check wrapper (`smart-captcha_invisible`, containing a
`display:none` iframe) and exists before any challenge renders. Screenshotting
on that signal captured a blank form with a spinner — workers were being asked
to read a page with no CAPTCHA on it. The code now waits for the «Отправить»
control to exist as proof the modal is rendered, *then* captures.

**2. `languagePool: "rn"` is essential.** The challenges are Russian words and
2captcha's default worker pool is English-speaking. Before this setting: 1–7
character garbage answers and constant `ERROR_CAPTCHA_UNSOLVABLE`. After:
16–18 character answers and a three-challenge chain solved on the first try.
This single parameter was the difference between "never works" and "works".

**3. The success regex missed the real confirmation screen.** It actually says
just «Ваше бронирование» followed by booking details — none of the words the
original pattern required. This reported a *completed* booking as needing
manual action, which risks staff double-booking. Fixed, but take care editing
`SUCCESS_TEXT` in `form.js`.

**4. This site renders controls as styled `<div>`s, not `<button>`s.**
`getByRole('button')` silently finds nothing — true for the time slots and for
the CAPTCHA's submit control. Match on visible text and use `safeClick`, which
falls back to a coordinate click when a wrapper intercepts the event.

### The 2captcha account itself

The service is 2captcha (Russian-language interface: rucaptcha.com). The API
key goes in `TWOCAPTCHA_API_KEY`. Account-level settings that matter:

| Setting | Use | Why |
|---|---|---|
| **Защита ключа по IP** | **Enable**, set to the server IP | The key is useless to anyone who obtains it from anywhere else. Worth doing regardless. |
| **Ограничение цены** | **Enable**, low cap | Protects against a runaway retry bug burning the balance. Real volume is a few solves a day. |
| **SandBox** | **Must be OFF** | Returns fake placeholder answers. Every solve will silently fail in a confusing way if this is on. |
| **100% Распознавание** | Leave off (for now) | Buys accuracy via multi-worker consensus, at higher cost and **more latency**. Our failures were timeouts, not wrong answers, so it targets the wrong problem. Revisit only if logs show repeated `twocaptcha_captcha_still_present` right after successful solves — that would mean genuinely wrong answers. |
| **Настройки распознавания** | Leave default | The code sends `case` and `languagePool` per request, which take priority. |
| **Pingback** | Leave off | Would push results to a webhook instead of us polling. Not worth exposing another public endpoint at this volume. |

**Keep the balance funded.** A zero balance produces a confusing failure mode:
`createTask` succeeds, but no worker ever picks the task up, so it looks
exactly like a timeout. If solves start timing out consistently, check the
balance before debugging anything in the code.

### Reading the logs when a solve fails

Everything lands in `decisions.log` (and `docker compose logs`). The useful
signals, in order of what they tell you:

- `twocaptcha_solved_image` with `textLength` — **the fastest health check.**
  These challenges are ~16–18 character Russian words. Answers of 1–7
  characters mean workers can't read what we sent (wrong pool, or a bad
  capture), not that the CAPTCHA is hard.
- `twocaptcha_no_challenge_rendered` — the modal never appeared within 15s
- `twocaptcha_captcha_still_present` — answer rejected, *or* the next
  challenge in a chain. Indistinguishable from here, and handled the same way.
- `ERROR_CAPTCHA_UNSOLVABLE` — a worker looked and gave up; usually means the
  captured image is unreadable
- `2captcha solve timed out` — nobody picked it up (check the balance)

Set `CAPTCHA_DIAGNOSTIC=true` to save exactly what gets sent to 2captcha into
`/data/twocaptcha-sent-*.png`. That is the fastest way to settle "is our
capture wrong or is the solve wrong" — it was what finally identified both
real bugs. Those images contain guest details, so turn it off afterwards.

## Deployment

Runs as a Docker container on a VPS, behind Caddy for automatic HTTPS.

```bash
# first time
cp .env.example .env     # then fill in every key
docker compose up -d --build

# updating
rsync -av --exclude node_modules --exclude .profile --exclude data \
      --exclude .env ./ root@SERVER:/opt/reserve/
ssh root@SERVER 'cd /opt/reserve && docker compose up -d --build --force-recreate'
```

`HEADLESS=false` runs a headed browser under Xvfb, exposed via noVNC on :6080
for the live-view handoff. Caddy puts that behind basic auth + TLS; **never
expose 6080 directly** — it is a logged-in browser.

### Operational notes
- Data (`decisions.log`, selector cache, screenshots) lives in a **Docker
  volume at `/data`**, not a host path: `docker compose exec reserve ls /data`
- `DRY_RUN=true` fills and verifies but never submits — the safe default
- Every real booking sends a Telegram message, success or failure

## API

```bash
curl -X POST https://your-host/reserve \
  -H "Content-Type: application/json" -H "x-api-key: $API_KEY" \
  -d '{"name":"Анна Петрова","phone":"+79991234567","date":"2026-10-25",
       "time":"19:00","guests_count":4,"comment":"день рождения",
       "email":"optional@example.com"}'
```

`email` falls back to `DEFAULT_EMAIL`. The response shape matches the existing
Remarked n8n webhooks on purpose, so callers can treat both the same:

| status | meaning |
|---|---|
| `created` | Booked |
| `slot_unavailable` | Includes `alternatives` with the times actually offered |
| `needs_manual_action` | CAPTCHA/unknown state; staff alerted via Telegram |
| `dry_run` | Filled and verified, not submitted (`DRY_RUN=true`) |
| `error` | Anything else |

`GET /slots?date=YYYY-MM-DD` returns the offered times — a good first call for
a voice agent before attempting a booking.

## Next steps, in priority order

1. **Make `/reserve` async.** This is the blocker for live phone use. A CAPTCHA
   chain can take one to two minutes while the HTTP request hangs. Return
   `pending` immediately with a booking id, keep solving in the background, and
   notify by webhook/Telegram when done. Everything else here is tuning; this
   is architectural.
2. **Get Yandex to clarify the partner-panel +1h display**, which would let
   `PANEL_TIME_OFFSET_MINUTES` go back to 0 and remove a workaround that may be
   showing guests the wrong time.
3. **Measure the real CAPTCHA rate** from production traffic (real guests,
   spread through a day) rather than rapid identical test bookings. All testing
   so far hit a CAPTCHA every time, which may be an artifact of hammering the
   form from one datacenter IP.
4. **Ask Yandex about an allowlist or partner session** that skips the consumer
   anti-bot check. A bigger lever than any solver tuning.
5. **Rotate the credentials** in `.env` — they were shared in plain text during
   development.
6. When the official API arrives, only the code behind `/reserve` changes; the
   URL and response contract stay, so n8n and ElevenLabs don't.

## The bigger picture

This is the second of several reservation-system integrations behind a common
interface, so different ElevenLabs voice agents can call the same shape of tool
regardless of the backend:

1. **Remarked** — real REST/JSON-RPC API, in production, full CRUD
2. **Yandex Smart Reserve** (this) — no API, browser automation, create-only
3. More systems later, each with its own adapter
