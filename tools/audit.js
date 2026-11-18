// kit.txt. tools/audit.js — проверка всех приложений dev.txt разом: сборка, самопроверки, снимки рядом и поиск
// ошибок, которые у нас уже случались (папки с именем продукта, мерцание полноэкранных окон, меню WinForms,
// цвета мимо темы, «прыгучее» движение, английский и неряшливый текст в интерфейсе).
//
//   node tools/audit.js <папка, где лежат core, dock, smena, metla, template и repos/kapsula, repos/aura-voice>
//        [--no-build] [--kapsula-tests] [--out <папка для отчёта>]
//
// Ничего не запускает по-настоящему: только --selftest и --demo --shot (снимок без окна на экране).
// Не трогает ни работающие приложения, ни реестр, ни сеть. Отчёт — REPORT.md и family.png в папке --out.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const root = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const flag = n => args.includes(n);
const outArg = args.indexOf('--out');
const out = path.resolve(outArg >= 0 ? args[outArg + 1] : path.join(root, 'audit-out'));
fs.mkdirSync(out, { recursive: true });

// Приложения на общем каркасе kit.txt (C#, WPF) и два своих: Kapsula (C#, свой интерфейс) и Aura (Electron)
const apps = [
  { id: 'core', dir: 'core', exe: 'Core.exe', shots: [['core', ['--demo']], ['core-settings', ['--demo', '--page', 'settings']]] },
  { id: 'dock', dir: 'dock', exe: 'Dock.exe', shots: [['dock', ['--demo']]] },
  { id: 'smena', dir: 'smena', exe: 'Smena.exe', shots: [['smena', ['--demo']], ['smena-about', ['--demo', '--about']]] },
  { id: 'metla', dir: 'metla', exe: 'Metla.exe', shots: [['metla', ['--demo']]] },
  { id: 'template', dir: 'template', exe: 'NewApp.exe', shots: [['newapp', ['--demo']]] },
].filter(a => fs.existsSync(path.join(root, a.dir)));
const kapsula = path.join(root, 'repos', 'kapsula');
const aura = path.join(root, 'repos', 'aura-voice');

const findings = [];   // { level: 'ошибка'|'внимание'|'сведения', app, file, line, rule, text }
const add = (level, app, file, line, rule, text) => findings.push({ level, app, file, line, rule, text });
const results = [];    // строки «сборка/проверки» для отчёта

function files(dir, exts) {
  const list = [];
  if (!fs.existsSync(dir)) return list;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!/^(node_modules|\.git|dist|bin|obj|native|lib|cam)$/.test(n)) list.push(...files(p, exts)); }
    else if (exts.some(e => n.endsWith(e))) list.push(p);
  }
  return list;
}

// Строковые литералы C# и JS с номером строки
function literals(src) {
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  const res = [];
  let m;
  while ((m = re.exec(src))) res.push({ text: m[0].slice(1, -1), line: src.slice(0, m.index).split('\n').length });
  return res;
}

const cyr = /[А-Яа-яЁё]/;
const PRODUCTS = ['Kapsula', 'Aura', 'Dock', 'Smena', 'Metla', 'Maska', 'Arkada', 'Core'];

