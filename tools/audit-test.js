// kit.txt. tools/audit-test.js — проверки самого audit.js: разбор исходников и правила семьи на маленьких учебных
// наборах — нарочные нарушения и правильные образцы рядом. Каждый набор пишется во временную папку, по нему
// идёт check() из audit.js (без сборки и запуска), и находки семьи сравниваются с ожидаемыми один в один.
//
//   node tools/audit-test.js [папка для наборов] [--keep]
//
// Ничего не запускает, кроме самого audit.js по набору (один раз — как из командной строки).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const audit = require('./audit.js');

const argv = process.argv.slice(2);
const base = path.resolve(argv.find(a => !a.startsWith('--')) || os.tmpdir(), 'audit-test-' + process.pid);
let passed = 0, failed = 0;
const ok = (good, what, detail) => {
  if (good) { passed++; return; }
  failed++;
  console.error('FAIL  ' + what + (detail ? '\n' + detail : ''));
};

// Правила, которые проверяются здесь: договор семьи, копии kit.txt и «своя рамка окна»
const OURS = /^(семья: |общие файлы: |вид: своя рамка окна$)/;
const LF = t => t.replace(/^\n/, '');
// Номер строки, где впервые стоит needle (для ожидаемых находок: так их не надо пересчитывать при правке набора)
function lineOf(files, file, needle) {
  if (!needle) return 0;
  const lines = files[file].split('\n'), i = lines.findIndex(l => l.includes(needle));
  if (i < 0) throw new Error('в ' + file + ' нет «' + needle + '»');
  return i + 1;
}
// Набор: files — { 'smena/src/Program.cs': '…' }, want — [уровень, правило, файл, строка-примета] (примета null — без строки).
// Возвращает папку набора
let sets = 0;
function fixture(name, files, want) {
  const dir = path.join(base, 'set' + String(++sets).padStart(2, '0')), text = {};
  for (const [f, t] of Object.entries(files)) {
    text[f] = LF(t);
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text[f]);
  }
  const got = audit.check(dir).filter(x => OURS.test(x.rule))
    .map(x => [x.level, x.rule, x.file.split(path.sep).join('/'), x.line].join(' · ')).sort();
  const exp = want.map(w => [w[0], w[1], w[2], lineOf(text, w[2], w[3])].join(' · ')).sort();
  const same = got.length === exp.length && got.every((g, i) => g === exp[i]);
  ok(same, name, same ? '' : '      получено:\n        ' + (got.join('\n        ') || '—') + '\n      ожидалось:\n        ' + (exp.join('\n        ') || '—'));
  return dir;
}

const TRAY = 'семья: свой значок в трее', NOTE = 'семья: уведомление мимо острова', START = 'семья: запуск и обновления';
const GAME = 'семья: игры', KIN = 'семья: связь между приложениями', TWICE = 'семья: настройка в двух приложениях';
const ORDER = 'семья: порядок Family', ITEMS = 'семья: пункты трея', COPY = 'общие файлы: копия kit', FRAME = 'вид: своя рамка окна';

// ───────── Разбор: та же длина, комментарии и строки не мешают ─────────
{
  const cases = [
    ['cs', "// it's here\nvar t = new NotifyIcon();", false, 'new NotifyIcon('],
    ['cs verbatim', 'var p = @"say ""hi"" // не комментарий"; new NotifyIcon();', false, 'new NotifyIcon('],
    ['cs char', "char q = '\"'; var t = new NotifyIcon();", false, 'new NotifyIcon('],
    ['js regex', "const r = /[\"/]/g; new Tray('x');", true, 'new Tray('],
    ['js division', "const a = (b) / 2; const c = d / 3; new Tray('x');", true, 'new Tray('],
    ['js template', "const s = `a ${x ? 'b' : 'c'} d`; new Tray('x');", true, 'new Tray('],
    ['js comment', "// don't\nnew Tray('x');", true, 'new Tray('],
  ];
  for (const [name, src, js, visible] of cases) {
    const m = audit.mask(src, js);
    ok(m.code.length === src.length && m.bare.length === src.length && m.code.split('\n').length === src.split('\n').length, 'разбор «' + name + '»: длина и строки те же');
    ok(m.bare.includes(visible), 'разбор «' + name + '»: ' + visible + ' виден в коде', '      ' + JSON.stringify(m.bare));
    ok(!/[А-Яа-яЁё]|don't|it's/.test(m.bare),'разбор «' + name + '»: строки и комментарии забиты', '      ' + JSON.stringify(m.bare));
  }
  const m = audit.mask('Msg("key", "a", "label", F(1, 2), "value", true)', false);
  const a = audit.split(m, m.bare.indexOf('(')).args.map(x => x.text.trim());
  ok(a.length === 6 && a[3] === 'F(1, 2)', 'split: запятые во вложенном вызове не делят аргумент', '      ' + JSON.stringify(a));
}

