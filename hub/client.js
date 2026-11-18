// Hub client: one file, no dependencies. Works in Node, Electron (either process) and a page inside
// Discord or Steam. Copy it into the app; the protocol is in hub/PROTOCOL.md.
//
//   const hub = connect({
//     app: 'aura', name: 'Aura', version: '0.26.2',
//     topics: ['maska.voice', 'hub.theme'],
//     commands: { 'fx.toggle': args => ({ on: toggle() }) },
//     onState(topic, data, from) {}, onEvent(topic, data, from) {}, onStatus(online) {},
//   });
//   hub.state('aura.fx', { on: true });          // remembered by the hub, sent to late subscribers
//   hub.event('aura.clip', { ms: 12 });          // not remembered
//   const r = await hub.command('maska', 'voice.mute', { on: true });   // { ok, data, error }
//
// The hub being absent is normal: the client keeps trying quietly and nothing throws.
'use strict';

const PROTOCOL = 1;
const DEFAULT_PORT = 42080;

function connect(o) {
  const port = o.port || DEFAULT_PORT;
  const kind = o.transport || (typeof WebSocket !== 'undefined' ? 'ws' : 'http');
  const handlers = o.commands || {};
  const topics = (o.topics || []).slice();
  const own = new Map();     // what this app last said, to repeat after a reconnect
  const pending = new Map(); // command id → { resolve, timer }
  let online = false, seq = 0, closed = false;

  const status = on => { if (online !== on) { online = on; if (o.onStatus) o.onStatus(on); } };
  const finish = (id, result) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(result);
  };

  const link = (kind === 'ws' ? wsTransport : httpTransport)(port, {
    open() {
      link.send({ type: 'hello', v: PROTOCOL, app: o.app, name: o.name || o.app, version: o.version || '', commands: Object.keys(handlers) });
      if (topics.length) link.send({ type: 'subscribe', topics });
      for (const [topic, data] of own) link.send({ type: 'state', topic, data });
    },
    close() {
      status(false);
      for (const id of [...pending.keys()]) finish(id, { ok: false, error: 'offline' });
    },
    message(m) {
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'welcome') return status(true);
      if (m.type === 'state') return o.onState && o.onState(m.topic, m.data, m.from);
      if (m.type === 'event') return o.onEvent && o.onEvent(m.topic, m.data, m.from);
      if (m.type === 'result') return finish(m.id, { ok: m.ok === true, data: m.data, error: m.error });
      if (m.type === 'error') return o.onError && o.onError(m);
      if (m.type === 'command') {
        const reply = r => link.send(Object.assign({ type: 'result', id: m.id, to: m.from }, r));
        const h = handlers[m.name];
        if (!h) return reply({ ok: false, error: 'unknown-command' });
        Promise.resolve().then(() => h(m.args || {}, m.from)).then(
          data => reply({ ok: true, data: data === undefined ? null : data }),
          e => reply({ ok: false, error: String((e && e.message) || e) }));
      }
    },
  });

  return {
    get online() { return online; },
    state(topic, data) {
      if (data === null || data === undefined) own.delete(topic); else own.set(topic, data);
      link.send({ type: 'state', topic, data: data === undefined ? null : data });
    },
    event(topic, data) { link.send({ type: 'event', topic, data: data === undefined ? null : data }); },
    subscribe(more) {
      const fresh = more.filter(t => !topics.includes(t));
      topics.push(...fresh);
      if (fresh.length) link.send({ type: 'subscribe', topics: fresh });
    },
    command(to, name, args, timeoutMs) {
      return new Promise(resolve => {
        if (!online || closed) return resolve({ ok: false, error: 'offline' });
        const id = o.app + '-' + (++seq);
        pending.set(id, { resolve, timer: setTimeout(() => finish(id, { ok: false, error: 'timeout' }), timeoutMs || 5000) });
        link.send({ type: 'command', id, to, name, args: args || {} });
      });
    },
    close() {
      closed = true;
      link.stop();
      status(false);
      for (const id of [...pending.keys()]) finish(id, { ok: false, error: 'offline' });
    },
  };
}

