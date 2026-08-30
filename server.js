// uptime-monitor — Dienste überwachen, History speichern, Dashboard ausliefern
'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const dns = require('node:dns/promises');
const net = require('node:net');

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

// ---------- SSRF-Schutz (dependency-frei, net.BlockList) ----------

// net.BlockList statt manueller Range-Pruefung: BlockList normalisiert auch
// IPv4-mapped IPv6 in HEX-Form (::ffff:7f00:1) und matcht sie gegen die
// IPv4-Subnets — die manuelle Pruefung erkannte nur die Punktform.
const PRIVATE_BLOCKLIST = new net.BlockList();
PRIVATE_BLOCKLIST.addSubnet('0.0.0.0', 8, 'ipv4');      // "this network"
PRIVATE_BLOCKLIST.addSubnet('10.0.0.0', 8, 'ipv4');     // privat
PRIVATE_BLOCKLIST.addSubnet('127.0.0.0', 8, 'ipv4');    // loopback
PRIVATE_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
PRIVATE_BLOCKLIST.addSubnet('172.16.0.0', 12, 'ipv4');  // privat
PRIVATE_BLOCKLIST.addSubnet('192.168.0.0', 16, 'ipv4'); // privat
PRIVATE_BLOCKLIST.addAddress('::', 'ipv6');             // unspecified
PRIVATE_BLOCKLIST.addSubnet('::1', 128, 'ipv6');        // loopback
PRIVATE_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6');       // ULA
PRIVATE_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6');      // link-local

function isPrivateOrReservedIp(ip) {
  const family = net.isIP(ip);
  if (family === 0) return true; // unbekanntes Format -> sicherheitshalber blocken
  return PRIVATE_BLOCKLIST.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

// Wirft, wenn die URL nicht auf eine oeffentliche IP zeigt.
// Gibt die geprueften Daten zurueck, inkl. einer lookup-Funktion, die genau die
// geprueften IP PINNT — der eigentliche Request darf kein zweites DNS-Lookup
// machen (DNS-Rebinding/TOCTOU: kurze TTL koennte beim 2. Lookup privat aufloesen).
async function assertPublicUrl(urlString) {
  let u;
  try { u = new URL(urlString); } catch { throw new Error('ungueltige URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('nur http/https erlaubt');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost') throw new Error('localhost ist geblockt');
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    try { addrs = await dns.lookup(host, { all: true }); }
    catch { throw new Error(`DNS-Aufloesung fehlgeschlagen: ${host}`); }
  }
  if (!addrs.length) throw new Error(`DNS-Aufloesung leer: ${host}`);
  for (const { address } of addrs) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`private/reservierte Ziel-IP geblockt: ${host} -> ${address}`);
    }
  }
  const pinned = addrs[0];
  const family = pinned.family || net.isIP(pinned.address);
  const lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options && options.all) cb(null, [{ address: pinned.address, family }]);
    else cb(null, pinned.address, family);
  };
  return { url: u, address: pinned.address, family, lookup };
}

// ---------- Checks ----------

async function checkUrl(urlStr) {
  // SSRF-Schutz: private/reservierte Ziele als "down" mit Grund melden, nicht anfragen.
  // Die geprüfte IP wird unten per lookup-Option gepinnt (kein zweites DNS-Lookup
  // -> kein DNS-Rebinding-Fenster).
  let pinned;
  try { pinned = await assertPublicUrl(urlStr); }
  catch (e) { return { up: false, ms: 0, code: 0, err: e.message }; }
  return new Promise((resolve) => {
    const u = pinned.url;
    const mod = u.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = mod.get(u, { headers: { 'user-agent': 'uptime-monitor/1.0' }, timeout: 10_000, lookup: pinned.lookup }, (res) => {
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
    h.push({ ts, up: r.up, ms: r.ms, code: r.code, ...(r.err ? { err: r.err } : {}) });
    if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
    if (!r.up) console.log(`[DOWN] ${t.name} (${t.url}) code=${r.code}${r.err ? ' — ' + r.err : ''}`);
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
        lastErr: last ? last.err || null : null,
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'JSON-Objekt erwartet' });
    }
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
      h.push({ ts: new Date().toISOString(), up: r.up, ms: r.ms, code: r.code, ...(r.err ? { err: r.err } : {}) });
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
    console.error('request error:', err);
    sendJson(res, 500, { error: 'internal server error' });
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
