// Thin client for 2captcha's classic image-to-text solving API.
// https://2captcha.com/api-docs/image-to-text — a human/OCR-backed service
// that solves a distorted-text image and returns the text.
//
// Used here only because Yandex's own team recommended it as an interim
// bridge until their partner API ships. Not something to reuse casually
// elsewhere without the same kind of explicit sanction from the site owner.

const BASE = 'https://api.2captcha.com';

class TwoCaptchaError extends Error {}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).catch((err) => {
    throw new TwoCaptchaError(`2captcha request failed: ${err.message}`);
  });
  const json = await res.json();
  if (json.errorId) throw new TwoCaptchaError(`2captcha ${path} error: ${json.errorCode || json.errorDescription || json.errorId}`);
  return json;
}

async function solveImage(base64Png, { timeoutMs = 30000, caseSensitive = true, comment = '' } = {}) {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) throw new TwoCaptchaError('TWOCAPTCHA_API_KEY not set');

  const task = { type: 'ImageToTextTask', body: base64Png, case: caseSensitive, numeric: 0 };
  if (comment) task.comment = comment;
  // These challenges are Cyrillic words. The default worker pool is English-
  // speaking and returned 1-7 character garbage for ~20-character Russian
  // text; "rn" routes to workers who actually read Cyrillic.
  const languagePool = process.env.TWOCAPTCHA_LANGUAGE_POOL || 'rn';
  const created = await post('/createTask', { clientKey: key, task, languagePool });
  const taskId = created.taskId;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const result = await post('/getTaskResult', { clientKey: key, taskId });
    if (result.status === 'ready') return result.solution.text;
  }
  throw new TwoCaptchaError('2captcha solve timed out');
}

module.exports = { solveImage, TwoCaptchaError };
