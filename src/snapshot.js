// Turns the live page into compact text a model can reason about: visible page
// text plus one numbered line per interactive element. Elements get a
// temporary data-jev-id so a chosen id maps straight back to a locator.
//
// It deliberately includes "clickable but non-semantic" elements (divs/spans
// with cursor:pointer) — the time slots on this form are exactly that.

async function snapshot(page, { maxItems = 90 } = {}) {
  return page.evaluate((maxItems) => {
    document.querySelectorAll('[data-jev-id]').forEach((e) => e.removeAttribute('data-jev-id'));

    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const SEM =
      'input,textarea,select,button,a[href],[role=button],[role=gridcell],[role=option],[role=tab],[role=checkbox],[tabindex]:not([tabindex="-1"])';

    const cands = new Set(document.querySelectorAll(SEM));
    for (const el of document.querySelectorAll('div,span,li,label')) {
      if (cands.has(el) || el.closest(SEM)) continue;
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      const t = clean(el.innerText);
      if (!t || t.length > 30) continue;
      if ([...el.children].some((c) => getComputedStyle(c).cursor === 'pointer')) continue;
      cands.add(el);
    }

    const labelFor = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return '';
      let node = el.parentElement;
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
        const first = (node.innerText || '')
          .split('\n')
          .map(clean)
          .find((l) => l && l !== clean(el.value) && l.length < 40);
        if (first && node.querySelectorAll('input,textarea,select').length === 1) return first;
      }
      return '';
    };

    const items = [];
    let id = 0;
    for (const el of cands) {
      if (items.length >= maxItems) break;
      if (!visible(el)) continue;
      id += 1;
      el.setAttribute('data-jev-id', String(id));
      const flags = [];
      if (el.required || /\*/.test(labelFor(el))) flags.push('required');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') flags.push('disabled');
      if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.checked) flags.push('selected');
      else {
        // Custom widgets mark selection with a hashed class like "_slotActive_x1y2"
        // on the element or a wrapper a level or two up.
        let n = el;
        for (let i = 0; i < 3 && n && n !== document.body; i++, n = n.parentElement) {
          const c = String(n.className || '');
          if (/(active|selected|checked)/i.test(c) && !/inactive/i.test(c)) {
            flags.push('selected');
            break;
          }
        }
      }
      const tag = el.tagName.toLowerCase();
      const stable = el.getAttribute('data-testid')
        ? `[data-testid="${el.getAttribute('data-testid')}"]`
        : el.name && ['input', 'textarea', 'select'].includes(tag)
        ? `${tag}[name="${el.name}"]`
        : el.getAttribute('aria-label')
        ? `[aria-label="${el.getAttribute('aria-label')}"]`
        : null;
      items.push({
        id,
        tag,
        role: el.getAttribute('role') || '',
        name: el.getAttribute('name') || '',
        testid: el.getAttribute('data-testid') || '',
        label: clean(labelFor(el)),
        text: tag === 'select' ? '' : clean(el.innerText).slice(0, 40),
        value: ['input', 'textarea'].includes(tag) ? el.value : '',
        flags,
        stable,
      });
    }

    const errors = [...document.querySelectorAll('[role=alert],[class*="error" i],[class*="invalid" i]')]
      .filter(visible)
      .map((e) => clean(e.innerText))
      .filter(Boolean)
      .slice(0, 5);

    // Native <select> lists (e.g. ~200 country codes) would swamp the page text.
    let body = document.body.innerText;
    document.querySelectorAll('select').forEach((sel) => {
      if (sel.innerText) body = body.split(sel.innerText).join(' ');
    });
    return { items, pageText: clean(body).slice(0, 2500), errors };
  }, maxItems);
}

function describeItem(it) {
  const bits = [`[${it.id}]`, it.role ? `${it.tag}(role=${it.role})` : it.tag];
  if (it.name) bits.push(`name=${it.name}`);
  if (it.testid) bits.push(`testid=${it.testid}`);
  if (it.label) bits.push(`label="${it.label}"`);
  if (it.text) bits.push(`text="${it.text}"`);
  if (it.value) bits.push(`value="${it.value}"`);
  if (it.flags.length) bits.push(it.flags.join(','));
  return bits.join(' ');
}

// State string handed to Jev. `withItems` is for questions that reason about
// element state (e.g. "is the slot selected"); choices pass elements as
// criteria instead so they aren't sent twice.
function toState(snap, { withItems = false, extra = '' } = {}) {
  const parts = [];
  if (extra) parts.push(extra);
  parts.push(`PAGE TEXT: ${snap.pageText}`);
  if (snap.errors.length) parts.push(`VISIBLE ERRORS: ${snap.errors.join(' | ')}`);
  if (withItems) parts.push('ELEMENTS:\n' + snap.items.map(describeItem).join('\n'));
  return parts.join('\n\n');
}

module.exports = { snapshot, describeItem, toState };