// ───────── Подписи про запуск и обновления (правило 3) ─────────
{
  for (const t of ['Запускать вместе с Windows', 'Автообновление', 'Проверять обновления', 'Ставить обновления самой', 'Скачивать новые версии', 'Обновления', 'Автозапуск'])
    ok(audit.STARTUP_LABEL.test(t), 'про запуск и обновления: «' + t + '»');
  for (const t of ['Частота обновления погоды', 'Секунды при обновлении часов', 'Обновлять погоду каждые 30 минут', 'Обновление списка окон', 'Показывать музыку'])
    ok(!audit.STARTUP_LABEL.test(t), 'не про обновления приложения: «' + t + '»');
}

// ───────── 1. Свой значок в трее (C#) ─────────
// Обёртка HideOwnTray и SetTray в AppHub — ещё не значит, что значок их слушает (как smena.txt без проверки в Program.cs)
const wrapperOnly = fixture('трей: только обёртка', {
  'smena/src/AppHub.cs': `
namespace DevTxt.Smena
{
    static class AppHub
    {
        static Family family;
        // обёртка: сама ничего не прячет
        public static bool HideOwnTray { get { return family != null && family.HideOwnTray; } }
        public static void SetTray(System.Collections.Generic.IList<TrayItem> items) { if (family != null) family.SetTray(items); }
    }
}`,
  'smena/src/Program.cs': `
namespace DevTxt.Smena
{
    static class Program
    {
        static System.Windows.Forms.NotifyIcon icon;
        static void MakeIcon()
        {
            icon = new System.Windows.Forms.NotifyIcon { Text = "smena.txt", Visible = true };
        }
    }
}`,
}, [['ошибка', TRAY, 'smena/src/Program.cs', 'new System.Windows.Forms.NotifyIcon']]);

// HideOwnTray и SetTray читают только самопроверки: в SelfTest.cs и в static class SelfTest внутри Program.cs
fixture('трей: только в самопроверках', {
  'metla/src/MainWindow.cs': `
namespace DevTxt.Metla
{
    class MainWindow : System.Windows.Window
    {
        System.Windows.Forms.NotifyIcon tray;
        void MakeTray() { tray = new System.Windows.Forms.NotifyIcon { Text = "metla.txt", Visible = true }; }
    }
}`,
  'metla/src/SelfTest.cs': `
namespace DevTxt.Metla
{
    static class SelfTest
    {
        static void Run(HubLink l)
        {
            var fam = new Family(l, "metla");
            fam.SetTray(null);
            Check(!fam.HideOwnTray, "без связи свой значок не прячется");
        }
        static void Check(bool ok, string what) { }
    }
}`,
  'template/src/Program.cs': `
namespace DevTxt.NewApp
{
    static class Program
    {
        static System.Windows.Forms.NotifyIcon icon = new System.Windows.Forms.NotifyIcon();
    }
    static class SelfTest
    {
        static void Run(Family fam) { bool hide = fam.HideOwnTray; fam.SetTray(null); fam.Changed = null; }
    }
}`,
}, [['ошибка', TRAY, 'metla/src/MainWindow.cs', 'new System.Windows.Forms.NotifyIcon'], ['ошибка', TRAY, 'template/src/Program.cs', 'new System.Windows.Forms.NotifyIcon']]);

