// uptime-monitor — Dienste überwachen, History speichern, Dashboard ausliefern
'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 8213;
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 60_000;
const HISTORY_LIMIT = 120; // letzte N Checks pro Ziel
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'monitor.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Store ----------

let db = { targets: [], history: {} }; // history[targetId] = [{ts, up, ms, code}]

async function loadDb() {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.targets)) db = { targets: parsed.targets, history: parsed.history || {} };
  } catch (_) { /* frische Installation */ }
}

// Writes serialisieren: nie zwei writeFile/rename gleichzeitig auf dieselbe .tmp
let writeChain = Promise.resolve();
function saveDb() {
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
      await fs.rename(tmp, DB_FILE);
    })
    .catch((e) => console.error('saveDb:', e.message));
  return writeChain;
}

// ---------- Checks ----------

function checkUrl(urlStr) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ up: false, ms: 0, code: 0 }); }
    const mod = u.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = mod.get(u, { headers: { 'user-agent': 'uptime-monitor/1.0' }, timeout: 10_000 }, (res) => {
      res.resume(); // Body verwerfen
      resolve({ up: res.statusCode < 500, ms: Date.now() - start, code: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ up: false, ms: Date.now() - start, code: 0 }); });
    req.on('error', () => resolve({ up: false, ms: Date.now() - start, code: 0 }));
  });
}

async function runChecks() {
  if (!db.targets.length) return;
  const results = await Promise.all(db.targets.map((t) => checkUrl(t.url)));
  const ts = new Date().toISOString();
  db.targets.forEach((t, i) => {
    const r = results[i];
    const h = db.history[t.id] || (db.history[t.id] = []);
    h.push({ ts, up: r.up, ms: r.ms, code: r.code });
    if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
    if (!r.up) console.log(`[DOWN] ${t.name} (${t.url}) code=${r.code}`);
  });
  await saveDb();
}

// ---------- HTTP-Helfer ----------

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

async function serveStatic(res, reqPath) {
  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { sendJson(res, 404, { error: 'not found' }); }
}

// ---------- Status-Aggregation ----------

function statusPayload() {
  return {
    checkIntervalMs: CHECK_INTERVAL_MS,
    targets: db.targets.map((t) => {
      const h = db.history[t.id] || [];
      const last = h[h.length - 1] || null;
      const upCount = h.filter((e) => e.up).length;
      return {
        id: t.id,
        name: t.name,
        url: t.url,
        up: last ? last.up : null,
        lastMs: last ? last.ms : null,
        lastCode: last ? last.code : null,
        lastCheck: last ? last.ts : null,
        uptimePercent: h.length ? Math.round((upCount / h.length) * 1000) / 10 : null,
        history: h.slice(-40), // fürs Dashboard
      };
    }),
  };
}

// ---------- Routen ----------

async function handleApi(req, res, u) {
  if (req.method === 'GET' && u.pathname === '/api/status') {
    return sendJson(res, 200, statusPayload());
  }

  if (req.method === 'POST' && u.pathname === '/api/targets') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    const name = String(body.name || '').trim();
    const url = String(body.url || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name fehlt' });
    if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'url muss mit http(s):// beginnen' });
    const target = { id: crypto.randomUUID(), name, url, createdAt: new Date().toISOString() };
    db.targets.push(target);
    await saveDb();
    // Sofort einen ersten Check anstossen (nicht auf das Intervall warten)
    checkUrl(url).then(async (r) => {
      const h = db.history[target.id] || (db.history[target.id] = []);
      h.push({ ts: new Date().toISOString(), up: r.up, ms: r.ms, code: r.code });
      await saveDb();
    }).catch((e) => console.error(e));
    return sendJson(res, 201, target);
  }

  const del = u.pathname.match(/^\/api\/targets\/([0-9a-f-]+)$/);
  if (req.method === 'DELETE' && del) {
    const before = db.targets.length;
    db.targets = db.targets.filter((t) => t.id !== del[1]);
    if (db.targets.length === before) return sendJson(res, 404, { error: 'not found' });
    delete db.history[del[1]];
    await saveDb();
    return sendJson(res, 200, { deleted: del[1] });
  }

  sendJson(res, 404, { error: 'unknown api route' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    return await serveStatic(res, u.pathname);
  } catch (err) {
    sendJson(res, 500, { error: 'internal error', detail: String(err.message || err) });
  }
});

(async () => {
  await loadDb();
  setInterval(runChecks, CHECK_INTERVAL_MS);
  runChecks(); // sofort beim Start
  server.listen(PORT, () => {
    console.log(`uptime-monitor läuft auf http://localhost:${PORT} (Check alle ${CHECK_INTERVAL_MS / 1000}s)`);
  });
})();
