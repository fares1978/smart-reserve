const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { sendReservationAlert } = require('./telegram');
const form = require('./form');
const { log, dataDir } = require('./log');

const { NeedsHuman, SlotUnavailable } = form;
let contextPromise = null;

// One persistent browser context for the whole process, reused across every
// booking: real cookies and local storage, no fresh-anonymous-visitor signal.
function getContext() {
  if (!contextPromise) {
    const profileDir = path.resolve(process.env.PROFILE_DIR || './.profile');
    fs.mkdirSync(profileDir, { recursive: true });
    contextPromise = chromium.launchPersistentContext(profileDir, {
      // Headed (under Xvfb in Docker) when a live view is wanted.
      headless: (process.env.HEADLESS || 'true') === 'true',
      viewport: { width: 1366, height: 900 },
      locale: 'ru-RU',
      // Must match the RESTAURANT's own timezone, not mainland Russia's.
      // This restaurant is in Kaliningrad (UTC+2), one hour behind Moscow
      // (UTC+3) — a mismatch here shifted every submitted time by an hour.
      timezoneId: process.env.RESTAURANT_TIMEZONE || 'Europe/Kaliningrad',
    });
  }
  return contextPromise;
}

async function openForm() {
  const context = await getContext();
  const page = await context.newPage();
  await page.goto(process.env.YANDEX_FORM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="first_name"], input, button', { timeout: 15000 });
  await page.waitForTimeout(1200);
  return page;
}

// Pure calendar arithmetic (not a real timezone conversion) — used only to
// compute which slot to click so the Yandex PARTNER PANEL ends up showing
// the time that was actually requested, after we observed it consistently
// displaying +1h regardless of what our browser's own timezone submits.
//
// RISK, read before changing the default: this form is the same widget real
// guests use directly ("Сайт ресторана" as the booking source). We don't yet
// know whether Yandex sends the GUEST any automatic confirmation (SMS/e-mail)
// based on the submitted value. If it does, compensating here fixes what
// staff see in the panel but would show that guest the wrong time on their
// own confirmation. Set PANEL_TIME_OFFSET_MINUTES=0 to disable this the
// moment that's confirmed either way.
function shiftDateTime(dateStr, timeStr, offsetMinutes) {
  if (!offsetMinutes) return { date: dateStr, time: timeStr };
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mm));
  dt.setUTCMinutes(dt.getUTCMinutes() + offsetMinutes);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
    time: `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
  };
}

async function screenshot(page) {
  const file = path.join(dataDir(), `shot-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

