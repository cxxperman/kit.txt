// Reference hub: the protocol in hub/PROTOCOL.md, in plain Node with no dependencies.
// It is what the tests run against and what an app can be developed against when Kapsula is not running.
// The real hub lives inside Kapsula (C#) and must behave the same way.
//   node hub/hub.js [port]
'use strict';
const http = require('http');
const crypto = require('crypto');

const PROTOCOL = 1;
const DEFAULT_PORT = 42080;
const MAX_MESSAGE = 1024 * 1024;
const POLL_HOLD_MS = 20000;
const HTTP_CLIENT_TTL_MS = 45000;
// Pages that may connect from inside another program. Anything without an Origin is a local program.
const ORIGINS = ['discord.com', 'discordapp.com', 'steamloopback.host'];
const APP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function originAllowed(origin) {
  if (!origin) return true;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return ORIGINS.some(d => host === d || host.endsWith('.' + d));
}

function topicMatches(pattern, topic) {
  return pattern === '*' || pattern === topic || (pattern.endsWith('.*') && topic.startsWith(pattern.slice(0, -1)));
}

// ───────── The hub itself: who is connected, what they last said, who hears what ─────────
class Hub {
  constructor(opts) {
    opts = opts || {};
    this.name = opts.name || 'reference-hub';
    this.version = opts.version || '0.1.0';
    this.clients = new Set();
    this.retained = new Map(); // topic → { from, data }
    this.theme = Object.assign({ mode: 'dark', accent: null, reducedMotion: false }, opts.theme);
    this.seq = 0;
  }

  open(send, kick) {
    const c = { id: 'c' + (++this.seq) + '-' + crypto.randomBytes(6).toString('hex'), app: null, info: null, subs: [], send, kick };
    this.clients.add(c);
    return c;
  }

  close(c) {
    if (!this.clients.delete(c) || !c.app) return;
    for (const [topic, r] of this.retained) {
      if (r.from !== c.app) continue;
      this.retained.delete(topic);
      this.fanOut({ type: 'state', topic, from: c.app, data: null }, c);
    }
    this.publishApps();
  }

  byApp(app) {
    for (const c of this.clients) if (c.app === app) return c;
    return null;
  }

  apps() {
    return [...this.clients].filter(c => c.app).map(c => c.info);
  }

  hubState(topic) {
    if (topic === 'hub.apps') return this.apps();
    if (topic === 'hub.theme') return this.theme;
    return undefined;
  }

  publishApps() { this.fanOut({ type: 'state', topic: 'hub.apps', from: 'hub', data: this.apps() }, null); }

  fanOut(msg, except) {
    for (const c of this.clients)
      if (c !== except && c.app && c.subs.some(p => topicMatches(p, msg.topic))) c.send(msg);
  }

  receive(c, m) {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (m.type === 'ping') return c.send({ type: 'pong' });
    if (m.type === 'bye') { this.close(c); if (c.kick) c.kick(); return; }

    if (m.type === 'hello') {
      if (c.app) return;
      if (typeof m.app !== 'string' || !APP_NAME.test(m.app) || m.app === 'hub') return c.send({ type: 'error', code: 'bad-app' });
      if (Math.floor(Number(m.v)) !== PROTOCOL) return c.send({ type: 'error', code: 'bad-version', v: PROTOCOL });
      const old = this.byApp(m.app); // the same app started again: the newer one wins
      if (old) { this.close(old); if (old.kick) old.kick(); }
      c.app = m.app;
      c.info = {
        app: m.app,
        name: typeof m.name === 'string' ? m.name.slice(0, 64) : m.app,
        version: typeof m.version === 'string' ? m.version.slice(0, 32) : '',
        commands: Array.isArray(m.commands) ? m.commands.filter(x => typeof x === 'string').slice(0, 64) : [],
      };
      c.send({ type: 'welcome', v: PROTOCOL, hub: { name: this.name, version: this.version }, client: c.id, apps: this.apps() });
      this.publishApps();
      return;
    }
    if (!c.app) return c.send({ type: 'error', code: 'hello-first' });

    if (m.type === 'subscribe') {
      const topics = (Array.isArray(m.topics) ? m.topics : []).filter(x => typeof x === 'string');
      for (const p of topics) {
        if (c.subs.includes(p) || c.subs.length >= 64) continue;
        c.subs.push(p);
        for (const topic of ['hub.apps', 'hub.theme'])
          if (topicMatches(p, topic)) c.send({ type: 'state', topic, from: 'hub', data: this.hubState(topic) });
        for (const [topic, r] of this.retained)
          if (r.from !== c.app && topicMatches(p, topic)) c.send({ type: 'state', topic, from: r.from, data: r.data });
      }
      return;
    }

    if (m.type === 'state' || m.type === 'event') {
      // An app speaks only under its own name: "aura.fx" comes from aura and nobody else
      if (typeof m.topic !== 'string' || !m.topic.startsWith(c.app + '.')) return c.send({ type: 'error', code: 'bad-topic', topic: m.topic });
      const data = m.data === undefined ? null : m.data;
      if (m.type === 'state') {
        if (data === null) this.retained.delete(m.topic); else this.retained.set(m.topic, { from: c.app, data });
      }
      return this.fanOut({ type: m.type, topic: m.topic, from: c.app, data }, c);
    }

    if (m.type === 'command') {
      const reply = (ok, extra) => c.send(Object.assign({ type: 'result', id: m.id, from: m.to, ok }, extra));
      if (typeof m.name !== 'string' || typeof m.to !== 'string') return reply(false, { error: 'bad-command' });
      if (m.to === 'hub') {
        if (m.name !== 'theme.set') return reply(false, { error: 'unknown-command' });
        const a = m.args || {};
        if (a.mode === 'dark' || a.mode === 'light') this.theme.mode = a.mode;
        if (a.accent === null || /^#[0-9a-f]{6}$/i.test(a.accent || '')) this.theme.accent = a.accent;
        if (typeof a.reducedMotion === 'boolean') this.theme.reducedMotion = a.reducedMotion;
        this.fanOut({ type: 'state', topic: 'hub.theme', from: 'hub', data: this.theme }, null);
        return reply(true, { data: this.theme });
      }
      const target = this.byApp(m.to);
      if (!target) return reply(false, { error: 'offline' });
      return target.send({ type: 'command', id: m.id, from: c.app, name: m.name, args: m.args === undefined ? {} : m.args });
    }

    if (m.type === 'result') {
      const target = typeof m.to === 'string' ? this.byApp(m.to) : null;
      if (target) target.send({ type: 'result', id: m.id, from: c.app, ok: m.ok === true, data: m.data, error: m.error });
    }
    // Anything else is from a newer version of the protocol: ignored, not an error
  }
}

// ───────── WebSocket, server side ─────────
function wsAccept(req, socket, hub) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  const frame = (opcode, payload) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
  };
  const client = hub.open(m => frame(1, Buffer.from(JSON.stringify(m))), () => socket.destroy());

  let buf = Buffer.alloc(0);
  let parts = [];
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (!masked || len > MAX_MESSAGE) return socket.destroy();
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(at + 4 + len);

      if (opcode === 8) { frame(8, Buffer.alloc(0)); return socket.end(); }
      if (opcode === 9) { frame(10, payload); continue; }
      if (opcode !== 0 && opcode !== 1) continue;
      parts.push(payload);
      if (parts.reduce((s, p) => s + p.length, 0) > MAX_MESSAGE) return socket.destroy();
      if (!fin) continue;
      const text = Buffer.concat(parts).toString('utf8');
      parts = [];
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      hub.receive(client, msg);
    }
  });
  socket.on('close', () => hub.close(client));
  socket.on('error', () => {});
}

