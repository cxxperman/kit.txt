// kit.txt. tools/audit.js — проверка всех приложений dev.txt разом: сборка, самопроверки, снимки рядом и поиск
// ошибок, которые у нас уже случались (папки с именем продукта, мерцание полноэкранных окон, меню WinForms,
// цвета мимо темы, «прыгучее» движение, английский и неряшливый текст в интерфейсе), и договор семьи из kit.txt
// (hub/PROTOCOL.md, «Семья»): один значок в трее, уведомления на острове, общие страницы core.txt, копии общих файлов.
//
//   node tools/audit.js <папка, где лежат core, dock, smena, metla, template и repos/kapsula, repos/aura-voice>
//        [--no-build] [--kapsula-tests] [--out <папка для отчёта>]
//
// Ничего не запускает по-настоящему: только --selftest и --demo --shot (снимок без окна на экране).
// Не трогает ни работающие приложения, ни реестр, ни сеть. Отчёт — REPORT.md и family.png в папке --out.
// Проверки по исходникам без сборки — check(папка); их самих на учебных наборах проверяет tools/audit-test.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Приложения на общем каркасе kit.txt (C#, WPF) и два своих: Kapsula (C#, свой интерфейс) и Aura (Electron)
const APPS = [
  { id: 'core', dir: 'core', exe: 'Core.exe', shots: [['core', ['--demo']], ['core-settings', ['--demo', '--page', 'settings']]] },
  { id: 'dock', dir: 'dock', exe: 'Dock.exe', shots: [['dock', ['--demo']]] },
  { id: 'smena', dir: 'smena', exe: 'Smena.exe', shots: [['smena', ['--demo']], ['smena-about', ['--demo', '--about']]] },
  { id: 'metla', dir: 'metla', exe: 'Metla.exe', shots: [['metla', ['--demo']]] },
  { id: 'template', dir: 'template', exe: 'NewApp.exe', shots: [['newapp', ['--demo']]] },
];
let root = '', apps = [], kapsula = '', aura = '';
// Папка, где лежат все приложения, и что в ней есть
function setRoot(dir) {
  root = path.resolve(dir);
  apps = APPS.filter(a => fs.existsSync(path.join(root, a.dir)));
  kapsula = path.join(root, 'repos', 'kapsula');
  aura = path.join(root, 'repos', 'aura-voice');
}

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

// Строковые литералы C# и JS с номером строки; cs — у C# строк в `…` не бывает (обратная кавычка — просто знак)
function literals(src, cs) {
  const re = cs ? /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g : /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  const res = [];
  let m;
  while ((m = re.exec(src))) res.push({ text: m[0].slice(1, -1), line: src.slice(0, m.index).split('\n').length });
  return res;
}

const cyr = /[А-Яа-яЁё]/;
const PRODUCTS = ['Kapsula', 'Aura', 'Dock', 'Smena', 'Metla', 'Maska', 'Arkada', 'Core'];
const SHARED = /[\\/](Ui|Tokens|HubLink|CoreApp|Family)\.cs$/;   // копии из kit.txt: правятся только там

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
  const shared = SHARED.test(file);
  const lines = src.split('\n');
  const each = (re, fn) => lines.forEach((l, i) => { if (!/audit:ok/.test(l) && re.test(l)) fn(l, i + 1); });

  // Ошибка Kapsula 0.8.2: папка данных названа по имени продукта с «.txt» — прежние настройки пропадают
  // (общая папка «dev.txt» названа так нарочно — она не в счёт)
  each(/SpecialFolder\.\w+\)\s*,\s*"(kapsula|aura|dock|smena|metla|core|maska|arkada|newapp)\.txt"/i, (l, n) => add('ошибка', app, rel, n, 'логика: папка .txt', 'папка данных с именем «….txt»: у пользователей, обновившихся с прежней версии, пропадут настройки. Папки называются как раньше, без .txt'));
  // Тексты — строки кода; комментарии не в счёт (кавычка или «`» в комментарии не начинает строку)
  for (const lit of literals(mask(src, false).code, true)) checkText(app, rel, lit);
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
  const all = files(path.join(dir, 'src'), ['.cs']).filter(f => !SHARED.test(f));
  const text = all.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const layered = /AllowsTransparency\s*=\s*true/.test(text);
  const smooth = /Ui\.Native\(/.test(text) || /Ui\.Smooth\(/.test(text);
  const fullscreen = /Win\.Place\(|SystemParameters\.PrimaryScreenWidth|VirtualScreen|mon\.Right - mon\.Left/.test(text);
  if (layered && smooth && fullscreen && !/Ui\.AllowSmooth\s*=\s*false/.test(text))
    add('ошибка', app, path.relative(root, dir), 0, 'движение: мерцание', 'большое прозрачное окно и частота монитора вместе: на 144–180 Гц оно мерцает (так было с Alt+Tab в smena 0.3.0). Поставьте Ui.AllowSmooth = false в Main');
  for (const f of all) {
    const s = source(app, f, false), b = s.m.bare;   // по коду без комментариев: закомментированное не в счёт
    if (!/:\s*Window\b/.test(b) || /AllowsTransparency\s*=\s*true/.test(b) || /Ui\.Native\(/.test(b)) continue;
    const none = /\bWindowStyle\s*=\s*WindowStyle\.None\b/g;
    let r;
    while ((r = none.exec(b))) {
      // всплывающему окну без кнопки на панели задач (превью, подсказка, меню) рамка Windows и не нужна — если
      // ShowInTaskbar = false там же, где снята рамка: в том же конструкторе или new Window { … }, а не в обработчике
      // внутри (главное окно, которое прячется в трей, всплывающим от этого не становится)
      const n = s.line(r.index), o = opener(s.m, r.index, '{');
      if (s.ok(n) || (o && /\bShowInTaskbar\s*=\s*false\b/.test(flat(s.m, o.at)))) continue;
      add('внимание', app, s.rel, n, 'вид: своя рамка окна', 'окно без системной рамки и без Ui.Native — нет тени, прилипания к краям и кнопок Windows 11');
      break;   // одно на файл
    }
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

// ───────── Семья: одно место для общего (kit.txt, hub/PROTOCOL.md, «Семья» и «Кто за что отвечает») ─────────
// Только по исходникам: свой значок в трее при core.txt, уведомления мимо острова, запуск и игры на общих страницах
// core.txt, одна настройка в двух приложениях, порядок подключения Family, пункты общего трея, копии файлов kit.txt.
// kit.txt рядом с приложениями (в папке проверки), иначе тот, где лежит этот файл
const kitOf = () => fs.existsSync(path.join(root, 'kit', 'hub', 'Family.cs')) ? path.join(root, 'kit') : path.join(__dirname, '..');
const SECTIONS = ['games', 'startup', 'family'];
const STARTUP_KEY = /^(autostart|autorun|autoupdates?|checkupdates?|updates?|startwithwindows|openatlogin|runatlogin)$/i;
// Запуск вместе с Windows и обновления самого приложения — а не «Частота обновления погоды»
const STARTUP_LABEL = /вместе с windows|при входе в windows|автозапуск|автообновл|(проверять|проверка|искать|ставить|устанавливать|скачивать|загружать|получать)\s+(\S+\s+)?обновлени|обновлять(ся)?\s+(сам|автоматически)|нов(ые|ую) верси|^\s*обновлени[ея]\s*$/i;
const GAMES = /(^|[^а-яёa-z])игр(а|ы|е|у|ой|ах|ам|ами|овой|овом|овых|овые|овая|овое|овую)?(?![а-яёa-z])/i;
const FAMILY = /(другим|другими|другие|других|остальным|остальными|остальных) приложени|между приложени/i;
const TRAY_BANNED = /вместе с windows|обновлени|не беспокоить|core\.txt|^\s*(выход|выйти)\s*$/i;
const TRAY_BANNED_KEY = /^(autostart|autoupdates?|updates?|checkupdates?|focus|dnd|quit|exit|core)$/i;
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Исходник без комментариев, той же длины и с теми же строками: code — строки на месте, bare — их содержимое забито «_»
// (кавычки остаются). По bare ищутся имена и скобки (строки и комментарии не мешают), по code — значения строк.
function mask(src, js) {
  const code = src.split(''), bare = src.split('');
  const word = ch => /[\w$]/.test(ch || '');
  const regexAfter = /^(return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/;
  let i = 0, prev = '', last = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      let j = d === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      j = j < 0 ? src.length : d === '/' ? j : j + 2;
      for (let k = i; k < j; k++) if (src[k] !== '\n' && src[k] !== '\r') code[k] = bare[k] = ' ';
      i = j; continue;
    }
    let end = -1, from = i + 1;
    if (c === '"' || c === "'" || (js && c === '`')) end = quoteEnd(src, i, c);
    else if (!js && c === '@' && d === '"') { end = verbatimEnd(src, i + 1); from = i + 2; }
    else if (js && c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || (word(prev) && regexAfter.test(last)))) end = regexEnd(src, i);
    if (end > 0) {
      for (let k = from; k < end; k++) if (src[k] !== '\n' && src[k] !== '\r') bare[k] = '_';
      prev = '"'; last = '';
      i = src[end] === '\n' ? end : end + 1; continue;
    }
    if (!/\s/.test(c)) { last = word(c) ? (word(src[i - 1]) ? last + c : c) : ''; prev = c; }
    i++;
  }
  return { code: code.join(''), bare: bare.join('') };
}
// Закрывающая кавычка строки, начатой в i; строка оборвалась — перевод строки (у `…` переводы строк внутри можно)
function quoteEnd(src, i, q) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q || (src[j] === '\n' && q !== '`')) return j;
  }
  return src.length;
}
// @"…" в C#: кавычка внутри пишется дважды
function verbatimEnd(src, i) {
  for (let j = i + 1; j < src.length; j++) if (src[j] === '"') { if (src[j + 1] === '"') j++; else return j; }
  return src.length;
}
// /…/ в JS: закрывающая «/»; -1 — это было деление, а не регулярное выражение
function regexEnd(src, i) {
  let cls = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') return -1;
    if (cls) { if (c === ']') cls = false; } else if (c === '[') cls = true; else if (c === '/') return j;
  }
  return -1;
}

