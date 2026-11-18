// Runs the client against the reference hub over both transports.  node hub/test.js
// HUB_PORT=42080 node hub/test.js — the same checks against a hub that is already running (the one in core.txt).
'use strict';
const assert = require('assert');
const http = require('http');
const { start, originAllowed, topicMatches } = require('./hub');
const { connect } = require('./client');

const until = async (what, test, ms) => {
  const end = Date.now() + (ms || 4000);
  while (!test()) {
    if (Date.now() > end) throw new Error('Timed out waiting for: ' + what);
    await new Promise(r => setTimeout(r, 15));
  }
};

function raw(port, opts, body) {
  return new Promise(resolve => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port }, opts), res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

function app(port, name, transport, extra) {
  const seen = { states: new Map(), events: [], errors: [], online: false };
  const hub = connect(Object.assign({
    app: name, version: '1.0.0', port, transport,
    onState(topic, data, from) { seen.states.set(topic, { data, from }); },
    onEvent(topic, data, from) { seen.events.push({ topic, data, from }); },
    onError(e) { seen.errors.push(e); },
    onStatus(on) { seen.online = on; },
  }, extra));
  return { hub, seen };
}

const external = Number(process.env.HUB_PORT) || 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('origins and topic patterns', () => {
  assert.ok(originAllowed(undefined));
  assert.ok(originAllowed('https://discord.com'));
  assert.ok(originAllowed('https://canary.discord.com'));
  assert.ok(originAllowed('https://steamloopback.host'));
  assert.ok(!originAllowed('https://evil.example'));
  assert.ok(!originAllowed('https://notdiscord.com'));
  assert.ok(!originAllowed('null'));
  assert.ok(topicMatches('*', 'a.b'));
  assert.ok(topicMatches('aura.*', 'aura.fx'));
  assert.ok(!topicMatches('aura.*', 'aurax.fx'));
  assert.ok(!topicMatches('aura.fx', 'aura.fx2'));
});

test('a web page cannot talk to the hub', async port => {
  const evil = { Origin: 'https://evil.example' };
  assert.strictEqual(await raw(port, { method: 'POST', path: '/hub/http', headers: evil }, '{"messages":[]}'), 403);
  const upgrade = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
  assert.strictEqual(await raw(port, { path: '/hub', headers: Object.assign({}, upgrade, evil) }), 403);
  assert.strictEqual(await raw(port, { path: '/hub', headers: Object.assign({}, upgrade, { Origin: 'https://discord.com' }) }), 101);
});

for (const [a, b] of [['ws', 'http'], ['http', 'ws']]) {
  test(`state, events and commands (${a} → ${b})`, async port => {
    let fx = false;
    const aura = app(port, 'aura', a, { commands: { 'fx.toggle': () => { fx = !fx; return { on: fx }; }, 'fx.fail': () => { throw new Error('no device'); } } });
    const discord = app(port, 'maska', b, { topics: ['aura.*', 'hub.*'] });
    await until('both online', () => aura.seen.online && discord.seen.online);

    aura.hub.state('aura.fx', { on: true });
    await until('state reaches a subscriber', () => discord.seen.states.has('aura.fx'));
    assert.deepStrictEqual(discord.seen.states.get('aura.fx'), { data: { on: true }, from: 'aura' });
    assert.deepStrictEqual(discord.seen.states.get('hub.apps').data.map(x => x.app).sort(), ['aura', 'maska']);
    assert.deepStrictEqual(discord.seen.states.get('hub.apps').data.find(x => x.app === 'aura').commands, ['fx.toggle', 'fx.fail']);

    aura.hub.event('aura.clip', { ms: 12 });
    await until('event reaches a subscriber', () => discord.seen.events.length === 1);
    assert.deepStrictEqual(discord.seen.events[0], { topic: 'aura.clip', data: { ms: 12 }, from: 'aura' });

    // Someone who subscribes later still learns the current state, but not past events
    const late = app(port, 'core', a, { topics: ['aura.*'] });
    await until('late subscriber gets the remembered state', () => late.seen.states.has('aura.fx'));
    assert.strictEqual(late.seen.events.length, 0);

    assert.deepStrictEqual(await discord.hub.command('aura', 'fx.toggle'), { ok: true, data: { on: true }, error: undefined });
    assert.strictEqual(fx, true);
    assert.deepStrictEqual(await discord.hub.command('aura', 'fx.fail'), { ok: false, data: undefined, error: 'no device' });
    assert.strictEqual((await discord.hub.command('aura', 'nope')).error, 'unknown-command');
    assert.strictEqual((await discord.hub.command('arkada', 'x')).error, 'offline');

    // An app cannot speak under another app's name
    aura.hub.state('maska.voice', { fake: true });
    await until('spoofed topic is refused', () => aura.seen.errors.some(e => e.code === 'bad-topic'));
    assert.ok(!late.seen.states.has('maska.voice'));

    const r = await late.hub.command('hub', 'theme.set', { mode: 'light', accent: '#F08A4B', bogus: 1 });
    assert.strictEqual(r.ok, true);
    await until('theme reaches subscribers', () => (discord.seen.states.get('hub.theme') || {}).data.mode === 'light');
    assert.deepStrictEqual(discord.seen.states.get('hub.theme').data, { mode: 'light', accent: '#F08A4B', reducedMotion: false });

    // An app that left takes its state with it
    aura.hub.close();
    await until('state is cleared when its app leaves', () => late.seen.states.get('aura.fx').data === null);
    await until('app list shrinks', () => discord.seen.states.get('hub.apps').data.every(x => x.app !== 'aura'));

    discord.hub.close();
    late.hub.close();
  });
}