// ───────── The same messages over plain HTTP, for places with no WebSocket ─────────
function httpTransport(hub) {
  const clients = new Map(); // id → { client, queue, waiter, seen }

  const drain = h => { const q = h.queue; h.queue = []; return q; };
  const answer = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const release = h => {
    if (!h.waiter) return;
    clearTimeout(h.waiter.timer);
    const res = h.waiter.res;
    h.waiter = null;
    answer(res, 200, { messages: drain(h) });
  };
  const drop = h => {
    clients.delete(h.client.id);
    if (h.waiter) { clearTimeout(h.waiter.timer); answer(h.waiter.res, 410, {}); h.waiter = null; }
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const h of [...clients.values()]) if (!h.waiter && now - h.seen > HTTP_CLIENT_TTL_MS) { drop(h); hub.close(h.client); }
  }, 5000);
  sweeper.unref();

  function handle(req, res, url) {
    if (req.method === 'GET') {
      const h = clients.get(url.searchParams.get('client'));
      if (!h) return answer(res, 410, {});
      h.seen = Date.now();
      release(h); // one waiting request per client
      if (h.queue.length) return answer(res, 200, { messages: drain(h) });
      h.waiter = { res, timer: setTimeout(() => release(h), POLL_HOLD_MS) };
      res.on('close', () => { if (h.waiter && h.waiter.res === res) { clearTimeout(h.waiter.timer); h.waiter = null; h.seen = Date.now(); } });
      return;
    }
    if (req.method !== 'POST') return answer(res, 405, {});
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_MESSAGE) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return answer(res, 400, {}); }
      let h;
      if (body.client == null) {
        h = { queue: [], waiter: null, seen: Date.now() };
        h.client = hub.open(m => { h.queue.push(m); if (h.waiter) release(h); }, () => drop(h));
        clients.set(h.client.id, h);
      } else {
        h = clients.get(body.client);
        if (!h) return answer(res, 410, {});
        h.seen = Date.now();
      }
      for (const m of Array.isArray(body.messages) ? body.messages : []) hub.receive(h.client, m);
      answer(res, 200, { client: h.client.id, messages: h.waiter ? [] : drain(h) });
    });
  }

  return { handle, stop() { clearInterval(sweeper); for (const h of [...clients.values()]) drop(h); } };
}

// ───────── Server ─────────
function start(opts) {
  opts = opts || {};
  const hub = new Hub(opts);
  const viaHttp = httpTransport(hub);
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!originAllowed(req.headers.origin)) { res.writeHead(403); return res.end(); }
    if (url.pathname === '/hub/http') return viaHttp.handle(req, res, url);
    if (url.pathname === '/hub' && req.method === 'GET') {
      const text = JSON.stringify({ hub: hub.name, version: hub.version, v: PROTOCOL });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(text);
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/hub' || !originAllowed(req.headers.origin) || !req.headers['sec-websocket-key']) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    wsAccept(req, socket, hub);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only: the port is not visible from outside this computer
    server.listen(opts.port === undefined ? DEFAULT_PORT : opts.port, '127.0.0.1', () => resolve({
      hub,
      port: server.address().port,
      stop() {
        viaHttp.stop();
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        return new Promise(done => server.close(() => done()));
      },
    }));
  });
}

module.exports = { start, Hub, originAllowed, topicMatches, PROTOCOL, DEFAULT_PORT };

if (require.main === module) {
  const port = Number(process.argv[2]) || DEFAULT_PORT;
  start({ port }).then(
    s => console.log('Hub is listening on 127.0.0.1:' + s.port),
    e => { console.error(e.code === 'EADDRINUSE' ? 'Port ' + port + ' is taken (is Kapsula running?)' : String(e)); process.exit(1); });
}