// Как надо: значок слушает HideOwnTray, пункты уходят в SetTray, Changed назначен, Family создан вовремя.
// Рядом: без SetTray — внимание (dock), без Changed — сведения (metla), core.txt держит общий трей, audit:ok у kapsula.txt
fixture('трей: как надо и почти', {
  'smena/src/AppHub.cs': `
using System.Collections.Generic;
namespace DevTxt.Smena
{
    static class AppHub
    {
        static HubLink link;
        static Family family;
        public static bool HideOwnTray { get { return family != null && family.HideOwnTray; } }
        public static void Start()
        {
            link = new HubLink("smena", "smena.txt", "1.0", 0);
            link.Topics = new string[] { "hub.theme" };
            link.OnState = delegate(string topic, object data, string from) { };
            family = new Family(link, "smena");
            family.Changed = delegate { };
            family.SetTray(Tray());
            link.Start();
        }
        public static List<TrayItem> Tray()
        {
            return new List<TrayItem> { new TrayItem("show", "Открыть", null, delegate { }), new TrayItem("pause", "Приостановить", false, delegate { }) };
        }
    }
}`,
  'smena/src/Program.cs': `
namespace DevTxt.Smena
{
    static class Program
    {
        static System.Windows.Forms.NotifyIcon icon = new System.Windows.Forms.NotifyIcon();
        static void Sync() { icon.Visible = !AppHub.HideOwnTray; }
    }
}`,
  'dock/src/DockHub.cs': `
namespace DevTxt.Dock
{
    static class DockHub
    {
        static Family family;
        static System.Windows.Forms.NotifyIcon icon = new System.Windows.Forms.NotifyIcon();
        static void Sync() { icon.Visible = !family.HideOwnTray; }
    }
}`,
  'metla/src/AppHub.cs': `
namespace DevTxt.Metla
{
    static class AppHub
    {
        static Family fam;
        static System.Windows.Forms.NotifyIcon icon = new System.Windows.Forms.NotifyIcon();
        static void Wire(HubLink l) { fam = new Family(l, "metla"); fam.SetTray(null); }
        static void Sync() { icon.Visible = !fam.HideOwnTray; }
    }
}`,
  'core/src/MainWindow.cs': `
namespace DevTxt.Core
{
    class MainWindow
    {
        System.Windows.Forms.NotifyIcon tray = new System.Windows.Forms.NotifyIcon();
    }
}`,
  'repos/kapsula/src/IslandWindow.cs': `
namespace Kapsula
{
    partial class IslandWindow
    {
        void BuildTray() { tray = new WF.NotifyIcon(); }   // audit:ok — учебный набор
    }
}`,
}, [['внимание', TRAY, 'dock/src/DockHub.cs', 'new System.Windows.Forms.NotifyIcon'], ['сведения', TRAY, 'metla/src/AppHub.cs', 'new System.Windows.Forms.NotifyIcon']]);

// ───────── 1. Свой значок в трее (aura.txt): помощник семьи не в счёт ─────────
const HELPER = `
'use strict';
// помощник семьи: core.family, setTray и tray.run в нём есть всегда
const TOPIC = 'core.family';
const TRAY_RUN = 'tray.run';
class Family {
  constructor(app) { this.app = app; this.core = null; }
  wrap(options) { return options; }
  get hideOwnTray() { return !!(this.core && this.core.tray); }
  setTray(items) { this.tray = items; }
  notify(title, text) { return false; }
}
function auraTray(a) {
  return [
    { key: 'show', label: 'Открыть', run: a.show },
    { key: 'power', label: 'Обработка голоса', run: a.power },
  ];
}
module.exports = { Family, auraTray, TOPIC, TRAY_RUN };
`;
fixture('aura: значок всегда', {
  'repos/aura-voice/family.js': HELPER,
  'repos/aura-voice/main.js': `
'use strict';
const { app, Tray } = require('electron');
const { Family } = require('./family');
let tray = null;
function createTray() { tray = new Tray('tray.png'); }
app.on('before-quit', () => { if (tray) tray.destroy(); });
`,
}, [['ошибка', TRAY, 'repos/aura-voice/main.js', 'new Tray(']]);

fixture('aura: как надо', {
  'repos/aura-voice/family.js': HELPER,
  'repos/aura-voice/main.js': `
'use strict';
const { Tray } = require('electron');
const { Family, auraTray } = require('./family');
let tray = null, hub = null;
const family = new Family('aura', () => (family.hideOwnTray ? dropTray() : createTray()));
function createTray() { if (!tray) tray = new Tray('tray.png'); }
function dropTray() { if (tray) tray.destroy(); tray = null; }
function startHub(connect) { hub = connect(family.wrap({ app: 'aura' })); family.setTray(auraTray({})); }
function tell(title, text) { if (!family.notify(title, text)) tray.displayBalloon({ title, content: text }); }
`,
  'repos/aura-voice/app/app.js': `
'use strict';
const hubSwitch = (id, section) => {
  const item = { key: id, type: 'switch', label: id, value: true };
  if (section) item.section = section;
  return item;
};
function hubSettingsNow() {
  return { groups: [{ title: 'Запуск и обновления', items: [hubSwitch('autostart', 'startup'), hubSwitch('autoUpdate', 'startup')] }] };
}
`,
  'repos/aura-voice/app/index.html': `
<label><b>Запускать вместе с Windows</b><input id="autostart" type="checkbox"></label>
<label><b>Проверять обновления</b><input id="autoUpdate" type="checkbox"></label>
`,
}, []);

