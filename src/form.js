const jev = require('./jev');
const { snapshot, toState } = require('./snapshot');
const { act, resolve, safeClick, firstVisible, NeedsHuman } = require('./resolver');
const { log, dataDir } = require('./log');

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Thrown when the requested date/time can't be booked (as opposed to the
// automation failing). Maps to status "slot_unavailable" for the caller.
class SlotUnavailable extends Error {
  constructor(message, alternatives = []) {
    super(message);
    this.alternatives = alternatives;
  }
}

// ---------- text fields ----------

const digits = (s) => String(s || '').replace(/\D/g, '');

function nationalRuNumber(phone) {
  const d = digits(phone);
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) return d.slice(1);
  if (d.length === 10) return d;
  throw new NeedsHuman('Only Russian (+7) phone numbers are automated; this one needs manual entry.');
}

// A blind .fill() sets the value in one shot with no keystrokes at all — a
// clear bot signature to any fraud-scoring system. Type character-by-character
// with jittered timing instead, like every real field on this form should.
async function humanType(loc, value) {
  for (const ch of String(value)) {
    await loc.pressSequentially(ch, { delay: 25 + Math.floor(Math.random() * 90) });
  }
}

async function fillText(page, key, describe, known, value, { same = (a, b) => a === b } = {}) {
  await act(page, { key, describe, known }, async (loc) => {
    await pause(150 + Math.floor(Math.random() * 350)); // brief "reading/moving to field" pause
    await safeClick(loc);
    await loc.fill('');
    await humanType(loc, value);
    return same(await loc.inputValue(), value); // read back — never trust a blind fill
  });
}

// ---------- guests counter ----------

async function readCounter(plus) {
  for (const up of ['..', '../..']) {
    const text = await plus.locator(`xpath=${up}`).innerText().catch(() => '');
    const m = text.match(/\d+/);
    if (m) return Number(m[0]);
  }
  return null;
}

async function setGuests(page, want) {
  const plusT = { key: 'guests_plus', describe: 'the "+" button that increases the number of guests', known: ['[data-testid="ui-counter-plus"]'] };
  const minusT = { key: 'guests_minus', describe: 'the "−" button that decreases the number of guests', known: ['[data-testid="ui-counter-minus"]'] };
  const plus = await resolve(page, plusT);
  if (!plus) throw new NeedsHuman('Could not find the guests counter.');
  let cur = await readCounter(plus.locator);
  if (cur === null) throw new NeedsHuman('Could not read the guests counter.');
  if (cur === want) return;
  const minus = cur > want ? await resolve(page, minusT) : null;
  if (cur > want && !minus) throw new NeedsHuman('Could not find the guests "−" button.');
  for (let i = 0; i < 40 && cur !== want; i++) {
    await safeClick(cur < want ? plus.locator : minus.locator);
    await pause(120);
    const next = await readCounter(plus.locator);
    if (next === cur && i > 3) break; // stuck at the venue's min/max
    cur = next;
  }
  if (cur !== want) throw new SlotUnavailable(`Party of ${want} is not accepted by this form (stuck at ${cur}).`);
}

// ---------- date ----------

const dateField = { key: 'date_field', describe: 'the (read-only) reservation date field that opens a calendar', known: ['input[readonly]'] };

async function shownMonth(page) {
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.toLowerCase().match(new RegExp(`(${MONTHS.join('|')})\\s*(\\d{4})`));
  return m ? { month: MONTHS.indexOf(m[1]), year: Number(m[2]) } : null;
}

