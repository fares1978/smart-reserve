const fs = require('fs');
const path = require('path');
const jev = require('./jev');
const { snapshot, describeItem, toState } = require('./snapshot');
const { log, dataDir } = require('./log');

// Raised when the automation can't complete a step with enough certainty.
// The caller turns it into a Telegram handoff — it never guesses.
class NeedsHuman extends Error {}

const cacheFile = () => path.join(dataDir(), 'selector-cache.json');
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return {};
  }
}
function remember(key, selector) {
  const cache = readCache();
  cache[key] = selector;
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(cache, null, 2));
  } catch {}
}

async function firstVisible(loc) {
  const n = Math.min(await loc.count(), 10);
  for (let i = 0; i < n; i++) {
    if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  }
  return null;
}

// target: { key, describe, known: [css | (page)=>Locator], minConf, itemFilter }
// Order: last selector Jev found and we cached -> hand-written known selectors
// -> ask Jev to choose among the visible elements. Known selectors are free
// and fast; Jev is the self-healing layer for when they stop matching.
async function resolve(page, target, { skipKnown = false } = {}) {
  // DISABLE_KNOWN is a test switch: forces every step through Jev.
  if (!skipKnown && process.env.DISABLE_KNOWN !== 'true') {
    const cached = readCache()[target.key];
    const known = [...(cached ? [cached] : []), ...(target.known || [])];
    for (const k of known) {
      try {
        const loc = await firstVisible(typeof k === 'function' ? k(page) : page.locator(k));
        if (loc) return { locator: loc, source: 'known' };
      } catch {}
    }
  }

  if (!jev.available()) return null;

  const snap = await snapshot(page);
  const items = snap.items.filter(target.itemFilter || (() => true));
  if (!items.length) return null;

  const criteria = { none: 'None of the listed elements is the right one' };
  for (const it of items) criteria[String(it.id)] = describeItem(it);

  let answer;
  try {
    const answers = await jev.ask(toState(snap, { extra: `STEP: ${target.describe}` }), {
      pick: {
        type: 'choice',
        instructions: `Which element is: ${target.describe}. Choose "none" if no element is clearly right.`,
        criteria,
      },
    });
    answer = answers.pick;
  } catch (err) {
    log({ event: 'jev_error', key: target.key, error: err.message });
    return null;
  }

  const minConf = target.minConf ?? 0.7;
  const ok = answer && answer.choice !== 'none' && answer.confidence >= minConf;
  log({ event: 'jev_pick', key: target.key, choice: answer && answer.choice, confidence: answer && answer.confidence, accepted: Boolean(ok) });
  if (!ok) return null;

  const item = items.find((it) => String(it.id) === answer.choice);
  if (!item) return null;
  return { locator: page.locator(`[data-jev-id="${item.id}"]`), source: 'jev', stable: item.stable };
}

// Resolve a target and run `doIt(locator)`; if a known selector matched the
// wrong thing (doIt returns false / throws), retry once via Jev.
async function act(page, target, doIt) {
  for (const skipKnown of [false, true]) {
    const r = await resolve(page, target, { skipKnown });
    if (!r) continue;
    try {
      if ((await doIt(r.locator)) !== false) {
        if (r.source === 'jev' && r.stable && (await page.locator(r.stable).count()) === 1) {
          remember(target.key, r.stable);
        }
        return r;
      }
      log({ event: 'action_failed', key: target.key, source: r.source });
    } catch (err) {
      log({ event: 'action_error', key: target.key, source: r.source, error: String(err.message).split('\n')[0] });
    }
    if (r.source === 'jev') break;
  }
  throw new NeedsHuman(`Could not complete step: ${target.describe}`);
}

async function safeClick(loc) {
  try {
    await loc.click({ timeout: 3000 });
  } catch {
    // Custom widgets often put a wrapper on top of the real input; click the
    // element's centre by coordinates instead.
    const box = await loc.boundingBox();
    if (!box) throw new Error('element has no bounding box');
    await loc.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

module.exports = { resolve, act, safeClick, firstVisible, NeedsHuman };