// Значок не убирается, своё уведомление мимо острова, section у группы не в счёт, пять пунктов трея и «Выход»
fixture('aura: почти', {
  'repos/aura-voice/family.js': HELPER,
  'repos/aura-voice/main.js': `
'use strict';
const { Tray, Notification } = require('electron');
const { Family } = require('./family');
let tray = null, hub = null;
const family = new Family('aura', () => {});
function createTray() { if (!family.hideOwnTray) tray = new Tray('tray.png'); }
function startHub(connect) { hub = connect(family.wrap({ app: 'aura' })); family.setTray(menu()); }
function menu() {
  return [
    { key: 'power', label: 'Обработка голоса' },
    { key: 'show', label: 'Открыть' },
    { key: 'quit', label: 'Выход' },
    { key: 'a', label: 'Первое' },
    { key: 'b', label: 'Второе' },
  ];
}
function tell(text) { new Notification({ title: 'aura.txt', body: text }).show(); }
`,
  'repos/aura-voice/app/app.js': `
'use strict';
function hubSettingsNow() {
  return { groups: [{ title: 'Запуск', section: 'startup', items: [{ key: 'autostart', type: 'switch', label: 'Запускать вместе с Windows', value: true }] }] };
}
`,
}, [['внимание', TRAY, 'repos/aura-voice/main.js', 'new Tray('], ['внимание', NOTE, 'repos/aura-voice/main.js', 'new Notification('],
  ['ошибка', ITEMS, 'repos/aura-voice/main.js', "label: 'Выход'"], ['внимание', ITEMS, 'repos/aura-voice/main.js', 'return ['], ['внимание', ITEMS, 'repos/aura-voice/main.js', 'return ['],
  ['ошибка', START, 'repos/aura-voice/app/app.js', "key: 'autostart'"]]);

// aura.tray отдаётся, а tray.run никто не принимает (ни своей командой, ни через family.wrap)
fixture('aura: без tray.run', {
  'repos/aura-voice/main.js': `
'use strict';
let hub = null;
function publish() { hub.state('aura.tray', { items: [{ key: 'show', label: 'Открыть' }] }); }
`,
}, [['ошибка', ITEMS, 'repos/aura-voice', null]]);

// ───────── 2. Уведомления ─────────
fixture('уведомления', {
  'metla/src/MainWindow.cs': `
namespace DevTxt.Metla
{
    class MainWindow
    {
        System.Windows.Forms.NotifyIcon tray;
        void Tell(string text) { tray.ShowBalloonTip(5000, "metla.txt", text, System.Windows.Forms.ToolTipIcon.None); }
    }
}`,
  'metla/src/Pages.cs': `
namespace DevTxt.Metla
{
    class Pages
    {
        System.Windows.Forms.NotifyIcon tray;
        void Tell(string text) { if (!AppHub.Notify("metla.txt", text, true)) tray.ShowBalloonTip(5000, "metla.txt", text, System.Windows.Forms.ToolTipIcon.None); }
    }
}`,
  'repos/kapsula/src/Toasts.cs': `
namespace Kapsula
{
    class Toasts
    {
        System.Windows.Forms.NotifyIcon tray;
        void Tell(string text) { tray.ShowBalloonTip(5000, "kapsula.txt", text, System.Windows.Forms.ToolTipIcon.None); }
    }
}`,
}, [['внимание', NOTE, 'metla/src/MainWindow.cs', 'ShowBalloonTip']]);