// ───────── Тексты интерфейса: русский, аккуратный, как в Windows ─────────
function checkText(app, file, lit) {
  const t = lit.text;
  if (!cyr.test(t)) return;
  if (/^\s*[{[]|\{\\"|":\s*\\?"/.test(t)) return;   // JSON для проверок и примеров, а не текст интерфейса
  if (/\.\.\.(?!\.)/.test(t)) add('внимание', app, file, lit.line, 'текст: многоточие', 'три точки «...» вместо «…»: «' + t.slice(0, 70) + '»');
  if (/(^|[\s(])\\?"[А-Яа-яЁё]|[А-Яа-яЁё.!?]\\?"($|[\s,.;:!?)])/.test(t)) add('внимание', app, file, lit.line, 'текст: кавычки', 'прямые кавычки в русском тексте — нужны «ёлочки»: «' + t.slice(0, 70) + '»');
  if (/[А-Яа-яЁё0-9] - [А-Яа-яЁё0-9]/.test(t)) add('внимание', app, file, lit.line, 'текст: тире', 'дефис между словами вместо тире « — »: «' + t.slice(0, 70) + '»');
  if (/[а-яё,] (Вы|Вас|Вам|Ваш|Ваша|Ваше|Ваши)\b/.test(t)) add('внимание', app, file, lit.line, 'текст: «вы»', '«Вы» с большой буквы посреди фразы — в dev.txt пишем «вы»: «' + t.slice(0, 70) + '»');
  if (/ {2,}/.test(t.trim()) && !/\\n/.test(t)) add('сведения', app, file, lit.line, 'текст: двойной пробел', '«' + t.slice(0, 70) + '»');
  for (const p of PRODUCTS) {
    const re = new RegExp('(^|[^\\w.\\\\/])' + p + '(?![\\w.\\-])');
    if (re.test(t) && !/Kapsula Camera|включите Kapsula|плагин Kapsula/.test(t))
      add('внимание', app, file, lit.line, 'текст: имя продукта', 'в интерфейсе продукт пишется «' + p.toLowerCase() + '.txt»: «' + t.slice(0, 70) + '»');
  }
}

// ───────── C# ─────────
function checkCs(app, file, src, kit) {
  const rel = path.relative(root, file);
  const shared = /[\\/](Ui|Tokens|HubLink|CoreApp)\.cs$/.test(file);
  const lines = src.split('\n');
  const each = (re, fn) => lines.forEach((l, i) => { if (!/audit:ok/.test(l) && re.test(l)) fn(l, i + 1); });

  // Ошибка Kapsula 0.8.2: папка данных названа по имени продукта с «.txt» — прежние настройки пропадают
  // (общая папка «dev.txt» названа так нарочно — она не в счёт)
  each(/SpecialFolder\.\w+\)\s*,\s*"(kapsula|aura|dock|smena|metla|core|maska|arkada|newapp)\.txt"/i, (l, n) => add('ошибка', app, rel, n, 'логика: папка .txt', 'папка данных с именем «….txt»: у пользователей, обновившихся с прежней версии, пропадут настройки. Папки называются как раньше, без .txt'));
  // Тексты
  for (const lit of literals(src)) checkText(app, rel, lit);
  if (shared) return;

  // Меню
  each(/new (System\.Windows\.Forms\.|WF\.)?ContextMenuStrip\b/, (l, n) => add(kit ? 'внимание' : 'сведения', app, rel, n, 'вид: меню WinForms', kit ? 'меню WinForms выглядит как в Windows 7 — используйте NativeMenu из Ui.cs' : 'меню WinForms: проверьте, что его рисует DarkMenuRenderer (вид меню Windows 11)'));
  // Движение
  each(/\b(BackEase|ElasticEase|BounceEase)\b/, (l, n) => add('внимание', app, rel, n, 'движение: пружина', 'пружины и отскоки — не движение Windows 11 (быстрый вход cubic-bezier(0,0,0,1), 167–333 мс)'));
  if (kit) {
    each(/TimeSpan\.FromMilliseconds\(\s*\d/, (l, n) => add('сведения', app, rel, n, 'движение: число', 'длительность числом — возьмите Tokens.Motion.*Ms'));
    // док и переключатель smena — оверлеи, тёмные нарочно; остальные окна следуют теме Windows
    if (app !== 'dock' && !/Switcher\.cs$/.test(file)) each(/Tokens\.(Dark|GlassDark)\.\w+/, (l, n) => add('внимание', app, rel, n, 'вид: тёмный цвет напрямую', 'цвет тёмной темы напрямую — в светлой теме Windows он останется тёмным. Берите кисти Ui.* (Ui.Label, Ui.Fill, Ui.Separator…)'));
    each(/CornerRadius\(\s*\d+(\.\d+)?\s*\)/, (l, n) => add('сведения', app, rel, n, 'вид: радиус числом', 'скругление числом — Tokens.Radius.* (8 у панелей, 4 у кнопок и строк)'));
    each(/FontSize\s*=\s*\d/, (l, n) => add('сведения', app, rel, n, 'вид: шрифт числом', 'размер шрифта числом — Tokens.Size.* (шкала Windows: 12, 14, 20, 28)'));
    each(/ScrollBarVisibility\.(Auto|Visible)\b/, (l, n) => add('сведения', app, rel, n, 'вид: толстая прокрутка', 'классическая полоса прокрутки WPF толстая, как в Windows 7 — Hidden (колесо мыши работает)'));
  }
  each(/Thread\.Sleep\(/, (l, n) => { if (!/new Thread|Task\.Run|BeginInvoke/.test(src.slice(0, 0))) add('сведения', app, rel, n, 'логика: Thread.Sleep', 'если это поток окна — окно замрёт; проверьте, что Sleep не в потоке интерфейса'); });
}

function checkWindowsOf(app, dir) {
  const all = files(path.join(dir, 'src'), ['.cs']).filter(f => !/[\\/](Ui|Tokens|HubLink|CoreApp)\.cs$/.test(f));
  const text = all.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const layered = /AllowsTransparency\s*=\s*true/.test(text);
  const smooth = /Ui\.Native\(/.test(text) || /Ui\.Smooth\(/.test(text);
  const fullscreen = /Win\.Place\(|SystemParameters\.PrimaryScreenWidth|VirtualScreen|mon\.Right - mon\.Left/.test(text);
  if (layered && smooth && fullscreen && !/Ui\.AllowSmooth\s*=\s*false/.test(text))
    add('ошибка', app, path.relative(root, dir), 0, 'движение: мерцание', 'большое прозрачное окно и частота монитора вместе: на 144–180 Гц оно мерцает (так было с Alt+Tab в smena 0.3.0). Поставьте Ui.AllowSmooth = false в Main');
  for (const f of all) {
    const s = fs.readFileSync(f, 'utf8');
    if (/:\s*Window\b/.test(s) && /WindowStyle\s*=\s*WindowStyle\.None/.test(s) && !/AllowsTransparency\s*=\s*true/.test(s) && !/Ui\.Native\(/.test(s))
      add('внимание', app, path.relative(root, f), 0, 'вид: своя рамка окна', 'окно без системной рамки и без Ui.Native — нет тени, прилипания к краям и кнопок Windows 11');
  }
}

// ───────── JS, CSS, HTML (Aura) ─────────
function checkWeb(app, dir) {
  for (const f of files(dir, ['.js', '.html']).filter(f => !/node_modules|dev-fixtures|hub-client/.test(f))) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f);
    for (const lit of literals(src)) checkText(app, rel, lit);
    if (f.endsWith('.html')) {
      const re = />([^<>{}]*[А-Яа-яЁё][^<>{}]*)</g; let m;
      while ((m = re.exec(src))) checkText(app, rel, { text: m[1], line: src.slice(0, m.index).split('\n').length });
    }
  }
  for (const f of files(dir, ['.css']).filter(f => !/tokens\.css/.test(f))) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f);
    src.split('\n').forEach((l, i) => {
      if (/cubic-bezier\([^)]*-?\d*\.\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.\d+\s*,\s*1\.[1-9]/.test(l) || /\bbounce\b|elastic/i.test(l)) add('внимание', app, rel, i + 1, 'движение: пружина', 'перелёт в кривой движения — у Windows 11 движение без отскоков');
      if (/transition[^;]*\b(\d{4,})ms/.test(l)) add('сведения', app, rel, i + 1, 'движение: долго', 'переход дольше секунды');
    });
  }
}

// ───────── Сборка, самопроверки, снимки ─────────
function run(cmd, argv, cwd, timeout) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', timeout: timeout || 300000, windowsHide: true });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

const shots = [];
for (const a of apps) {
  const dir = path.join(root, a.dir);
  for (const f of files(path.join(dir, 'src'), ['.cs'])) checkCs(a.id, f, fs.readFileSync(f, 'utf8'), true);
  checkWindowsOf(a.id, dir);
  if (flag('--no-build')) continue;
  const b = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'build.ps1'], dir);
  const errs = (b.out.match(/ error CS\d+/g) || []).length;
  if (b.code !== 0 || errs) { add('ошибка', a.id, a.dir, 0, 'сборка', 'не собирается: ' + (b.out.split('\n').find(l => / error /.test(l)) || b.out.slice(-200))); results.push(a.id + ': сборка не прошла'); continue; }
  const t = run(path.join(dir, a.exe), ['--selftest'], dir);
  const last = t.out.split('\n').filter(Boolean).pop() || '';
  if (t.code !== 0) add('ошибка', a.id, a.dir, 0, 'самопроверка', t.out.split('\n').filter(l => /FAIL|Exception/.test(l)).slice(0, 5).join(' | ') || last);
  results.push(a.id + ': собрано, самопроверка — ' + (t.code === 0 ? last : 'НЕ ПРОШЛА'));
  for (const [name, argv] of a.shots) {
    const file = path.join(out, name + '.png');
    const s = run(path.join(dir, a.exe), argv.concat(['--shot', file]), dir, 60000);
    if (fs.existsSync(file)) shots.push([file, name]); else add('внимание', a.id, a.dir, 0, 'снимок', 'не получился снимок ' + name + ': ' + s.out.slice(-160));
  }
}

// Kapsula: свой интерфейс — проверяются тексты, папки, движение; сборка и её 491 проверка — по --kapsula-tests
if (fs.existsSync(kapsula)) {
  for (const f of files(path.join(kapsula, 'src'), ['.cs'])) checkCs('kapsula', f, fs.readFileSync(f, 'utf8'), false);
  if (flag('--kapsula-tests') && !flag('--no-build')) {
    const tmp = path.join(require('os').tmpdir(), 'kb-audit');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(kapsula, tmp, { recursive: true, filter: s => !/[\\/]\.git([\\/]|$)/.test(s) });
    const b = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'build.ps1'], tmp, 600000);
    if (b.code !== 0) add('ошибка', 'kapsula', 'repos/kapsula', 0, 'сборка', 'не собирается');
    else {
      const t = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests.ps1'], tmp, 900000);
      const line = t.out.split('\n').filter(Boolean).pop() || '';
      results.push('kapsula: собрано, проверки — ' + line.trim());
      if (/[1-9]\d*\s*$/.test(line) && !/: 0\s*$/.test(line)) add('ошибка', 'kapsula', 'repos/kapsula', 0, 'проверки', line.trim());
    }
  }
}
// Aura: синтаксис и тексты; запускать вторую Aura на компьютере нельзя — она пишет в настройки модуля микрофона
if (fs.existsSync(aura)) {
  checkWeb('aura', path.join(aura, 'app'));
  for (const f of ['main.js', 'preload.js', 'app/app.js']) {
    const r = run(process.execPath, ['--check', path.join(aura, f)], aura);
    if (r.code !== 0) add('ошибка', 'aura', 'repos/aura-voice/' + f, 0, 'синтаксис', r.out.slice(0, 200));
  }
  results.push('aura: синтаксис проверен (вторую Aura не запускаем)');
}

// Снимки рядом — одна семья видна только так
if (shots.length) {
  const sheet = path.join(__dirname, 'sheet.ps1');
  if (fs.existsSync(sheet)) run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sheet, '-Files', shots.map(s => s[0]).join(','), '-Labels', shots.map(s => s[1]).join(','), '-Out', path.join(out, 'family.png')], out);
}