async function setDate(page, iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  const wanted = `${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}.${y}`;

  const field = await resolve(page, dateField);
  if (!field) throw new NeedsHuman('Could not find the date field.');
  if ((await field.locator.inputValue()) === wanted) return;
  await safeClick(field.locator);
  await pause(600);

  for (let i = 0; i < 14; i++) {
    const shown = await shownMonth(page);
    if (!shown) throw new NeedsHuman('Calendar did not open or its month could not be read.');
    const diff = (y - shown.year) * 12 + (mo - 1 - shown.month);
    if (diff === 0) break;
    const nav = await resolve(page, {
      key: diff > 0 ? 'cal_next' : 'cal_prev',
      describe: `the button that moves the open calendar to the ${diff > 0 ? 'next' : 'previous'} month`,
      known: [(p) => (diff > 0 ? p.locator('[class*="calendarHeader"] button').last() : p.locator('[class*="calendarHeader"] button').first())],
    });
    if (!nav) throw new NeedsHuman('Could not navigate the calendar.');
    await safeClick(nav.locator);
    await pause(250);
  }

  // Adjacent-month days are shown greyed in the grid: days >= 20 appear once
  // as leading days of the previous month (first) and once in-month (last);
  // days <= 8 the reverse. Pick accordingly, otherwise ask Jev.
  await act(
    page,
    {
      key: 'cal_day',
      describe: `the calendar cell for day ${d} of the displayed month (not a greyed-out day of an adjacent month)`,
      known: [(p) => { const c = p.locator('.rdp-month_grid').getByText(String(d), { exact: true }); return d >= 20 ? c.last() : c.first(); }],
      itemFilter: (it) => it.text === String(d),
    },
    async (loc) => {
      await safeClick(loc);
      return true;
    }
  );

  await act(
    page,
    { key: 'cal_apply', describe: 'the button that confirms/applies the selected date in the calendar', known: [(p) => p.getByRole('button', { name: 'Применить' })] },
    async (loc) => {
      await safeClick(loc);
      await pause(500);
      return (await field.locator.inputValue()) === wanted;
    }
  ).catch(() => {
    throw new SlotUnavailable(`Date ${iso} could not be selected (it may be closed or outside the booking window).`);
  });
}

// ---------- time slots ----------

async function visibleSlots(page) {
  const all = await page.getByText(/^\d{2}:\d{2}$/).allInnerTexts();
  return [...new Set(all.map((t) => t.trim()))];
}

async function clickPeriodTab(page, name) {
  const tab = await firstVisible(page.getByText(name, { exact: true }));
  if (!tab) return false;
  await safeClick(tab);
  await pause(400);
  return true;
}

async function readSlots(page) {
  const found = new Set(await visibleSlots(page));
  for (const tab of ['День', 'Вечер']) {
    if (await clickPeriodTab(page, tab)) (await visibleSlots(page)).forEach((s) => found.add(s));
  }
  return [...found].sort();
}

async function setTime(page, time) {
  const pick = async () => {
    const slot = await firstVisible(page.getByText(time, { exact: true }));
    if (!slot) return false;
    await safeClick(slot);
    return true;
  };
  if (await pick()) return;
  for (const tab of ['День', 'Вечер']) {
    if ((await clickPeriodTab(page, tab)) && (await pick())) return;
  }
  // Not offered by name — let Jev double-check the visible slots before we
  // declare it unavailable (the markup for slots may have changed).
  const r = await resolve(page, {
    key: 'time_slot',
    describe: `the time slot button labelled ${time}`,
    known: [],
    itemFilter: (it) => it.text === time,
    minConf: 0.9,
  });
  if (r) {
    await safeClick(r.locator);
    return;
  }
  throw new SlotUnavailable(`No ${time} slot is offered on this date.`, await readSlots(page));
}

// ---------- pre-submit gate & outcome ----------