// ───────── 3. Пункты настроек на общих страницах core.txt ─────────
fixture('настройки: section у пункта', {
  'smena/src/AppHub.cs': `
namespace DevTxt.Smena
{
    static class Sections { public const string Startup = "startup"; }
    static class AppHub
    {
        public static object Settings()
        {
            var a = HubLink.Msg("key", "autostart", "type", "switch", "label", "Запускать вместе с Windows", "value", true);
            var b = HubLink.Msg("key", "autoUpdate", "type", "switch", "label", "Ставить обновления сами", "value", true, "section", "startup");
            var c = HubLink.Msg("key", "updates", "type", "switch", "label", "Проверять обновления", "value", true, "section", Sections.Startup);
            var d = HubLink.Msg("key", "runAtLogin", "type", "switch", "label", "При входе в Windows", "value", true);
            d["section"] = "startup";
            var e = HubLink.Msg("key", "weatherEvery", "type", "choice", "label", "Частота обновления погоды", "value", "30");
            var f = HubLink.Msg("key", "hideInGames", "type", "switch", "label", "Прятать в играх", "value", true);
            var g = HubLink.Msg("key", "share", "type", "switch", "label", "Показывать музыку другим приложениям", "value", true);
            var h = HubLink.Msg("key", "checkNow", "type", "switch", "label", "Скачивать обновления сами", "value", true, "section", "games");
            var k = HubLink.Msg("key", "clockSeconds", "type", "switch", "label", "Секунды при обновлении часов", "value", false);
            return HubLink.Msg("groups", new object[] { HubLink.Msg("title", "Общее", "items", new object[] { a, b, c, d, e, f, g, h, k }) });
        }
    }
}`,
}, [['ошибка', START, 'smena/src/AppHub.cs', '"autostart"'], ['внимание', GAME, 'smena/src/AppHub.cs', '"hideInGames"'],
  ['сведения', KIN, 'smena/src/AppHub.cs', '"share"'], ['ошибка', START, 'smena/src/AppHub.cs', '"checkNow"']]);

// section, заданный в другом месте: switch по ключу (case на разных строках, как обычно пишут в C#),
// тот же switch в одну строку, сравнение ?:, if (…) item["section"] = …
const SWITCH_LINES = `
                case "showInGames":
                case "gameLoad":
                    return "games";
                case "autostart":
                case "autoUpdate":
                    return "startup";
                case "hubShare":
                    return "family";`;
const SWITCH_ONE = `
                case "showInGames": case "gameLoad": return "games";
                case "autostart": case "autoUpdate": return "startup";
                case "hubShare": return "family";`;
const kapsula = cases => `
using System.Collections.Generic;
namespace Kapsula
{
    static class CoreHub
    {
        class Flag { public string Group, Key, Label, Section; }
        static List<Flag> flags = new List<Flag>();
        static void Add(string group, string key, string label, string hint) { flags.Add(new Flag { Group = group, Key = key, Label = label, Section = SectionOf(key) }); }
        public static string SectionOf(string key)
        {
            switch (key)
            {${cases}
            }
            return null;
        }
        static void Describe()
        {
            Add("Игры", "showInGames", "Показывать остров в играх", null);
            Add("Игры", "gameLoad", "Нагрузка во время игры", null);
            Add("Запуск и обновления", "autostart", "Запускать вместе с Windows", null);
            Add("Запуск и обновления", "autoUpdate", "Автообновление", null);
            Add("Связь с другими приложениями", "hubShare", "Показывать погоду другим приложениям dev.txt", null);
            Add("", "seconds", "Секунды в часах", null);
        }
        static List<object> Settings()
        {
            var list = new List<object>();
            foreach (var f in flags)
            {
                var item = HubLink.Msg("key", f.Key, "type", "switch", "label", f.Label, "value", true);
                if (f.Section != null) item["section"] = f.Section;
                list.Add(item);
            }
            return list;
        }
    }
}`;
fixture('настройки: switch на разных строках', { 'repos/kapsula/src/CoreHub.cs': kapsula(SWITCH_LINES) }, []);
fixture('настройки: switch в одну строку', { 'repos/kapsula/src/CoreHub.cs': kapsula(SWITCH_ONE) }, []);
// без своей ветки в switch пункт остаётся без section
fixture('настройки: ключа нет в switch', { 'repos/kapsula/src/CoreHub.cs': kapsula(SWITCH_LINES.replace('case "autoUpdate":', '')) },
  [['ошибка', START, 'repos/kapsula/src/CoreHub.cs', '"autoUpdate"']]);