// ───────── Отчёт ─────────
const order = { 'ошибка': 0, 'внимание': 1, 'сведения': 2 };
findings.sort((a, b) => order[a.level] - order[b.level] || a.app.localeCompare(b.app) || a.file.localeCompare(b.file) || a.line - b.line);
const count = l => findings.filter(f => f.level === l).length;
let md = '# Проверка приложений dev.txt\n\n';
md += 'Ошибок: ' + count('ошибка') + ' · внимание: ' + count('внимание') + ' · сведения: ' + count('сведения') + '\n\n';
if (results.length) md += '## Сборка и самопроверки\n\n' + results.map(r => '- ' + r).join('\n') + '\n\n';
if (shots.length) md += 'Снимки рядом: `family.png`\n\n';
for (const level of ['ошибка', 'внимание', 'сведения']) {
  const list = findings.filter(f => f.level === level);
  if (!list.length) continue;
  md += '## ' + level[0].toUpperCase() + level.slice(1) + '\n\n';
  const byRule = {};
  for (const f of list) (byRule[f.app + ' · ' + f.rule] = byRule[f.app + ' · ' + f.rule] || []).push(f);
  for (const [k, l] of Object.entries(byRule)) {
    md += '### ' + k + ' (' + l.length + ')\n\n';
    for (const f of l.slice(0, 12)) md += '- `' + f.file.replace(/\\/g, '/') + (f.line ? ':' + f.line : '') + '` — ' + f.text + '\n';
    if (l.length > 12) md += '- …и ещё ' + (l.length - 12) + '\n';
    md += '\n';
  }
}
fs.writeFileSync(path.join(out, 'REPORT.md'), md);
console.log('ошибок: ' + count('ошибка') + ', внимание: ' + count('внимание') + ', сведения: ' + count('сведения'));
console.log('отчёт: ' + path.join(out, 'REPORT.md'));
process.exitCode = count('ошибка') ? 1 : 0;