// The submit click is the one irreversible action, so Jev gets to veto it.
async function readyToSubmit(page, details) {
  const snap = await snapshot(page);
  const empty = snap.items.filter((it) => it.flags.includes('required') && ['input', 'textarea'].includes(it.tag) && !it.value);
  if (empty.length) return { ok: false, reason: `Required fields still empty: ${empty.map((e) => e.label || e.name).join(', ')}` };
  if (snap.errors.length) return { ok: false, reason: `Form shows errors: ${snap.errors.join(' | ')}` };
  if (!jev.available()) return { ok: true, via: 'deterministic' };

  try {
    const answers = await jev.ask(toState(snap, { withItems: true }), {
      form_ready: {
        type: 'noul',
        instructions:
          'In the ELEMENTS list, every element flagged "required" has a non-empty value, ' +
          'the value of each field matches its label (a person\'s name in the name field, a phone number in the phone field, an e-mail address in the e-mail field), ' +
          'and there are no VISIBLE ERRORS.',
      },
      slot_selected: { type: 'noul', instructions: `The time slot ${details.time} is shown as selected/highlighted, and no other time slot is.` },
    });
    const ready = answers.form_ready ? answers.form_ready.noul : 0;
    const slot = answers.slot_selected ? answers.slot_selected.noul : 0;
    log({ event: 'jev_gate', form_ready: ready, slot_selected: slot });
    // Calibrated on the live form: correct fills scored 0.87-0.89, wrong ones (value in
    // the wrong field / empty) 0.05-0.48. 0.75 sits mid-gap; re-check if the form changes.
    // Calibrated originally on just 2 correct-fill samples (0.87, 0.89) vs.
    // deliberately-wrong ones (0.05-0.48) — 0.75 seemed like a safe midpoint.
    // Real-world runs later scored correct fills as low as 0.62, so 0.75 was
    // rejecting legitimate submissions. 0.55 keeps clear margin above the
    // highest observed wrong-fill score (0.48) without that false-reject risk.
    // This check is also belt-and-suspenders: each field was already verified
    // by an exact read-back right after typing it, in fillText().
    if (ready < Number(process.env.SUBMIT_MIN_CONF || 0.55)) return { ok: false, reason: `Jev could not confirm the form is complete (form_ready=${ready}).` };
    if (slot < Number(process.env.SLOT_MIN_CONF || 0.7)) return { ok: false, reason: 'Jev could not confirm the requested time slot is selected.' };
    return { ok: true, via: 'jev' };
  } catch (err) {
    log({ event: 'jev_error', key: 'gate', error: err.message });
    return { ok: true, via: 'deterministic' }; // field values were already read back individually
  }
}

const CAPTCHA_DOM = 'iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]';
const CAPTCHA_TEXT = /я не робот|подтвердите,? что вы не робот|not a robot/i;
// "Ваше бронирование" is what the real confirmation screen actually says --
// a heading followed by the booking details, with none of the words the
// original guess required nearby. Confirmed on two successful bookings.
// That miss cost a real success: the booking went through, the regex didn't
// match, and we reported needs_manual_action for a completed reservation.
const SUCCESS_TEXT = /ваше бронирование|(бронирование|заявка|стол)[^.]{0,40}(подтвержд|отправлен|принят|создан|забронирован)|спасибо за бронь/i;

// exposeRaw: return Jev's raw choice/confidence even below the normal 0.8
// bar, for callers (the long-running handoff watcher) that apply their own,
// looser-but-smoothed acceptance rule instead of trusting a single read.
// One-time diagnostic: capture what the CAPTCHA actually is (provider,
// site key, markup) so a real 2captcha integration can be built against real
// data instead of guesses. Remove once that integration exists and is wired
// against a confirmed provider. Guarded by CAPTCHA_DIAGNOSTIC=true so it
// doesn't run/log in normal operation.
async function captureCaptchaDiagnostic(page) {
  try {
    const info = await page.evaluate(() => {
      const els = [...document.querySelectorAll('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]')];
      const sitekeyAttrs = ['data-sitekey', 'data-site-key', 'data-key', 'data-callback'];
      return {
        globals: ['grecaptcha', 'hcaptcha', 'smartCaptcha', 'smartcaptcha', 'ysc', 'turnstile'].filter((g) => g in window),
        elements: els.slice(0, 5).map((e) => ({
          tag: e.tagName,
          src: e.getAttribute('src') || '',
          attrs: Object.fromEntries(sitekeyAttrs.map((a) => [a, e.getAttribute(a)]).filter(([, v]) => v)),
          outerHTML: e.outerHTML.slice(0, 800),
        })),
      };
    });
    log({ event: 'captcha_diagnostic', info });
  } catch (err) {
    log({ event: 'captcha_diagnostic_error', error: err.message });
  }
}