fixture('настройки: ?: и if', {
  'dock/src/Model.cs': `
namespace DevTxt.Dock
{
    class Store
    {
        public object Describe(string key)
        {
            var games = HubLink.Msg("key", "showInGames", "type", "switch", "label", "Показывать док в играх", "value", true);
            games["section"] = key == "fsTrack" ? "startup" : key == "showInGames" ? "games" : null;
            var auto = HubLink.Msg("key", "autostart", "type", "switch", "label", "Запускать вместе с Windows", "value", true);
            if (key == "autoUpdate" || key == "autostart") { auto["section"] = "startup"; }
            var quiet = HubLink.Msg("key", "quietInGames", "type", "switch", "label", "Молчать в играх", "value", true);
            if (Has("quietInGames")) quiet["section"] = "games";
            var load = HubLink.Msg("key", "gameLoad", "type", "switch", "label", "Нагрузка во время игры", "value", true);
            load["section"] = Has("gameLoad") ? "games" : null;
            return HubLink.Msg("groups", new object[] { HubLink.Msg("title", "Док", "items", new object[] { games, auto, quiet, load }) });
        }
        static bool Has(string key) { return key != ""; }
    }
}`,
}, []);

// ───────── 4. Одна подпись в двух приложениях ─────────
fixture('одна настройка в двух приложениях', {
  'dock/src/Model.cs': `
class Store { object D() { return HubLink.Msg("key", "autoHide", "type", "switch", "label", "Автоскрытие", "value", true); } }`,
  'repos/kapsula/src/CoreHub.cs': `
class CoreHub { object D() { return HubLink.Msg("key", "autoHide", "type", "switch", "label", "Автоскрытие", "value", true); } }`,
  'template/src/AppHub.cs': `
class AppHub { object D() { return HubLink.Msg("key", "autoHide", "type", "switch", "label", "Автоскрытие", "value", true); } }`,
}, [['внимание', TWICE, 'dock/src/Model.cs', 'Автоскрытие'], ['внимание', TWICE, 'repos/kapsula/src/CoreHub.cs', 'Автоскрытие']]);

// ───────── 5. Копии общих файлов ─────────
const copies = fixture('копии kit.txt', {
  'kit/hub/Family.cs': 'class Family { }\n',
  'kit/hub/HubLink.cs': 'class HubLink { }\n',
  'kit/hub/CoreApp.cs': 'class CoreApp { }\n',
  'kit/hub/client.js': "'use strict';\n",
  'smena/src/HubLink.cs': 'class HubLink { }\r\n',                // концы строк не в счёт
  'smena/tools/sync.ps1': '# sync\n',
  'dock/src/HubLink.cs': 'class HubLink { }\n',
  'dock/src/Family.cs': 'class Family { int edited; }\n',
  'metla/src/HubLink.cs': String.fromCharCode(0xFEFF) + 'class HubLink { }\n',   // и метка BOM
  'metla/src/Family.cs': 'class Family { }\n',
  'metla/src/CoreApp.cs': 'class CoreApp { }\n',
  'repos/aura-voice/hub-client.js': "'use strict'; // правка\n",
}, [['ошибка', COPY, 'smena/src', null], ['ошибка', COPY, 'dock/src/Family.cs', null], ['ошибка', COPY, 'repos/aura-voice/hub-client.js', null]]);
{
  const f = audit.check(copies).filter(x => x.rule === COPY);
  const smena = f.find(x => x.app === 'smena'), dock = f.find(x => x.app === 'dock');
  ok(smena && /tools\/sync\.ps1/.test(smena.text), 'копии: у кого есть tools/sync.ps1 — подсказка про него');
  ok(dock && !/sync\.ps1/.test(dock.text) && /копируется из kit\.txt как есть/.test(dock.text), 'копии: у кого sync.ps1 нет — «копируется как есть»');
}

// ───────── 6. Своя рамка окна: всплывающие окна не в счёт ─────────
fixture('своя рамка окна', {
  'dock/src/Preview.cs': `
class PreviewWindow : Window
{
    public PreviewWindow()
    {
        WindowStyle = WindowStyle.None;
        ShowInTaskbar = false;
    }
}`,
  'dock/src/Tip.cs': `
class Tip : Window
{
    static Window Make() { return new Window { WindowStyle = WindowStyle.None, ShowInTaskbar = false }; }
}`,
  // главное окно, которое прячется в трей: ShowInTaskbar = false только в обработчике — это не всплывающее окно
  'smena/src/Main.cs': `
class MainWindow : Window
{
    public MainWindow()
    {
        WindowStyle = WindowStyle.None;
        StateChanged += delegate { if (WindowState == WindowState.Minimized) { ShowInTaskbar = false; } };
    }
}`,
  'metla/src/Card.cs': `
class CardWindow : Window
{
    public CardWindow()
    {
        WindowStyle = WindowStyle.None;
        // ShowInTaskbar = false;
    }
}`,
}, [['внимание', FRAME, 'smena/src/Main.cs', 'WindowStyle = WindowStyle.None'], ['внимание', FRAME, 'metla/src/Card.cs', 'WindowStyle = WindowStyle.None']]);

