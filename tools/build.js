// Builds dist/tokens.css and dist/Tokens.cs from tokens/tokens.json. No dependencies.
//   node tools/build.js          write the files
//   node tools/build.js --check  fail if the files on disk differ from what would be written
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const t = JSON.parse(fs.readFileSync(path.join(root, 'tokens', 'tokens.json'), 'utf8'));

// "#RRGGBB" or "#RRGGBB/0.5"
function color(s) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:\/([0-9.]+))?$/i.exec(s);
  if (!m) throw new Error('Bad colour: ' + s);
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: m[4] === undefined ? 1 : Number(m[4]) };
}
const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');
const kebab = s => s.replace(/[A-Z0-9]+/g, m => '-' + m.toLowerCase());
const pascal = s => s[0].toUpperCase() + s.slice(1);
const num = n => String(Number(n.toFixed(4)));

// ───────── CSS ─────────
function cssColor(s) {
  const c = color(s);
  return c.a === 1 ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` : `rgb(${c.r} ${c.g} ${c.b} / ${num(c.a)})`;
}
const cssFont = list => list.map(f => `'${f}'`).concat('system-ui', 'sans-serif').join(', ');
const white = a => `rgb(255 255 255 / ${num(a)})`;

function cssTheme(name) {
  const out = [];
  for (const [k, v] of Object.entries(t.theme[name])) out.push(`--dt-${kebab(k)}: ${cssColor(v)};`);
  const g = t.glass[name];
  for (const level of ['fill', 'hover', 'strong'])
    out.push(`--dt-glass${level === 'fill' ? '' : '-' + level}: linear-gradient(180deg, ${white(g[level][0])}, ${white(g[level][1])});`);
  out.push(`--dt-rim: linear-gradient(145deg, ${g.rim.map(([c, at]) => `${cssColor(c)} ${num(at * 100)}%`).join(', ')});`);
  return out;
}

function buildCss() {
  const base = [];
  for (const [k, v] of Object.entries(t.palette)) base.push(`--dt-${kebab(k)}: ${cssColor(v)};`);
  base.push(`--dt-accent: var(--dt-${kebab(t.accent)});`);
  for (const [k, v] of Object.entries(t.radius)) base.push(`--dt-radius-${kebab(k)}: ${v}px;`);
  for (const [k, v] of Object.entries(t.font.family)) base.push(`--dt-font-${kebab(k)}: ${k === 'mono' ? v.map(f => `'${f}'`).concat('monospace').join(', ') : cssFont(v)};`);
  for (const [k, v] of Object.entries(t.font.size)) base.push(`--dt-size-${kebab(k)}: ${v}px;`);
  base.push(`--dt-ease-out: cubic-bezier(${t.motion.easeOut.join(', ')});`);
  for (const [k, v] of Object.entries(t.motion.duration)) base.push(`--dt-dur-${kebab(k)}: ${v}ms;`);

  const block = (sel, lines) => `${sel} {\n${lines.map(l => '  ' + l).join('\n')}\n}\n`;
  return [
    `/* Generated from tokens/tokens.json (v${t.version}) by tools/build.js. Do not edit by hand. */\n`,
    block(':root', ['color-scheme: dark;', ...base, ...cssTheme('dark')]),
    block(":root[data-theme='light']", ['color-scheme: light;', ...cssTheme('light')]),
    block('@media (prefers-reduced-motion: reduce)', [':root {', ...Object.keys(t.motion.duration).map(k => `  --dt-dur-${kebab(k)}: 0ms;`), '}']),
  ].join('\n');
}

// ───────── C# (C# 5: the compiler built into Windows) ─────────
function csColor(s) {
  const c = color(s);
  const rgb = `0x${hex2(c.r)}, 0x${hex2(c.g)}, 0x${hex2(c.b)}`;
  return c.a === 1 ? `Color.FromRgb(${rgb})` : `Color.FromArgb(0x${hex2(Math.round(c.a * 255))}, ${rgb})`;
}

function buildCs() {
  const L = [];
  const cls = (name, body) => { L.push(`        public static class ${name}`, '        {'); body(); L.push('        }', ''); };
  const col = (k, v) => L.push(`            public static readonly Color ${pascal(k)} = ${csColor(v)};`);
  const dbl = (k, v) => L.push(`            public const double ${pascal(k)} = ${num(v)};`);

  L.push(`// Generated from tokens/tokens.json (v${t.version}) by tools/build.js. Do not edit by hand.`);
  L.push('using System.Windows.Media;', '', 'namespace DevTxt', '{', '    static class Tokens', '    {');
  L.push(`        public const string Version = "${t.version}";`, '');

  cls('Palette', () => {
    for (const [k, v] of Object.entries(t.palette)) col(k, v);
    L.push(`            public static readonly Color Accent = ${pascal(t.accent)};`);
  });
  for (const name of ['dark', 'light']) {
    cls(pascal(name), () => { for (const [k, v] of Object.entries(t.theme[name])) col(k, v); });
    // Glass: white at the given opacity, top and bottom of a vertical gradient; the rim is a diagonal gradient
    cls('Glass' + pascal(name), () => {
      const g = t.glass[name];
      for (const level of ['fill', 'hover', 'strong']) {
        dbl(level + 'Top', g[level][0]);
        dbl(level + 'Bottom', g[level][1]);
      }
      L.push(`            public static readonly Color[] RimColors = { ${g.rim.map(([c]) => csColor(c)).join(', ')} };`);
      L.push(`            public static readonly double[] RimOffsets = { ${g.rim.map(([, at]) => num(at)).join(', ')} };`);
    });
  }
  cls('Radius', () => { for (const [k, v] of Object.entries(t.radius)) dbl(k, v); });
  cls('Font', () => {
    for (const [k, v] of Object.entries(t.font.family)) L.push(`            public const string ${pascal(k)} = "${v.join(', ')}";`);
  });
  cls('Size', () => { for (const [k, v] of Object.entries(t.font.size)) dbl(k, v); });
  cls('Motion', () => {
    L.push(`            public static readonly double[] EaseOut = { ${t.motion.easeOut.map(num).join(', ')} };`);
    for (const [k, v] of Object.entries(t.motion.duration)) L.push(`            public const int ${pascal(k)}Ms = ${v};`);
    for (const [k, v] of Object.entries(t.motion.spring)) {
      dbl('spring' + pascal(k) + 'Stiffness', v[0]);
      dbl('spring' + pascal(k) + 'Damping', v[1]);
    }
  });
  while (L[L.length - 1] === '') L.pop();
  L.push('    }', '}', '');
  return L.join('\r\n');
}

const files = { 'dist/tokens.css': buildCss(), 'dist/Tokens.cs': buildCs() };
const check = process.argv.includes('--check');
let stale = false;
for (const [rel, text] of Object.entries(files)) {
  const file = path.join(root, rel);
  if (check) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (now !== text) { console.error('Stale: ' + rel + ' (run: node tools/build.js)'); stale = true; }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log('Wrote ' + rel);
  }
}
if (stale) process.exit(1);