// count() matches ANY element in the DOM regardless of visibility. Caught a
// real bug from this: the CAPTCHA container apparently exists (hidden, still
// animating/loading in) before the actual widget is shown, so a plain count()
// check fired "captcha" — and took its screenshot, and looked for the image
// to solve — before there was anything on screen to see at all.
async function visibleCaptchaContainer(page) {
  const matches = page.locator(CAPTCHA_DOM);
  const n = await matches.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const loc = matches.nth(i);
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function captchaVisible(page) {
  return Boolean(await visibleCaptchaContainer(page));
}

async function detectOutcome(page, { useJev, exposeRaw = false } = {}) {
  const domVisible = await captchaVisible(page);
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (domVisible || CAPTCHA_TEXT.test(text)) {
    if (process.env.CAPTCHA_DIAGNOSTIC === 'true') await captureCaptchaDiagnostic(page);
    return { outcome: 'captcha', via: 'deterministic' };
  }
  if (SUCCESS_TEXT.test(text)) return { outcome: 'success', via: 'deterministic' };

  if (useJev && jev.available()) {
    try {
      const snap = await snapshot(page);
      const { state } = await jev
        .ask(toState(snap, { withItems: true, extra: 'The booking form was just submitted. What is on screen now?' }), {
          state: {
            type: 'choice',
            instructions: 'What state is the page in after submitting the reservation form?',
            criteria: {
              success: 'A confirmation that the reservation was created/accepted',
              captcha: 'A CAPTCHA or "I am not a robot" check is blocking the submission',
              validation_error: 'The form is still shown with a validation error',
              loading: 'Still loading or submitting, nothing conclusive yet',
              unknown: 'Anything else / cannot tell',
            },
          },
        })
        .then((a) => ({ state: a.state }));
      log({ event: 'jev_outcome', choice: state.choice, confidence: state.confidence });
      if (exposeRaw) return { outcome: state.choice, via: 'jev', confidence: state.confidence };
      if (state.confidence >= 0.8 && !['loading', 'unknown'].includes(state.choice)) return { outcome: state.choice, via: 'jev' };
    } catch (err) {
      log({ event: 'jev_error', key: 'outcome', error: err.message });
    }
  }
  return { outcome: 'pending' };
}

async function waitForOutcome(page, timeoutMs) {
  const start = Date.now();
  let lastJev = 0;
  while (Date.now() - start < timeoutMs) {
    const useJev = Date.now() - start > 2500 && Date.now() - lastJev > 3000;
    if (useJev) lastJev = Date.now();
    const r = await detectOutcome(page, { useJev });
    if (r.outcome !== 'pending') return r;
    await pause(800);
  }
  return { outcome: 'timeout' };
}

// ---------- the whole flow ----------

function splitName(name) {
  const parts = String(name).trim().split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

async function fillReservationForm(page, d) {
  await setGuests(page, Number(d.guests_count));
  await setDate(page, d.date);
  await setTime(page, d.time);

  const { first, last } = splitName(d.name);
  await fillText(page, 'first_name', 'the guest first name input (label "Имя")', ['input[name="first_name"]'], first);
  if (last) await fillText(page, 'last_name', 'the guest last name input (label "Фамилия")', ['input[name="last_name"]'], last);

  const national = nationalRuNumber(d.phone);
  await fillText(page, 'phone', 'the guest phone number input (label "Телефон")', ['input[name="phone"]'], national, {
    same: (got, want) => digits(got).endsWith(want),
  });
  await fillText(page, 'email', 'the guest e-mail input (label "E-mail")', ['input[name="email"]'], d.email);
  if (d.comment) await fillText(page, 'wishes', 'the free-text booking wishes/comment textarea (label "Пожелания к брони")', ['textarea[name="wishes"]'], d.comment);
}

const submitTarget = {
  key: 'submit',
  describe: 'the primary button that submits/confirms the reservation ("Забронировать")',
  known: [(p) => p.getByRole('button', { name: 'Забронировать' })],
  minConf: 0.9,
};

async function submit(page) {
  await act(page, submitTarget, async (loc) => {
    await safeClick(loc);
    return true;
  });
}

// ---------- 2captcha auto-solve (Yandex's own recommended interim bridge) ----------

const twocaptcha = require('./twocaptcha');

// Order matters here, and getting it wrong cost most of a night: WAIT for
// the challenge to render (proved by its "Отправить" control existing),
// THEN screenshot. detectOutcome fires on `.smart-captcha`, which is the
// invisible pre-check wrapper present before any challenge appears, so
// capturing on that signal sent workers a blank form with a spinner.
//
// The capture is deliberately the same full-page screenshot the Telegram
// alert uses -- that one looked correct only because handoff() runs later,
// once the modal has rendered. Same call, right moment.
//
// Loops until the overall deadline (SmartCaptcha serves 2-3 challenges in a
// row, and a wrong answer yields a fresh one). Returns true only once the
// CAPTCHA is actually gone. Any failure returns false so the caller falls
// through to the human handoff -- this never throws, by design.
async function solveCaptchaWithTwoCaptcha(page) {
  if (!process.env.TWOCAPTCHA_API_KEY) return false;

  // Bounded by an OVERALL deadline, not 3 independent per-attempt timeouts --
  // a human resolves this in ~7s once alerted (observed via the live view),
  // so auto-solve must never make the caller wait longer than that fallback
  // would take anyway. Default budget: 45s total across every retry.
  const overallDeadline = Date.now() + Number(process.env.TWOCAPTCHA_MAX_TOTAL_MS || 45000);
  const perSolveTimeout = Number(process.env.TWOCAPTCHA_SOLVE_TIMEOUT_MS || 30000);

  for (let attempt = 1; Date.now() < overallDeadline; attempt++) {
    try {
      // Wait for the CHALLENGE ITSELF, not the invisible pre-check wrapper.
      // detectOutcome fires as soon as `.smart-captcha` exists, but the
      // diagnostic showed that element is `smart-captcha_invisible` with a
      // display:none iframe -- it's present before any challenge renders.
      // Screenshotting on that signal captured a blank form with a spinner
      // and no CAPTCHA at all, which is what workers were being asked to
      // read (hence 1-5 character guesses and UNSOLVABLE). The Telegram
      // screenshot looked right only because handoff() runs minutes later,
      // by which time the modal has rendered -- same call, later moment.
      //
      // The "Отправить" control is the reliable proof the modal is actually
      // on screen, and it's needed anyway, so find it FIRST and capture after.
      let scope = null;
      let submit = null;
      const challengeUntil = Date.now() + 15000;
      while (Date.now() < challengeUntil && !submit) {
        const candidateScopes = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
        for (const s of candidateScopes) {
          const cand = await firstVisible(s.getByText(/^\s*(отправить|submit)\s*$/i)).catch(() => null);
          if (cand) {
            scope = s;
            submit = cand;
            break;
          }
        }
        if (!submit) await pause(500);
      }
      if (!submit) {
        log({ event: 'twocaptcha_no_challenge_rendered', attempt });
        return false;
      }
      await pause(500); // let the image finish painting

      // Now capture. Prefer the challenge image alone: ImageToTextTask
      // expects a small captcha (~250x100), and a 1366x900 page with the
      // captcha as a small region gets poor reads. Locating the <img> only
      // works now because the modal is confirmed rendered above -- earlier
      // attempts searched before it existed and found nothing.
      let buf;
      const challengeImg = await firstVisible(scope.locator('img')).catch(() => null);
      if (challengeImg) {
        buf = await challengeImg.screenshot();
      } else {
        buf = await page.screenshot({ fullPage: true }); // same as the Telegram capture
        log({ event: 'twocaptcha_img_not_found_using_fullpage', attempt });
      }
      // Save exactly what we send, for inspection if something's still off.
      if (process.env.CAPTCHA_DIAGNOSTIC === 'true') {
        const path = require('path').join(dataDir(), `twocaptcha-sent-${Date.now()}.png`);
        require('fs').writeFileSync(path, buf);
        log({ event: 'twocaptcha_image_saved', path });
      }
      const remaining = overallDeadline - Date.now();
      const text = await twocaptcha.solveImage(buf.toString('base64'), {
        timeoutMs: Math.max(5000, Math.min(perSolveTimeout, remaining)),
        comment: 'Введите текст с картинки (русские буквы).',
      });
      log({ event: 'twocaptcha_solved_image', attempt, textLength: text.length });

      // scope/submit were resolved above, before the screenshot.
      const inFrame = scope !== page;

      let input = null;
      if (inFrame) {
        // Inside the widget's own frame there is exactly one text field.
        input = await firstVisible(scope.locator('input[type="text"], input:not([type])'));
      } else {
        // Same page as the form: the guest's own fields are also on it, so
        // disambiguate by position -- the answer box is the visible input
        // nearest the submit control (above it, in the observed layout, but
        // measure rather than assume a direction).
        const anchor = await submit.boundingBox();
        const allInputs = page.locator('input');
        const inputCount = await allInputs.count().catch(() => 0);
        let bestDist = Infinity;
        for (let i = 0; i < inputCount; i++) {
          const cand = allInputs.nth(i);
          if (!(await cand.isVisible().catch(() => false))) continue;
          const box = await cand.boundingBox().catch(() => null);
          if (!box || !anchor) continue;
          const dx = box.x + box.width / 2 - (anchor.x + anchor.width / 2);
          const dy = box.y + box.height / 2 - (anchor.y + anchor.height / 2);
          const dist = Math.hypot(dx, dy);
          if (dist > 300) continue; // same dialog, not a form field elsewhere
          if (dist < bestDist) {
            bestDist = dist;
            input = cand;
          }
        }
      }
      if (!input) throw new Error(`captcha answer input not found (inFrame=${inFrame})`);
      await input.fill(text);

      // safeClick falls back to a coordinate click when a wrapper intercepts
      // the event -- this site renders controls as styled divs, not buttons.
      await safeClick(submit);
      await pause(1500);

      const stillThere = await captchaVisible(page);
      if (!stillThere) {
        log({ event: 'twocaptcha_resolved', attempt });
        return true;
      }
      // Still a CAPTCHA on screen. Two different causes, indistinguishable
      // from here: our answer was wrong, OR it was accepted and Yandex
      // served the next challenge in a chain (2-3 in a row is normal here,
      // per manual solving). Either way the response is the same -- go round
      // again with a fresh screenshot -- so don't claim it was wrong.
      log({ event: 'twocaptcha_captcha_still_present', attempt });
    } catch (err) {
      // A timed-out or unsolvable task is worth another go with a fresh
      // screenshot and a fresh worker (observed: successes land at ~22-28s,
      // misses hang past 30s -- so a second short attempt beats one long
      // wait). Anything else (our own bug, bad API key) won't fix itself on
      // a retry, so fall through to the human handoff immediately.
      const retryable = /timed out|UNSOLVABLE/i.test(err.message);
      log({ event: 'twocaptcha_error', attempt, error: err.message, retryable });
      if (!retryable) return false;
    }
  }
  return false;
}

module.exports = {
  fillReservationForm,
  readyToSubmit,
  submit,
  waitForOutcome,
  detectOutcome,
  readSlots,
  setDate,
  solveCaptchaWithTwoCaptcha,
  SlotUnavailable,
  NeedsHuman,
};