// ───────── 7. Порядок Family ─────────
fixture('порядок Family', {
  // Wire() у metla.txt: связь и Family создаются здесь, Start() — в другом методе и у другой переменной
  'metla/src/AppHub.cs': `
namespace DevTxt.Metla
{
    static class AppHub
    {
        static HubLink link;
        static Family family;
        internal static HubLink Wire(int port, out Family fam)
        {
            var l = new HubLink("metla", "metla.txt", "1.0", port);
            l.Topics = new string[] { "hub.theme" };
            fam = new Family(l, "metla");
            l.OnState = delegate(string topic, object data, string from) { };
            l.Commands = new string[] { "settings.set" };
            return l;
        }
        public static void Start()
        {
            link = Wire(0, out family);
            link.Start();
        }
    }
}`,
  'dock/src/DockHub.cs': `
namespace DevTxt.Dock
{
    static class DockHub
    {
        static HubLink link;
        static Family family;
        public static void Start()
        {
            link = new HubLink("dock", "dock.txt", "1.0", 0);
            link.Start();
            family = new Family(link, "dock");
        }
    }
}`,
}, [['ошибка', ORDER, 'metla/src/AppHub.cs', 'l.OnState ='], ['ошибка', ORDER, 'metla/src/AppHub.cs', 'l.Commands ='], ['ошибка', ORDER, 'dock/src/DockHub.cs', 'new Family(']]);

// ───────── 8. Пункты общего трея (C#) ─────────
fixture('пункты трея', {
  'smena/src/AppHub.cs': `
using System.Collections.Generic;
namespace DevTxt.Smena
{
    static class AppHub
    {
        public static List<TrayItem> Tray()
        {
            return new List<TrayItem> {
                new TrayItem("pause", "Приостановить", false, null),
                new TrayItem("show", "Открыть smena.txt", null, null),
                new TrayItem("quit", "Выход", null, null),
                new TrayItem("a", "Первое", null, null),
                new TrayItem("b", "Второе", null, null),
            };
        }
    }
}`,
  // show с другой подписью (как «Настройки» у kapsula.txt) — сведения; с пометкой audit:ok — тишина
  'metla/src/AppHub.cs': `
using System.Collections.Generic;
namespace DevTxt.Metla
{
    static class AppHub
    {
        public static List<TrayItem> Tray() { return new List<TrayItem> { new TrayItem("show", "Настройки", null, null), new TrayItem("clean", "Очистить", null, null) }; }
        public static List<TrayItem> Quiet() { return new List<TrayItem> { new TrayItem("show", "Показать", null, null) }; }   // audit:ok — учебный набор
    }
}`,
}, [['внимание', ITEMS, 'smena/src/AppHub.cs', 'Открыть smena.txt'], ['ошибка', ITEMS, 'smena/src/AppHub.cs', '"Выход"'],
  ['внимание', ITEMS, 'smena/src/AppHub.cs', 'new List<TrayItem> {'], ['внимание', ITEMS, 'smena/src/AppHub.cs', 'new List<TrayItem> {'],
  ['сведения', ITEMS, 'metla/src/AppHub.cs', '"Настройки"']]);

// ───────── Командная строка: отчёт и код выхода ─────────
{
  const out = path.join(base, 'report');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'audit.js'), '--out', out, wrapperOnly, '--no-build'], { encoding: 'utf8', windowsHide: true });
  const md = fs.existsSync(path.join(out, 'REPORT.md')) ? fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8') : '';
  ok(r.status === 1 && /Ошибок: 1 /.test(md) && md.includes(TRAY), 'audit.js из командной строки: ошибка — код выхода 1 и строка в REPORT.md', '      ' + (r.stdout + r.stderr).trim());
}

if (!argv.includes('--keep')) fs.rmSync(base, { recursive: true, force: true });
console.log('audit.js: проверок ' + (passed + failed) + ', не прошло ' + failed + (argv.includes('--keep') ? ' (наборы: ' + base + ')' : ''));
process.exitCode = failed ? 1 : 0;
