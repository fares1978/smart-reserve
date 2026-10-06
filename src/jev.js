// Thin client for TypeSafe's Jev model (https://docs.typesafe.ai).
// Jev takes a text `state` plus typed questions (choice / score / noul) and
// returns structured answers with probabilities and a confidence value.

class JevUnavailable extends Error {}

// Optional: send ONLY Jev's traffic through a proxy (e.g. the VPN sidecar in
// docker-compose.yml). The Yandex browser traffic is never proxied — it has to
// keep leaving from this server's own IP.
let fetchImpl = fetch;
let dispatcher;
if (process.env.JEV_PROXY) {
  const undici = require('undici');
  fetchImpl = undici.fetch;
  dispatcher = new undici.ProxyAgent(process.env.JEV_PROXY);
}

function available() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

// Jev rejects text with lone surrogates / control characters (e.g. a flag
// emoji cut in half by a slice), so make everything well-formed first.
const wellFormed = (v) =>
  typeof v === 'string'
    ? v.toWellFormed().replace(/\uFFFD/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    : Array.isArray(v)
    ? v.map(wellFormed)
    : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wellFormed(x)]))
    : v;

async function ask(state, questions) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new JevUnavailable('TYPESAFE_API_KEY not set');

  const url = process.env.JEV_URL || 'https://api.typesafe.ai/v1/systemone';
  let res;
  try {
    res = await fetchImpl(url, {
      dispatcher,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(wellFormed({ state, model: process.env.JEV_MODEL || 'jev-latest', questions })),
      signal: AbortSignal.timeout(Number(process.env.JEV_TIMEOUT_MS || 8000)),
    });
  } catch (err) {
    throw new JevUnavailable(`Jev request failed: ${err.message}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new JevUnavailable(`Jev returned HTTP ${res.status} ${detail}`);
  }
  const json = await res.json();
  return json.answers || {};
}

module.exports = { ask, available, JevUnavailable };
