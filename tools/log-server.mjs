// Collects the player's diagnostic log live (see debuglog.js).
//   node tools/log-server.mjs [output.ndjson]
// Appends every entry to the file and prints the notable ones.
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PORT = 7777;
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const file = resolve(process.argv[2] || `logs/atp-${stamp}.ndjson`);
mkdirSync(dirname(file), { recursive: true });

const QUIET = new Set(['snap', 'pl', 'hls-level', 'hls-frag-loaded', 'hls-frag-playing', 'v-ratechange']);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') {
    res.end('ok');
    return;
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    appendFileSync(file, body);
    for (const line of body.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (!QUIET.has(e.ev)) console.log(new Date(e.t).toISOString().slice(11, 23), e.ev, line.length > 300 ? `${line.slice(0, 300)}…` : line);
      } catch {}
    }
    res.end('ok');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`ATP log server on :${PORT} -> ${file}`));