// Stop, tell a human, keep it short for the caller. With LIVE_VIEW_URL set the
// stuck tab is left open so staff can finish it through the live view, and we
// keep watching it in the background so it closes itself afterwards.
async function handoff(page, details, reason, errorMessage) {
  const liveViewUrl = process.env.LIVE_VIEW_URL || '';
  log({ event: 'handoff', reason, errorMessage });
  const shot = await screenshot(page);
  await sendReservationAlert(details, { reason, screenshotPath: shot, errorMessage, liveViewUrl });
  fs.unlink(shot, () => {}); // screenshots contain guest details; don't keep them

  // Previously only reason === 'captcha' kept the tab open for the live view;
  // any OTHER unresolved outcome (validation error, unrecognized post-submit
  // state, an exception mid-fill) closed it immediately even with a live view
  // configured, leaving staff nothing to look at. Now any handoff keeps the
  // tab open, since staff being able to see what actually happened is the
  // whole point of having a live view at all.
  if (liveViewUrl) {
    const until = Date.now() + Number(process.env.HANDOFF_WAIT_MS || 10 * 60 * 1000);
    (async () => {
      // A single Jev read of a static/stuck screen is noisy (seen: repeated
      // "success" at 0.46-0.67, never crossing the 0.8 bar used elsewhere).
      // Require several *consecutive* moderately-confident reads instead of
      // one highly-confident one, so a real resolution is still caught
      // quickly without either bar giving a false positive on noise alone.
      let streak = 0;
      let resolved = false;
      while (Date.now() < until && !page.isClosed()) {
        const r = await form.detectOutcome(page, { useJev: true, exposeRaw: true }).catch(() => ({ outcome: 'pending' }));
        if (r.outcome === 'success' && (r.via === 'deterministic' || r.confidence === undefined || r.confidence >= 0.5)) {
          streak += 1;
          if (r.via === 'deterministic' || streak >= 3) {
            log({ event: 'handoff_completed_by_human', via: r.via, streak });
            resolved = true;
            break;
          }
        } else {
          streak = 0;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      if (!resolved) {
        // Nobody was ever told this one didn't resolve — the tab just closed
        // silently. Say so explicitly instead of leaving it ambiguous.
        log({ event: 'handoff_gave_up' });
        await sendReservationAlert(details, {
          reason: 'error',
          errorMessage: 'Automated tracking of the CAPTCHA hand-off gave up after the wait window. Please check the Yandex partner panel to see whether this booking was completed manually or is still missing.',
        }).catch(() => {});
      }
      await page.close().catch(() => {});
    })();
  } else {
    await page.close().catch(() => {});
  }
  return {
    ok: false,
    status: 'needs_manual_action',
    message:
      reason === 'captcha'
        ? 'CAPTCHA appeared, alerted staff to complete the booking manually.'
        : 'Could not complete the booking automatically, alerted staff to complete it manually.',
  };
}

async function reportSuccess(page, details) {
  // One-off aid for calibrating SUCCESS_TEXT against the real confirmation
  // screen; set DEBUG_SHOTS=true only for the first supervised test.
  let shot = null;
  if (process.env.DEBUG_SHOTS === 'true') {
    shot = await screenshot(page);
    log({ event: 'success_screenshot_kept', path: shot });
  }
  await page.close();
  // Every real booking pings Telegram, so staff notice test bookings (or
  // anything unexpected) immediately and can cancel them if needed.
  await sendReservationAlert(details, { reason: 'success', screenshotPath: shot });
  if (shot) fs.unlink(shot, () => {});
  return { ok: true, status: 'created', message: 'Reservation submitted successfully.' };
}

async function attemptReservation(details) {
  const page = await openForm();
  // `details` stays the guest's true requested time throughout (used for
  // every Telegram alert and log) — only `fillDetails` is what actually
  // gets clicked on the form. See shiftDateTime() above for why. Declared
  // outside the try block since the catch below needs them too.
  const offsetMin = Number(process.env.PANEL_TIME_OFFSET_MINUTES ?? -60);
  const shifted = shiftDateTime(details.date, details.time, offsetMin);
  const fillDetails = { ...details, ...shifted };
  if (offsetMin) log({ event: 'panel_offset_applied', offsetMinutes: offsetMin, requested: `${details.date} ${details.time}`, submitted: `${shifted.date} ${shifted.time}` });
  try {
    await form.fillReservationForm(page, fillDetails);

    const gate = await form.readyToSubmit(page, fillDetails);
    if (!gate.ok) return await handoff(page, details, 'error', gate.reason);

    if ((process.env.DRY_RUN || 'true') === 'true') {
      log({ event: 'dry_run_stop', gate: gate.via });
      await page.close();
      return { ok: true, status: 'dry_run', message: 'Form filled and verified; not submitted (DRY_RUN=true).' };
    }

    await form.submit(page);
    const { outcome, via } = await form.waitForOutcome(page, Number(process.env.RESERVE_TIMEOUT_MS || 20000));
    log({ event: 'outcome', outcome, via });

    if (outcome === 'success') return await reportSuccess(page, details);

    if (outcome === 'captcha') {
      // Yandex's own team recommended 2captcha as an interim bridge until
      // their partner API ships. Tried first; if it fails for any reason,
      // falls straight through to the existing Telegram + live-view handoff.
      const solved = await form.solveCaptchaWithTwoCaptcha(page).catch((err) => {
        log({ event: 'twocaptcha_unexpected_error', error: err.message });
        return false;
      });
      if (solved) {
        // Same streak-smoothing the handoff watcher uses: a single Jev read
        // of the confirmation screen sits around 0.66-0.74, never crossing
        // the 0.8 single-shot gate -- which once reported a COMPLETED
        // booking as needing manual action. Several consecutive moderate
        // reads are the reliable signal, and a deterministic text match
        // short-circuits immediately.
        const confirmUntil = Date.now() + Number(process.env.RESERVE_TIMEOUT_MS || 20000);
        let streak = 0;
        let confirmed = false;
        while (Date.now() < confirmUntil && !confirmed) {
          const r = await form.detectOutcome(page, { useJev: true, exposeRaw: true }).catch(() => ({ outcome: 'pending' }));
          if (r.outcome === 'success' && (r.via === 'deterministic' || (r.confidence ?? 0) >= 0.6)) {
            streak += 1;
            if (r.via === 'deterministic' || streak >= 3) confirmed = true;
          } else {
            streak = 0;
          }
          if (!confirmed) await new Promise((res) => setTimeout(res, 1500));
        }
        log({ event: 'outcome_after_twocaptcha', confirmed, streak });
        if (confirmed) return await reportSuccess(page, details);
      }
      return await handoff(page, details, 'captcha');
    }
    return await handoff(page, details, 'error', `Outcome after submit: ${outcome}`);
  } catch (err) {
    if (err instanceof SlotUnavailable) {
      await page.close().catch(() => {});
      // err.message/alternatives are phrased in terms of fillDetails.time (the
      // shifted slot we clicked) — rewrite back to what the caller asked for.
      const msg = offsetMin ? err.message.replace(shifted.time, details.time) : err.message;
      return { ok: false, status: 'slot_unavailable', message: msg, alternatives: err.alternatives };
    }
    const msg = err instanceof NeedsHuman ? err.message : String((err && err.message) || err).split('\n')[0];
    log({ event: 'attempt_failed', error: msg });
    if (page.isClosed()) {
      await sendReservationAlert(details, { reason: 'error', errorMessage: msg });
      return { ok: false, status: 'error', message: 'Automation failed, alerted staff to complete the booking manually.' };
    }
    return await handoff(page, details, 'error', msg);
  }
}

// Read-only: which time slots does the form offer on this date?
async function listSlots(date) {
  const page = await openForm();
  try {
    await form.setDate(page, date);
    return { ok: true, status: 'ok', slots: await form.readSlots(page) };
  } catch (err) {
    if (err instanceof SlotUnavailable) return { ok: false, status: 'slot_unavailable', message: err.message, slots: [] };
    return { ok: false, status: 'error', message: String((err && err.message) || err).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { attemptReservation, listSlots };