// Аргументы вызова, элементы списка или свойства объекта от открывающей скобки: [{ text, at }] и где скобка закрылась
function split(m, open) {
  const args = [];
  let depth = 0, start = open + 1;
  for (let i = open; i < m.bare.length; i++) {
    const ch = m.bare[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth === 0) { if (m.code.slice(start, i).trim() || args.length) args.push({ text: m.code.slice(start, i), at: start }); return { args, end: i }; }
    } else if (ch === ',' && depth === 1) { args.push({ text: m.code.slice(start, i), at: start }); start = i + 1; }
  }
  return { args, end: m.bare.length };
}
// Ближайшая скобка ch, внутри которой стоит позиция at; through — по дороге были другие скобки (вызов, список)
function opener(m, at, ch) {
  let depth = 0, through = false;
  for (let i = at - 1; i >= 0; i--) {
    const c = m.bare[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) { depth--; continue; }
      if (c === ch) return { at: i, through };
      through = true;
    }
  }
  return null;
}
// Значение, если аргумент — ровно одна строка ("…", @"…", '…', `…` без ${…}); иначе null
function str(text) {
  const t = (text || '').trim();
  let x = /^@"((?:[^"]|"")*)"$/.exec(t);
  if (x) return x[1].replace(/""/g, '"');
  x = /^(["'`])((?:(?!\1)[^\\]|\\.)*)\1$/.exec(t);
  if (!x || (x[1] === '`' && /\$\{/.test(x[2]))) return null;
  return x[2].replace(/\\(.)/g, (all, ch) => ch === 'n' ? '\n' : ch === 't' ? '\t' : ch);
}
// Свойства объекта { … } первого уровня: имя → текст значения
function props(m, open) {
  const map = {};
  for (const a of split(m, open).args) {
    const x = /^\s*(['"`]?)([\w$]+)\1\s*:\s*([\s\S]*)$/.exec(a.text);
    if (x) map[x[2]] = x[3].trim();
  }
  return map;
}
// Текст блока { … } без вложенных блоков: что сказано в нём самом, а не в обработчике или ветке внутри
function flat(m, open) {
  const end = split(m, open).end;
  let t = '', depth = 0;
  for (let i = open + 1; i < end; i++) {
    const c = m.bare[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    t += depth === 0 && c !== '}' ? c : ' ';
  }
  return t;
}

// Исходник для проверок семьи: разбор без комментариев, номера строк и пометка «// audit:ok — почему» на строке.
// tests — где в нём самопроверки (static class SelfTest, класс …Tests): то, что читают они, приложение ещё не делает
function source(app, file, js) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n'), m = mask(src, js), starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const line = at => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; } return lo + 1; };
  const tests = [], t = /\bclass\s+(?:\w*SelfTest\w*|\w*Tests)\b[^{;]*\{/g;
  let r;
  while (!js && (r = t.exec(m.bare))) tests.push([r.index, split(m, r.index + r[0].length - 1).end]);
  return { app, file, rel: path.relative(root, file), js, m, codeLines: m.code.split('\n'), line, tests, ok: n => /audit:ok/.test(lines[n - 1] || '') };
}
const within = (ranges, at) => ranges.some(r => at >= r[0] && at <= r[1]);
// Строка с проверкой Check(…) — тоже самопроверка, даже вне её класса
const checkLine = (s, at) => /\bCheck\s*\(/.test(s.codeLines[s.line(at) - 1] || '');

// Где приложение на деле пользуется name (HideOwnTray, SetTray): [{ s, at }]. Не в счёт объявление с таким именем
// вместе с его телом — обёртка public static bool HideOwnTray { get { return family.HideOwnTray; } } сама ничего
// не прячет, — самопроверки и строки Check(…). call — нужен вызов name(…), а не просто имя.
function uses(srcs, name, call) {
  const found = [];
  const decl = new RegExp('\\b(?!(?:return|new|else|do|await|throw|case|goto|in|is|as|out|ref|yield|params|typeof|sizeof|nameof|using|lock)\\b)[\\w>\\]?]+\\s+' + esc(name) + '\\s*(\\{|\\(|=>|=(?!=)|;)', 'g');
  for (const s of srcs) {
    const b = s.m.bare, skip = s.tests.slice();
    let d;
    decl.lastIndex = 0;
    while ((d = decl.exec(b))) {
      const at = d.index + d[0].length - d[1].length;   // где начинается тело: «{», «(», «=>», «=» или «;»
      let end = b.indexOf(';', at);
      if (d[1] === '{') end = split(s.m, at).end;
      else if (d[1] === '(') {   // метод: параметры, потом тело { … } или => …;
        const p = split(s.m, at).end, body = /^\s*\{/.exec(b.slice(p + 1));
        end = body ? split(s.m, p + body[0].length).end : b.indexOf(';', p);
      }
      skip.push([d.index, end < 0 ? b.length : end]);
    }
    const re = new RegExp('\\b' + esc(name) + '\\b' + (call ? '\\s*\\(' : ''), 'g');
    let r;
    while ((r = re.exec(b))) if (!within(skip, r.index) && !checkLine(s, r.index)) found.push({ s, at: r.index });
  }
  return found;
}
// То же для приметы re (State.Tray и т. п.): есть ли она вне самопроверок
const present = (srcs, re) => srcs.some(s => { const g = new RegExp(re.source, 'g'); let r; while ((r = g.exec(s.m.bare))) if (!within(s.tests, r.index) && !checkLine(s, r.index)) return true; return false; });

// Строки из списка в том же файле: string[] labels = { "Музыка", … } → ["Музыка", …] (не строка — null)
function list(s, name) {
  const x = new RegExp('\\b' + esc(name) + '\\s*=\\s*(?:new\\s*(?:[\\w.]+\\s*)?\\[\\s*\\]\\s*)?\\{').exec(s.m.bare);
  return x ? split(s.m, x.index + x[0].length - 1).args.map(a => str(a.text)) : [];
}
// Строковая константа в том же файле: const string TrayAutoHide = "autoHide" (в JS — const STARTUP = 'startup')
function constant(s, name) {
  const x = new RegExp('\\b' + esc(name) + '\\s*=\\s*(["\'`])([^"\'`\\\\\\n]*)\\1').exec(s.m.code);
  return x ? x[2] : null;
}
// Значение аргумента: строка или имя строковой константы (Sections.Startup → Startup = "startup"); иначе null
function value(s, text) {
  const v = str(text), id = /^(?:\w+\.)*(\w+)$/.exec((text || '').trim());
  return v !== null ? v : id ? constant(s, id[1]) : null;
}
// В исходнике есть строка ровно want ("notify", 'core.family'), а не кусок другой строки и не комментарий
function literal(s, want) {
  const re = new RegExp('(["\'`])' + esc(want) + '\\1', 'g'); let x;
  while ((x = re.exec(s.m.code))) if (s.m.bare[x.index] === x[1] && s.m.bare[x.index + x[0].length - 1] === x[1]) return true;
  return false;
}
// section, заданный для пункта в другом месте файла — по коду без комментариев, через строки:
// словарём { "autostart", "startup" } или .Add("autostart", "startup") (в JS — autostart: 'startup'),
// веткой switch: case "autostart": … return "startup"; (case подряд, на одной строке или на разных),
// условием с ключом: key == "autostart" ? "startup" : …, Has("x") ? "games" : …, if (key == "autostart") item["section"] = "startup";
// Сами пункты и группы ({ title, section, items }) сюда не попадают: section у группы core.txt не читает.
// Пункт узнаётся по ключу или подписи, а не по переменной: два пункта с одним ключом получат один section.
function assoc(s, names) {
  const m = s.m, Q = '["\'`]', SEC = '(games|startup|family)';
  const real = x => m.bare[x.index] === m.code[x.index];   // совпадение начинается в коде, а не внутри строки
  for (const n of names.filter(z => typeof z === 'string' && z)) {
    const q = esc(n);
    let re = s.js ? new RegExp('(?:^|[{,\\s])(' + Q + '?)' + q + '\\1\\s*:\\s*' + Q + SEC + Q, 'g')
      : new RegExp('(?:\\{|\\bAdd\\s*\\()\\s*"' + q + '"\\s*,\\s*"' + SEC + '"\\s*[})]', 'g');
    let x;
    while ((x = re.exec(m.code))) if (real(x)) return x[x.length - 1];
    re = new RegExp('\\bcase\\s+' + Q + q + Q + '\\s*:', 'g');
    while ((x = re.exec(m.code))) {
      if (!real(x)) continue;
      const v = caseValue(m, x.index + x[0].length);
      if (v !== undefined) return v;   // null — ветка этого ключа возвращает «без section»
    }
    re = new RegExp('(["\'`])' + q + '\\1', 'g');   // ключ строкой где угодно в коде: что стоит за ним в условии
    while ((x = re.exec(m.code))) {
      if (!real(x)) continue;
      const v = pairAfter(m, x.index + x[0].length);
      if (v) return v;
    }
  }
  return null;
}
// Ветка switch от «case "ключ":» до return, break или конца switch (несколько case подряд — одна ветка):
// "startup" — section ключа (return "startup" или x = "startup" перед break); null — ветка возвращает null;
// undefined — ветка не про section (обработчик settings.set и т. п.)
function caseValue(m, from) {
  const b = m.bare;
  let depth = 0;
  for (let i = from; i < b.length; i++) {
    const c = b[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) return undefined; }
    else if (depth === 0 && /[a-z]/.test(c) && !/[\w$]/.test(b[i - 1] || '')) {
      const w = /^(return|break|goto|throw|continue)\b/.exec(b.slice(i, i + 9));
      if (!w) continue;
      if (w[1] === 'return') {
        const x = /^return\s+(["'`])(games|startup|family)\1\s*;/.exec(m.code.slice(i));
        return x ? x[2] : /^return\s+null\s*;/.test(m.code.slice(i)) ? null : undefined;
      }
      if (w[1] !== 'break') return undefined;
      const x = /\b[\w$\]"'`[]+\s*=(?!=)\s*(["'`])(games|startup|family)\1\s*;/.exec(m.code.slice(from, i));
      return x ? x[2] : undefined;
    }
  }
  return undefined;
}
// Что стоит за ключом в условии (at — сразу за его строкой): … ? "startup" : … — или, если ключ в условии if,
// section, назначенный в ветке этого if: if (key == "autostart") item["section"] = "startup";
// Ключ в самом пункте, в списке или в результате ?: — ни то ни другое: null
function pairAfter(m, at) {
  const b = m.bare;
  let depth = 0;
  for (let i = at; i < b.length; i++) {
    const c = b[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '?' && depth <= 0 && b[i + 1] !== '?' && b[i + 1] !== '.' && b[i - 1] !== '?') {
      const x = /^\?\s*(["'`])(games|startup|family)\1/.exec(m.code.slice(i));
      return x ? x[2] : null;
    } else if (c === ';' || c === '{' || c === '}' || (depth <= 0 && (c === ':' || c === ','))) break;
  }
  let o = opener(m, at, '(');
  while (o && !o.through && !/\bif\s*$/.test(b.slice(Math.max(0, o.at - 12), o.at))) o = opener(m, o.at, '(');
  if (!o || o.through) return null;
  let body = split(m, o.at).end + 1;
  while (/\s/.test(b[body] || '')) body++;
  const end = b[body] === '{' ? split(m, body).end : b.indexOf(';', body);
  const x = /(?:\[\s*(["'`])section\1\s*\]|\.\s*section\b|\bsection\b)\s*=(?!=)\s*(["'`])(games|startup|family)\2/.exec(m.code.slice(body, end < 0 ? b.length : end + 1));
  return x ? x[3] : null;
}

// Пункты <app>.settings на C#: HubLink.Msg("key", …, "type", …, "label", …) с подписью строкой, подписи из списка
// (labels[i], как виджеты dock.txt) и описания Add("группа", "ключ", "подпись", …), как Describe у kapsula.txt.
// sec — section пункта: строка, '?' (задан выражением, не разобрать) или null; form — как пункт описан: 'msg' или 'add'.
function csSettings(s) {
  const out = [], m = s.m;
  if (!/"label"/.test(m.code) || !/"key"/.test(m.code)) return out;
  const writes = literal(s, 'section');   // приложение вообще пишет поле section
  const one = (key, label, sec, line, group) => out.push({ app: s.app, rel: s.rel, line, key, label, group: group || null, sec, form: group === undefined ? 'msg' : 'add', ok: s.ok(line) });
  let described = false;
  const re = /\bMsg\s*\(/g; let r;
  while ((r = re.exec(m.bare))) {
    const open = r.index + r[0].length - 1, call = split(m, open), a = call.args;
    if (a.length < 6 || str(a[0].text) !== 'key') continue;
    const p = {};
    for (let k = 0; k + 1 < a.length; k += 2) { const n = str(a[k].text); if (n) p[n] = a[k + 1].text.trim(); }
    if (!('label' in p) || !('type' in p)) continue;
    // section у самого пункта — или строкой ниже: item["section"] = … (условное со строкой разберёт assoc)
    let sec = 'section' in p ? p.section : null;
    const v = /(\w+)\s*=\s*(?:[\w.]+\.)?$/.exec(m.bare.slice(Math.max(0, r.index - 80), r.index));
    if (sec === null && v) {   // до следующего пункта: чужой item["section"] не в счёт
      const next = m.bare.slice(call.end).search(/\bMsg\s*\(/), stop = next < 0 ? call.end + 2000 : Math.min(call.end + next, call.end + 2000);
      const w = new RegExp('^([^\\n]*)\\b' + v[1] + '\\s*\\[\\s*"section"\\s*\\]\\s*=\\s*([^;\\n]+);', 'm').exec(m.code.slice(call.end, stop));
      if (w && !(str(w[2]) !== null && /\bif\s*\(|\?/.test(w[1]))) sec = w[2].trim();
    }
    const line = s.line(r.index), key = str(p.key), label = str(p.label);
    if (label !== null) {
      let v2 = sec === null ? null : value(s, sec);
      if (v2 === null && writes) v2 = assoc(s, [key, label]);
      if (v2 === null && sec !== null) v2 = '?';
      one(key, label, v2, line);
      continue;
    }
    const li = /^(\w+)\s*\[\s*\w+\s*\]$/.exec(p.label);
    if (li) {   // подписи из списка: labels[i], ключи — WidgetKeys[i]
      const ki = /^([\w.]+)\s*\[\s*\w+\s*\]$/.exec(p.key), keys = ki ? list(s, ki[1].split('.').pop()) : [];
      const si = sec && /^(\w+)\s*\[\s*\w+\s*\]$/.exec(sec), secs = si ? list(s, si[1]) : null;
      list(s, li[1]).forEach((l, i) => {
        if (l === null) return;
        const k = keys[i] === undefined ? null : keys[i];
        let v2 = secs ? (secs[i] === undefined ? null : secs[i]) : sec === null ? null : value(s, sec);
        if (v2 === null && writes) v2 = assoc(s, [k, l]);
        if (v2 === null && sec !== null && !secs) v2 = '?';
        one(k, l, v2, line);
      });
      continue;
    }
    if (/^\w+\.\w+$/.test(p.label) && !described) {   // f.Label: пункты описаны вызовами Add("группа", "ключ", "подпись", …)
      described = true;
      const add = /\bAdd\s*\(/g; let x;
      while ((x = add.exec(m.bare))) {
        const d = split(m, x.index + x[0].length - 1).args;
        const group = d.length > 2 ? str(d[0].text) : null, k = d.length > 2 ? str(d[1].text) : null, l = d.length > 2 ? str(d[2].text) : null;
        if (k === null || l === null || !/^[a-z][A-Za-z0-9]*$/.test(k) || !cyr.test(l)) continue;
        let v2 = null;
        if (sec !== null || writes) v2 = (sec !== null && str(sec) !== null ? str(sec) : null) || d.slice(3).map(z => str(z.text)).find(z => SECTIONS.includes(z)) || assoc(s, [k, l, group]);
        one(k, l, v2, s.line(x.index), group);
      }
    }
  }
  return out;
}

// Подпись переключателя или списка в разметке окна: <label …><b>Подпись</b>…<input id="autostart"></label>
function htmlLabel(html, id) {
  const at = Math.max(html.indexOf('id="' + id + '"'), html.indexOf("id='" + id + "'"));
  if (at < 0) return null;
  const from = html.lastIndexOf('<label', at), to = html.indexOf('</label>', at);
  if (from < 0 || to < 0 || html.indexOf('</label>', from) < at) return null;
  const x = /<b>([^<]+)<\/b>/.exec(html.slice(from, to)) || /<span>([^<]+)<\/span>/.exec(html.slice(from, to));
  return x ? x[1].trim() : null;
}
// Функция перед позицией at с параметром param: const hubSwitch = (id, section) => { … return { key: id, … } }.
// { name, writes } — writes: тело функции пишет section (у объекта или потом: item.section = section)
function helperOf(m, at, param) {
  const head = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\(([^()]*)\)|([\w$]+))\s*=>|\bfunction\s+([\w$]+)\s*\(([^()]*)\)/g;
  head.lastIndex = Math.max(0, at - 3000);
  let h, found = null;
  while ((h = head.exec(m.bare)) && h.index < at) {
    if ((h[2] || h[3] || h[5] || '').split(',').map(z => z.trim().replace(/\s*=[\s\S]*$/, '')).includes(param)) found = { name: h[1] || h[4], at: h.index, body: h.index + h[0].length };
  }
  if (!found) return null;
  const b = m.bare.indexOf('{', found.body), end = b < 0 ? at : split(m, b).end;
  return { name: found.name, writes: /\.\s*section\s*=(?!=)|\bsection\s*:/.test(m.bare.slice(found.body, end)) || /\[\s*['"`]section['"`]\s*\]\s*=(?!=)/.test(m.code.slice(found.body, end)) };
}

// Пункты <app>.settings на JS (aura.txt): объекты { key: '…', type: '…', label: '…' } и помощники вроде
// hubSwitch('autostart'), которые берут подпись из окна. section — у самого объекта ({ ...hubSwitch('x'), section: 'startup' }),
// аргументом помощника или словарём; section у группы core.txt не читает — он не в счёт.
function jsSettings(s, html) {
  const out = [], m = s.m;
  if (!/\bkey\s*:/.test(m.bare) || !/\blabel\s*:/.test(m.bare)) return out;
  const writes = /\bsection\b/.test(m.bare) || /['"`]section['"`]/.test(m.code);
  const one = (key, label, sec, line) => out.push({ app: s.app, rel: s.rel, line, key, label, group: null, sec, form: 'js', ok: s.ok(line) });
  const seen = new Set(), helpers = [];
  const re = /\bkey\s*:/g; let r;
  while ((r = re.exec(m.bare))) {
    const o = opener(m, r.index, '{');
    if (!o || o.through || seen.has(o.at)) continue;
    seen.add(o.at);
    const p = props(m, o.at);
    if (!('label' in p) || !('type' in p) || !('key' in p)) continue;
    const key = str(p.key), label = str(p.label), sec = 'section' in p ? p.section : null;
    if (key === null) {   // помощник: key: id — подпись приходит из окна, section — аргументом или словарём
      const h = helperOf(m, o.at, p.key);
      if (h && !helpers.some(x => x.name === h.name)) helpers.push({ name: h.name, writes: h.writes, lit: sec === null ? null : str(sec) });
      continue;
    }
    if (label === null) continue;
    let v = sec === null ? null : value(s, sec);
    if (v === null && writes) v = assoc(s, [key, label]);
    if (v === null && sec !== null) v = '?';
    one(key, label, v, s.line(o.at));
  }
  for (const h of helpers) {
    const call = new RegExp('\\b' + esc(h.name) + '\\s*\\(', 'g'); let c;
    while ((c = call.exec(m.bare))) {
      const a = split(m, c.index + c[0].length - 1).args, id = a.length ? str(a[0].text) : null;
      if (id === null) continue;
      const label = htmlLabel(html, id) || id;
      let v = h.lit;
      if (v === null && h.writes) v = a.slice(1).map(z => value(s, z.text)).find(z => SECTIONS.includes(z)) || null;
      if (v === null) { const o = opener(m, c.index, '{'); if (o && !o.through) { const p = props(m, o.at); if ('section' in p) v = value(s, p.section) || '?'; } }
      if (v === null && writes) v = assoc(s, [id, label]);
      one(id, label, v, s.line(c.index));
    }
  }
  return out;
}

// Правила 3 и 4: запуск и обновления, игры, связь между приложениями — на общих страницах core.txt;
// одна и та же подпись настройки в двух приложениях — одна вещь в двух местах
function checkSettings(items) {
  const norm = t => t.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`.,:;!?()\-—–…]/g, ' ').replace(/\s+/g, ' ').trim();
  // как дать пункту section: у HubLink.Msg — парой аргументов, у объекта JS — свойством, у описаний Add(…) — где их собирают
  const fix = (it, v) => it.form === 'js' ? "добавьте пункту section: '" + v + "'" : it.form === 'add' ? 'пункту нужен section "' + v + '" там, где section назначается пунктам из Add(…)' : 'добавьте в HubLink.Msg пункта "section", "' + v + '"';
  const same = {};
  for (const it of items) {
    if (it.ok) continue;
    const startup = (it.key && STARTUP_KEY.test(it.key)) || STARTUP_LABEL.test(it.label);
    const games = !startup && ((it.key && /game/i.test(it.key)) || GAMES.test(it.label));
    const kin = !startup && !games && (FAMILY.test(it.label) || (it.group && FAMILY.test(it.group)));
    const name = '«' + it.label + '»' + (it.key ? ' (' + it.key + ')' : ''), has = it.sec ? ' с "section": "' + it.sec + '"' : ' без section';
    if (startup && it.sec !== 'startup' && it.sec !== '?')
      add('ошибка', it.app, it.rel, it.line, 'семья: запуск и обновления', 'пункт ' + name + has + ' — запуск вместе с Windows и обновления всех приложений core.txt показывает на одной странице «Общие» → «Запуск и обновления». Ключ и значение не меняются: ' + fix(it, 'startup'));
    else if (games && it.sec !== 'games' && it.sec !== '?')
      add('внимание', it.app, it.rel, it.line, 'семья: игры', 'пункт ' + name + has + ' — что каждое приложение делает, пока впереди игра, core.txt собирает на странице «Игры»: ' + fix(it, 'games'));
    else if (kin && !it.sec)
      add('сведения', it.app, it.rel, it.line, 'семья: связь между приложениями', 'пункт ' + name + ' — о том, чем приложение делится с остальными: его место в core.txt — «Общие» → «Связь между приложениями»: ' + fix(it, 'family'));
    // шаблон — пример, а у пунктов общих страниц одинаковые подписи нарочно: core.txt ставит их рядом
    if (startup || games || kin || it.sec || it.app === 'template') continue;
    const k = norm(it.label);
    if (k) (same[k] = same[k] || []).push(it);
  }
  for (const group of Object.values(same)) {
    if (new Set(group.map(i => i.app)).size < 2) continue;
    for (const it of group) {
      const others = group.filter(o => o.app !== it.app).map(o => o.app + ' (`' + o.rel.replace(/\\/g, '/') + ':' + o.line + '`)');
      add('внимание', it.app, it.rel, it.line, 'семья: настройка в двух приложениях', 'подпись «' + it.label + '» есть и у ' + others.join(', ') + ': если это одна и та же настройка — у неё одно место (одна вещь — одно место); если разные — назовите так, чтобы их было не спутать');
    }
  }
}

// Пункт общего трея (<app>.tray): без общих пунктов core.txt и без названия приложения в подписи; show — «Открыть»
function trayItem(s, product, key, label, n) {
  if (s.ok(n)) return;
  if ((label && TRAY_BANNED.test(label)) || (key && TRAY_BANNED_KEY.test(key)))
    add('ошибка', s.app, s.rel, n, 'семья: пункты трея', 'пункт «' + (label || key) + '» в ' + s.app + '.tray: «Запускать вместе с Windows», «Проверить обновления», «Не беспокоить», «Открыть core.txt» и «Выход» в меню core.txt общие — приложение их туда не кладёт');
  else if (label && label.toLowerCase().includes(product))
    add('внимание', s.app, s.rel, n, 'семья: пункты трея', 'подпись «' + label + '» с названием приложения — в меню core.txt оно уже стоит над пунктами: «Открыть», а не «Открыть ' + product + '»');
  else if (key === 'show' && label && label !== 'Открыть')
    add('сведения', s.app, s.rel, n, 'семья: пункты трея', 'пункт show подписан «' + label + '», а в договоре (kit.txt, hub/PROTOCOL.md, «Один значок в трее») он у всех «Открыть». Если так задумано (окно приложения — его настройки), договор стоит уточнить в kit.txt, а здесь — пометка «// audit:ok — почему»');
}

// Правила для приложения на C#: значок в трее, уведомления, порядок Family, пункты общего трея
function familyCs(a) {
  // что приложение делает на деле — не объявления обёрток и не самопроверки: читает HideOwnTray (или State.Tray),
  // зовёт SetTray, назначает Changed у своего Family
  const hides = uses(a.srcs, 'HideOwnTray').length > 0 || present(a.srcs, /\bState\s*\.\s*Tray\b/);
  const tray = uses(a.srcs, 'SetTray', true).length > 0, fams = [];
  for (const s of a.srcs) for (const x of s.m.bare.matchAll(/\b(\w+)\s*=\s*new\s+(?:DevTxt\s*\.\s*)?Family\s*\(/g)) if (!within(s.tests, x.index)) fams.push(x[1]);
  const changed = fams.some(f => present(a.srcs, new RegExp('\\b' + f + '\\s*\\.\\s*Changed\\s*\\+?=(?!=)')));
  for (const s of a.srcs) {
    const m = s.m;
    let r;
    // 1. Значок в трее у семьи один — у core.txt; свой — только пока его нет на связи
    const icon = /\bnew\s+(?:[\w.]+\.)?NotifyIcon\s*[({]/g;
    while (a.id !== 'core' && (r = icon.exec(m.bare))) {
      const n = s.line(r.index);
      if (s.ok(n)) continue;
      if (!hides) add('ошибка', a.id, s.rel, n, 'семья: свой значок в трее', 'свой значок в трее, а HideOwnTray у Family нигде не читается (обёртка и самопроверки не в счёт): пока core.txt на связи и в core.family.tray — true, у семьи один значок — у core.txt, а свой прячется; связь пропала — сразу появляется снова (kit.txt, hub/PROTOCOL.md, «Семья»)');
      else if (!tray) add('внимание', a.id, s.rel, n, 'семья: свой значок в трее', 'свой значок прячется, а пункты для меню core.txt никто не отдаёт (SetTray у Family не вызывается) — из общего трея приложение не открыть');
      else if (fams.length && !changed)
        add('сведения', a.id, s.rel, n, 'семья: свой значок в трее', 'HideOwnTray читается, а ' + fams[0] + '.Changed не назначен — значок вернётся, когда связь пропадёт, только если вы проверяете это сами');
    }
    // 2. Короткие сообщения — острову kapsula.txt; своё уведомление Windows — только когда острова нет
    const island = /\b(?!this\b)[A-Za-z_]\w*\s*\.\s*Notify\s*\(|\bIslandOnline\b|\bNotifyCommand\b/.test(m.bare) || literal(s, 'notify');
    const balloon = /\.\s*ShowBalloonTip\s*\(/g;
    while (a.id !== 'kapsula' && !island && (r = balloon.exec(m.bare))) {
      const n = s.line(r.index);
      if (!s.ok(n)) add('внимание', a.id, s.rel, n, 'семья: уведомление мимо острова', 'уведомление мимо острова: в этом файле нет попытки отдать его kapsula.txt (family.Notify) — своё уведомление Windows только тогда, когда Notify вернул false');
    }
    // 7. new Family(link, …) — после своих Topics, Commands и обработчиков и до link.Start()
    const made = /\bnew\s+(?:DevTxt\s*\.\s*)?Family\s*\(\s*([\w.]+)\s*,/g;
    while ((r = made.exec(m.bare))) {
      const n = s.line(r.index), link = esc(r[1].replace(/^this\./, ''));
      if (s.ok(n)) continue;
      const start = new RegExp('\\b' + link + '\\s*\\.\\s*Start\\s*\\(', 'g'), hub = new RegExp('\\b' + link + '\\s*=\\s*new\\s+(?:DevTxt\\s*\\.\\s*)?HubLink\\s*\\(', 'g');
      let h = -1, x;
      while ((x = hub.exec(m.bare)) && x.index < r.index) h = x.index;
      start.lastIndex = Math.max(0, h);
      if (h >= 0 && (x = start.exec(m.bare)) && x.index < r.index)
        add('ошибка', a.id, s.rel, n, 'семья: порядок Family', 'new Family(…) после ' + r[1] + '.Start(): подписка на core.family и hub.apps и команда tray.run уходят при подключении — создавайте Family до Start()');
      // свои обработчики после new Family — до link.Start(), а если Start() не в этом блоке (Wire() у metla.txt отдаёт
      // связь наружу, Start() зовут в другом месте) — до конца блока, где создан Family
      const block = opener(m, r.index, '{'), blockEnd = block ? split(m, block.at).end : m.bare.length;
      start.lastIndex = r.index;
      const end = (x = start.exec(m.bare)) && x.index < blockEnd ? x.index : blockEnd;
      const late = new RegExp('\\b' + link + '\\s*\\.\\s*(Topics|Commands|OnState|OnCommand|OnStatus)\\s*=(?!=)', 'g');
      late.lastIndex = r.index;
      while ((x = late.exec(m.bare)) && x.index < end)
        if (!s.ok(s.line(x.index))) add('ошибка', a.id, s.rel, s.line(x.index), 'семья: порядок Family', r[1] + '.' + x[1] + ' назначен после new Family(…) и затирает то, что добавил Family (core.family, hub.apps, tray.run). Свои обработчики — до new Family');
    }
    // 8. Пункты общего трея: не больше четырёх, «Открыть» первым, без общих пунктов core.txt
    if (a.id === 'core') continue;   // меню core.txt — то самое общее меню: там эти пункты и живут
    const item = /\bnew\s+(?:DevTxt\s*\.\s*)?TrayItem\s*\(/g, lists = new Set();
    while ((r = item.exec(m.bare))) {
      const t = split(m, r.index + r[0].length - 1).args;
      const key = t.length ? str(t[0].text) || (/^\w+$/.test(t[0].text.trim()) ? constant(s, t[0].text.trim()) : null) : null;
      trayItem(s, a.product, key, t.length > 1 ? str(t[1].text) : null, s.line(r.index));
      const o = opener(m, r.index, '{');
      if (o && !o.through) lists.add(o.at);
    }
    for (const at of lists) {
      const els = split(m, at).args.filter(e => /\bnew\s+(?:DevTxt\s*\.\s*)?TrayItem\s*\(/.test(e.text)), n = s.line(at);
      if (s.ok(n)) continue;
      if (els.length > 4) add('внимание', a.id, s.rel, n, 'семья: пункты трея', 'пунктов ' + els.length + ' — core.txt покажет только первые четыре (Family.MaxTray): в общий трей — самое частое, редкое остаётся в окне');
      if (els.findIndex(e => /TrayItem\s*\(\s*"show"/.test(e.text)) > 0) add('внимание', a.id, s.rel, n, 'семья: пункты трея', 'пункт «Открыть» (show) не первый — в меню core.txt он у всех приложений первым');
    }
  }
}

// То же для приложения на JS (aura.txt): значок Tray, уведомления, пункты <app>.tray и команда tray.run
function familyJs(a) {
  // помощник семьи (family.js у aura.txt — то же, что Family.cs для C#): в нём core.family, setTray и tray.run есть
  // всегда, поэтому подключилось ли приложение к семье, видно только по остальным его файлам
  const own = a.srcs.filter(s => !/\bclass\s+Family\b/.test(s.m.bare));
  const bare = own.map(s => s.m.bare).join('\n'), any = t => own.some(s => literal(s, t));
  const fams = [...bare.matchAll(/\b([\w$]+)\s*=\s*new\s+Family\s*\(/g)].map(x => x[1]);
  const icons = [...bare.matchAll(/\b([\w$]+)\s*=\s*new\s+Tray\s*\(/g)].map(x => x[1]);
  const family = any('core.family') || /\.\s*hideOwnTray\b/.test(bare);
  const destroys = icons.some(t => new RegExp('\\b' + esc(t) + '\\s*\\??\\.\\s*destroy\\s*\\(').test(bare));
  const tray = any(a.id + '.tray') || /\.\s*setTray\s*\(/.test(bare);   // своим hub.state или через Family
  const run = any('tray.run') || fams.some(f => new RegExp('\\b' + esc(f) + '\\s*\\.\\s*wrap\\s*\\(').test(bare));
  for (const s of a.srcs) {
    const m = s.m;
    let r;
    const icon = /\bnew\s+Tray\s*\(/g;
    while ((r = icon.exec(m.bare))) {
      const n = s.line(r.index);
      if (s.ok(n)) continue;
      if (!family) add('ошибка', a.id, s.rel, n, 'семья: свой значок в трее', 'значок в трее создаётся всегда: ни core.family, ни hideOwnTray у Family приложение не читает (помощник семьи не в счёт). Пока core.txt на связи и в core.family.tray — true, у семьи один значок — у core.txt: свой убирается, а связь пропала — сразу создаётся снова');
      else if (!destroys) add('внимание', a.id, s.rel, n, 'семья: свой значок в трее', 'свой значок в трее нигде не убирается (нет ' + (icons[0] || 'tray') + '.destroy()): у Tray в Electron нет «спрятать» — только destroy(), а когда связь пропала — new Tray() снова');
      else if (!tray) add('внимание', a.id, s.rel, n, 'семья: свой значок в трее', 'свой значок прячется, а ' + a.id + '.tray никто не отдаёт (setTray у Family не вызывается) — из общего трея core.txt приложение не открыть');
    }
    const island = literal(s, 'notify') || /\.\s*notify\s*\(/.test(m.bare);
    const balloon = /\.\s*displayBalloon\s*\(|\bnew\s+Notification\s*\(/g;
    while (!island && (r = balloon.exec(m.bare))) {
      const n = s.line(r.index);
      if (!s.ok(n)) add('внимание', a.id, s.rel, n, 'семья: уведомление мимо острова', 'уведомление мимо острова: в этом файле нет попытки отдать его kapsula.txt (команда notify, если в hub.apps у kapsula она есть) — своё уведомление Windows только без острова');
    }
    if (!tray) continue;
    // пункты трея — объекты { key, label } без type (у пунктов настроек type есть); в списке — не больше четырёх, «Открыть» первым
    const done = new Set(), lists = new Set(), re = /\bkey\s*:/g;
    const item = at => { const p = props(m, at); return 'key' in p && 'label' in p && !('type' in p) ? p : null; };
    while ((r = re.exec(m.bare))) {
      const o = opener(m, r.index, '{');
      if (!o || o.through || done.has(o.at)) continue;
      done.add(o.at);
      const p = item(o.at);
      if (!p) continue;
      trayItem(s, a.product, str(p.key), str(p.label), s.line(o.at));
      const l = opener(m, o.at, '[');
      if (l && !l.through) lists.add(l.at);
    }
    for (const at of lists) {
      const n = s.line(at), keys = [];
      for (const e of split(m, at).args) {
        const b = e.at + e.text.search(/\S/), p = m.bare[b] === '{' ? item(b) : null;
        if (p) keys.push(str(p.key));
      }
      if (s.ok(n)) continue;
      if (keys.length > 4) add('внимание', a.id, s.rel, n, 'семья: пункты трея', 'пунктов ' + keys.length + ' — core.txt покажет только первые четыре: в общий трей — самое частое, редкое остаётся в окне');
      if (keys.indexOf('show') > 0) add('внимание', a.id, s.rel, n, 'семья: пункты трея', 'пункт «Открыть» (show) не первый — в меню core.txt он у всех приложений первым');
    }
  }
  if (tray && !run) add('ошибка', a.id, path.relative(root, a.dir), 0, 'семья: пункты трея', a.id + '.tray отдаётся, а команды tray.run нет (ни своей, ни через wrap() у Family): пункты в меню core.txt не сработают');
}

// 5. Общие файлы — копии из kit.txt как есть (tools/sync.ps1); рядом с HubLink.cs обязательно лежит Family.cs
const COPIES = [['Tokens.cs', 'dist/Tokens.cs'], ['Ui.cs', 'ui/Ui.cs'], ['HubLink.cs', 'hub/HubLink.cs'], ['CoreApp.cs', 'hub/CoreApp.cs'], ['Family.cs', 'hub/Family.cs']];
function sameFile(a, b) {
  const read = f => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return read(a) === read(b);
}
function checkCopies(app, dir) {
  const kit = kitOf(), sync = fs.existsSync(path.join(dir, 'tools', 'sync.ps1'));   // sync.ps1 есть не у всех приложений
  const bring = sync ? 'копия приносится заново: tools/sync.ps1 <папка kit.txt>' : 'файл заново копируется из kit.txt как есть';
  for (const [name, from] of COPIES) {
    const mine = path.join(dir, 'src', name), kitFile = path.join(kit, from);
    if (!fs.existsSync(kitFile)) continue;
    if (!fs.existsSync(mine)) {
      if (name === 'Family.cs' && fs.existsSync(path.join(dir, 'src', 'HubLink.cs')))
        add('ошибка', app, path.relative(root, path.join(dir, 'src')), 0, 'общие файлы: копия kit', 'рядом с HubLink.cs нет Family.cs — ' + (sync ? 'принесите его из kit.txt: tools/sync.ps1 <папка kit.txt>' : 'скопируйте hub/Family.cs из kit.txt как есть') + '. Без него приложение не узнает об общем трее, «Не беспокоить», игре на весь экран и острове');
      continue;
    }
    if (!sameFile(mine, kitFile))
      add('ошибка', app, path.relative(root, mine), 0, 'общие файлы: копия kit', name + ' не совпадает с kit.txt (' + from + '): общие файлы не правятся в приложении — меняется kit.txt, потом ' + bring);
  }
}

// ───────── Семья: договор по исходникам всех приложений ─────────
function checkFamily() {
  const items = [];
  const cs = apps.map(a => ({ id: a.id, dir: path.join(root, a.dir), product: (a.id === 'template' ? 'newapp' : a.id) + '.txt' }));
  if (fs.existsSync(kapsula)) cs.push({ id: 'kapsula', dir: kapsula, product: 'kapsula.txt' });
  for (const a of cs) {
    a.srcs = files(path.join(a.dir, 'src'), ['.cs']).filter(f => !SHARED.test(f)).map(f => source(a.id, f, false));
    checkCopies(a.id, a.dir);
    familyCs(a);
    for (const s of a.srcs) items.push(...csSettings(s));
  }
  if (fs.existsSync(aura)) {
    const own = fs.readdirSync(aura).filter(n => n.endsWith('.js') && n !== 'hub-client.js').map(n => path.join(aura, n))
      .concat(files(path.join(aura, 'app'), ['.js']).filter(f => !/dev-fixtures/.test(f)));
    const a = { id: 'aura', dir: aura, product: 'aura.txt', srcs: own.map(f => source('aura', f, true)) };
    const html = files(path.join(aura, 'app'), ['.html']).map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const client = path.join(aura, 'hub-client.js'), kitClient = path.join(kitOf(), 'hub', 'client.js');
    if (fs.existsSync(client) && fs.existsSync(kitClient) && !sameFile(client, kitClient))
      add('ошибка', 'aura', path.relative(root, client), 0, 'общие файлы: копия kit', 'hub-client.js не совпадает с kit.txt (hub/client.js): клиент хаба копируется как есть');
    familyJs(a);
    for (const s of a.srcs) items.push(...jsSettings(s, html));
  }
  checkSettings(items);
  return items;
}

// Всё, что проверяется по исходникам, без сборки и запуска: тексты, вид, движение, договор семьи.
// Находки — в findings (прежние стираются); те же проверки на учебных наборах гоняет tools/audit-test.js
function check(dir) {
  setRoot(dir);
  findings.length = 0;
  for (const a of apps) {
    const d = path.join(root, a.dir);
    for (const f of files(path.join(d, 'src'), ['.cs'])) checkCs(a.id, f, fs.readFileSync(f, 'utf8'), true);
    checkWindowsOf(a.id, d);
  }
  // Kapsula: свой интерфейс — проверяются тексты, папки, движение
  if (fs.existsSync(kapsula)) for (const f of files(path.join(kapsula, 'src'), ['.cs'])) checkCs('kapsula', f, fs.readFileSync(f, 'utf8'), false);
  if (fs.existsSync(aura)) checkWeb('aura', path.join(aura, 'app'));
  checkFamily();
  return findings;
}

// ───────── Сборка, самопроверки, снимки ─────────
function run(cmd, argv, cwd, timeout) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', timeout: timeout || 300000, windowsHide: true });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function main() {
  const args = process.argv.slice(2), flag = n => args.includes(n), outArg = args.indexOf('--out');
  check(args.find((a, i) => !a.startsWith('--') && (outArg < 0 || i !== outArg + 1)) || path.join(__dirname, '..', '..'));
  const out = path.resolve(outArg >= 0 ? args[outArg + 1] : path.join(root, 'audit-out'));
  fs.mkdirSync(out, { recursive: true });

  const shots = [];
  for (const a of flag('--no-build') ? [] : apps) {
    const dir = path.join(root, a.dir);
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

  // Kapsula: сборка и её 491 проверка — по --kapsula-tests, в копии во временной папке
  if (fs.existsSync(kapsula) && flag('--kapsula-tests') && !flag('--no-build')) {
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
  // Aura: синтаксис всех своих скриптов (main.js, preload.js, family.js и прочие рядом, скрипты окна);
  // запускать вторую Aura на компьютере нельзя — она пишет в настройки модуля микрофона
  if (fs.existsSync(aura)) {
    const scripts = [...new Set(['main.js', 'preload.js', 'app/app.js'].concat(fs.readdirSync(aura).filter(n => n.endsWith('.js')), files(path.join(aura, 'app'), ['.js']).map(f => path.relative(aura, f).replace(/\\/g, '/'))))]
      .filter(f => fs.existsSync(path.join(aura, f)));
    for (const f of scripts) {
      const r = run(process.execPath, ['--check', path.join(aura, f)], aura);
      if (r.code !== 0) add('ошибка', 'aura', 'repos/aura-voice/' + f, 0, 'синтаксис', r.out.slice(0, 200));
    }
    results.push('aura: синтаксис проверен, файлов: ' + scripts.length + ' (вторую Aura не запускаем)');
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
}

if (require.main === module) main();
// Для tools/audit-test.js: проверки по исходникам и разбор, на котором они стоят
module.exports = { check, mask, split, opener, str, props, flat, source, uses, assoc, csSettings, jsSettings, STARTUP_LABEL };