// Tries again after 1, 2, 4… up to 15 seconds
function backoff() {
  let ms = 1000;
  return { next() { const d = ms; ms = Math.min(ms * 2, 15000); return d; }, reset() { ms = 1000; } };
}

function wsTransport(port, on) {
  const wait = backoff();
  let ws = null, timer = null, stopped = false;
  function open() {
    timer = null;
    let s;
    try { s = new WebSocket('ws://127.0.0.1:' + port + '/hub'); } catch (e) { return retry(); }
    ws = s;
    // A connection can end three ways: a close, an error with no close after it (a refused
    // connection in Node), or silence (a hub that never answers). Each of them leads here, once.
    let over = false;
    const lost = () => {
      if (over) return;
      over = true;
      clearTimeout(guard);
      if (ws === s) ws = null;
      try { s.close(); } catch (e) {}
      on.close();
      retry();
    };
    const guard = setTimeout(() => { if (s.readyState !== 1) lost(); }, 5000);
    s.onopen = () => { clearTimeout(guard); wait.reset(); on.open(); };
    s.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } on.message(m); };
    s.onerror = lost;
    s.onclose = lost;
  }
  function retry() { if (!stopped && !timer) timer = setTimeout(open, wait.next()); }
  open();
  return {
    send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); },
    stop() { stopped = true; clearTimeout(timer); const s = ws; ws = null; if (s) s.close(); },
  };
}

// Node only (for example Discord's main process): a POST to say something, a held GET to hear something
function httpTransport(port, on) {
  const http = require('http');
  const wait = backoff();
  let client = null, out = [], busy = false, timer = null, stopped = false, gen = 0, held = null;

  function request(method, path, body, timeout) {
    return new Promise(resolve => {
      const text = body ? JSON.stringify(body) : null;
      const headers = text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {};
      const req = http.request({ host: '127.0.0.1', port, path, method, headers, timeout }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) {} resolve({ status: res.statusCode, json }); });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => req.destroy());
      if (method === 'GET') held = req;
      req.end(text || undefined);
    });
  }
  const deliver = list => { for (const m of Array.isArray(list) ? list : []) on.message(m); };

  function start() { timer = null; client = null; out = []; on.open(); }
  function lost() {
    if (stopped || timer) return;
    gen++; client = null; out = [];
    on.close();
    timer = setTimeout(start, wait.next());
  }
  async function flush() {
    if (busy || stopped || timer || !out.length) return;
    busy = true;
    const mine = gen, batch = out;
    out = [];
    const r = await request('POST', '/hub/http', { client, messages: batch }, 5000);
    busy = false;
    if (stopped) return;
    if (mine !== gen) return flush(); // the connection was lost meanwhile: what is queued now is the new hello
    if (!r || r.status !== 200 || !r.json) return lost();
    wait.reset();
    const first = client === null;
    client = r.json.client;
    deliver(r.json.messages);
    if (first) poll(gen);
    flush();
  }
  async function poll(mine) {
    while (!stopped && mine === gen) {
      const r = await request('GET', '/hub/http?client=' + encodeURIComponent(client), null, 30000);
      if (stopped || mine !== gen) return;
      if (!r || r.status !== 200 || !r.json) return lost();
      deliver(r.json.messages);
    }
  }
  timer = setTimeout(start, 0); // after connect() has the transport in hand
  return {
    send(m) { if (stopped || timer) return; out.push(m); flush(); },
    stop() {
      // Say goodbye so the hub does not wait for the silence to time out
      if (!stopped && client) request('POST', '/hub/http', { client, messages: out.concat([{ type: 'bye' }]) }, 2000);
      stopped = true;
      clearTimeout(timer);
      if (held) held.destroy();
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { connect, PROTOCOL, DEFAULT_PORT };
else globalThis.DevTxtHub = { connect, PROTOCOL, DEFAULT_PORT };
