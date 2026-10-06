const fs = require('fs');
const path = require('path');

function dataDir() {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// One JSON line per decision (which element Jev picked, at what confidence,
// what happened next). Deliberately never logs guest details — only keys,
// choices and confidences — so this is safe to keep and to share.
function log(event) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...event });
  try {
    fs.appendFileSync(path.join(dataDir(), 'decisions.log'), line + '\n');
  } catch {}
  console.log('[reserve]', line.slice(0, 300));
}

module.exports = { log, dataDir };