test('the same app started twice: the newer one wins', async port => {
  const one = app(port, 'aura', 'ws');
  await until('first online', () => one.seen.online);
  const two = app(port, 'aura', 'http');
  const watcher = app(port, 'core', 'ws', { topics: ['hub.apps'] });
  await until('second online', () => two.seen.online && watcher.seen.online);
  await until('one aura in the list', () => watcher.seen.states.has('hub.apps') && watcher.seen.states.get('hub.apps').data.filter(x => x.app === 'aura').length === 1);
  await until('first was dropped', () => !one.seen.online);
  one.hub.close(); two.hub.close(); watcher.hub.close();
});

async function reconnects() {
  let server = await start({ port: 0 });
  const port = server.port;
  const aura = app(port, 'aura', 'ws');
  const discord = app(port, 'maska', 'http', { topics: ['aura.*'] });
  await until('both online', () => aura.seen.online && discord.seen.online);
  aura.hub.state('aura.fx', { on: true });
  await until('state arrives', () => discord.seen.states.has('aura.fx'));

  await server.stop();
  await until('both notice the hub is gone', () => !aura.seen.online && !discord.seen.online, 40000);
  assert.strictEqual((await discord.hub.command('aura', 'x')).error, 'offline');
  discord.seen.states.clear();

  server = await start({ port });
  await until('both come back', () => aura.seen.online && discord.seen.online, 20000);
  await until('state is repeated after reconnect', () => discord.seen.states.has('aura.fx'));
  assert.deepStrictEqual(discord.seen.states.get('aura.fx').data, { on: true });
  aura.hub.close(); discord.hub.close();
  await server.stop();
}

// The hub as a separate process that is killed outright — the way core.txt dies when it crashes or the
// computer goes to sleep at a bad moment. Nothing says goodbye; both transports must notice and come back.
async function survivesKill() {
  const { spawn } = require('child_process');
  const port = 48990 + Math.floor(Math.random() * 9);
  const run = () => spawn(process.execPath, [require('path').join(__dirname, 'hub.js'), String(port)], { stdio: 'ignore' });
  let child = run();
  try {
    const aura = app(port, 'aura', 'ws');
    const maska = app(port, 'maska', 'http', { topics: ['aura.*'] });
    await until('both online', () => aura.seen.online && maska.seen.online, 8000);
    aura.hub.state('aura.fx', { on: true });
    await until('state arrives', () => maska.seen.states.has('aura.fx'));
    child.kill();
    await until('both notice', () => !aura.seen.online && !maska.seen.online, 40000);
    await new Promise(r => setTimeout(r, 2500)); // a few attempts fail while the hub is down
    maska.seen.states.clear();
    child = run();
    await until('both come back', () => aura.seen.online && maska.seen.online, 30000);
    await until('state is repeated', () => maska.seen.states.has('aura.fx'));
    aura.hub.close(); maska.hub.close();
  } finally { child.kill(); }
}

(async () => {
  let failed = 0;
  const run = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + String(e.stack || e).split('\n').slice(0, 4).join('\n      ')); }
  };
  for (const t of tests) {
    const server = external ? { port: external, stop: async () => {} } : await start({ port: 0 });
    await run(t.name, () => t.fn(server.port));
    await server.stop();
  }
  if (!external) await run('clients reconnect when the hub restarts', reconnects);
  if (!external) await run('clients come back after the hub process is killed', survivesKill);
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
