#!/usr/bin/env node
'use strict';
// 웹 튜닝 시트(docs/merge-feedback-anim.html)의 PARAMS 기본값을 클라 MergeFxConfig.ts(정본)에 맞춘다.
// Usage: node scripts/mfx-sync.js [--check] [--html <path>] [--client <MergeFxConfig.ts>]
// Exit: 0 ok, 1 --check 차이 있음, 2 장면/키 불일치·파싱 실패.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const RE_START = /^export const MERGE_FX = \{$/;
const RE_END = /^\} as const;$/;
const RE_SCENE = /^    (\w+): \{$/;
const RE_CLOSE = /^    \},$/;
const RE_PROP = /^        (\w+): ("[^"]*"|-?[0-9.]+),( +\/\/.*)?$/;

function fmtNum(n) {
  return String(Number.isInteger(n) ? n : Math.round(n * 1000) / 1000);
}

function parseClient(text) {
  const values = {};
  let state = 'pre';
  let inComment = false;
  let scene = null;
  text.split('\n').forEach((l0, idx) => {
    const l = l0.replace(/\r$/, '');
    const no = idx + 1;
    if (state === 'pre') { if (RE_START.test(l)) state = 'top'; return; }
    if (state === 'done') return;
    if (state === 'top') {
      if (inComment) { if (/\*\/\s*$/.test(l)) inComment = false; return; }
      if (l.trim() === '') return;
      if (/^    \/\*\*/.test(l)) { if (!/\*\/\s*$/.test(l)) inComment = true; return; }
      if (RE_END.test(l)) { state = 'done'; return; }
      const m = RE_SCENE.exec(l);
      if (!m) throw new Error('client line ' + no + ': not a scene header: ' + l);
      if (values[m[1]]) throw new Error('client line ' + no + ': duplicate scene ' + m[1]);
      values[m[1]] = {};
      scene = m[1];
      state = 'scene';
      return;
    }
    if (l.trim() === '') return;
    if (RE_CLOSE.test(l)) { state = 'top'; scene = null; return; }
    const m = RE_PROP.exec(l);
    if (!m) throw new Error('client line ' + no + ': not a property line: ' + l);
    if (m[1] in values[scene]) throw new Error('client line ' + no + ': duplicate key ' + scene + '.' + m[1]);
    values[scene][m[1]] = m[2][0] === '"' ? m[2].slice(1, -1) : Number(m[2]);
  });
  if (state !== 'done') throw new Error('MERGE_FX block not found or not closed');
  return values;
}

// PARAMS 리터럴 범위(줄 인덱스)와 평가 결과.
function locateParams(lines) {
  const s = lines.findIndex(l => /^\s*var PARAMS = \{\s*$/.test(l));
  if (s < 0) throw new Error('var PARAMS = { not found');
  let e = -1;
  for (let i = s + 1; i < lines.length; i++) if (/^\s*\};\s*$/.test(lines[i])) { e = i; break; }
  if (e < 0) throw new Error('PARAMS end not found');
  const literal = '{' + lines.slice(s + 1, e).join('\n') + '\n}';
  const params = vm.runInNewContext('(' + literal + ')', {}, { timeout: 2000 });
  return { s, e, params };
}

function webKeys(rows) {
  const ks = [];
  rows.forEach(r => {
    ks.push(r.k);
    if (r.easeK) ks.push(r.easeK);
  });
  return ks;
}

// 웹 쪽 (scene,key,field,webValue) 목록. 필드: v / sv / ease.
function entries(params) {
  const out = [];
  Object.keys(params).forEach(scene => {
    params[scene].forEach(r => {
      if (r.sv !== undefined) out.push({ scene, key: r.k, field: 'sv', web: r.sv, row: r });
      else if (r.v !== undefined) out.push({ scene, key: r.k, field: 'v', web: r.v, row: r });
      if (r.easeK) out.push({ scene, key: r.easeK, field: 'ease', web: r.ease, rowK: r.k, row: r });
    });
  });
  return out;
}

function same(field, a, b) {
  if (field === 'v') return typeof b === 'number' && fmtNum(a) === fmtNum(b);
  return a === b;
}

function fmtVal(field, v) {
  return field === 'v' ? fmtNum(v) : JSON.stringify(v);
}

function compare(params, client) {
  const diffs = [];
  entries(params).forEach(en => {
    const c = client[en.scene][en.key];
    if (!same(en.field, en.web, c)) diffs.push({ scene: en.scene, key: en.key, field: en.field, rowK: en.rowK || en.key, web: en.web, client: c });
  });
  return diffs;
}

function checkKeys(params, client) {
  const errs = [];
  Object.keys(params).forEach(s => { if (!client[s]) errs.push('scene only in web: ' + s); });
  Object.keys(client).forEach(s => { if (!params[s]) errs.push('scene only in client: ' + s); });
  Object.keys(params).forEach(s => {
    if (!client[s]) return;
    const w = webKeys(params[s]);
    w.forEach(k => { if (!(k in client[s])) errs.push('key only in web: ' + s + '.' + k); });
    Object.keys(client[s]).forEach(k => { if (w.indexOf(k) < 0) errs.push('key only in client: ' + s + '.' + k); });
  });
  return errs;
}

function warnRanges(params, client) {
  const ws = [];
  Object.keys(params).forEach(s => {
    params[s].forEach(r => {
      if (r.v === undefined || r.min === undefined || r.max === undefined) return;
      const c = client[s][r.k];
      if (typeof c === 'number' && (c < r.min || c > r.max)) ws.push('WARN ' + s + '.' + r.k + ' client=' + fmtNum(c) + ' outside [' + r.min + ', ' + r.max + ']');
    });
  });
  return ws;
}

// PARAMS 블록 안에서 행 단위 토큰 치환. 블록 밖은 건드리지 않는다.
function rewrite(lines, loc, client) {
  const out = lines.slice();
  let scene = null;
  let changed = 0;
  for (let i = loc.s + 1; i < loc.e; i++) {
    const line = out[i];
    const sm = /^\s*(\w+):\s*\[\s*$/.exec(line);
    if (sm) { scene = sm[1]; continue; }
    if (/^\s*\],?\s*$/.test(line)) { scene = null; continue; }
    const km = /^\s*\{\s*k:"(\w+)"/.exec(line);
    if (!km || !scene || !client[scene]) continue;
    let next = line;
    const k = km[1];
    const ek = /(?<!\w)easeK:"(\w+)"/.exec(line);
    const swap = (re, fn) => { next = next.replace(re, fn); };
    if (/(?<!\w)sv:"/.test(line) && k in client[scene]) {
      swap(/(?<!\w)(sv:")[^"]*(")/, (_, a, b) => a + client[scene][k] + b);
    } else if (/(?<!\w)v:\s*-?[0-9.]/.test(line) && typeof client[scene][k] === 'number') {
      swap(/(?<!\w)(v:\s*)(-?[0-9.]+)/, (all, a, num) => (fmtNum(Number(num)) === fmtNum(client[scene][k]) ? all : a + fmtNum(client[scene][k])));
    }
    if (ek && ek[1] in client[scene]) {
      swap(/(?<!\w)(ease:")[^"]*(")/, (_, a, b) => a + client[scene][ek[1]] + b);
    }
    if (next !== line) { out[i] = next; changed++; }
  }
  return { out, changed };
}

function main() {
  const argv = process.argv.slice(2);
  let check = false;
  let html = path.join(__dirname, '..', 'docs', 'merge-feedback-anim.html');
  let clientPath = path.join(os.homedir(), 'Projects/story-merge-proto-client/assets/script/game/data/MergeFxConfig.ts');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--html') html = path.resolve(argv[++i]);
    else if (argv[i] === '--client') clientPath = path.resolve(argv[++i]);
    else { console.error('unknown arg: ' + argv[i]); process.exit(2); }
  }

  let client, text, loc, lines;
  try {
    client = parseClient(fs.readFileSync(clientPath, 'utf8'));
    text = fs.readFileSync(html, 'utf8');
    lines = text.split('\n');
    loc = locateParams(lines);
  } catch (e) {
    console.error('ERROR: ' + e.message);
    process.exit(2);
  }

  const errs = checkKeys(loc.params, client);
  if (errs.length) {
    console.error('KEY MISMATCH (' + errs.length + ') - 장면/키 불일치, 중단');
    errs.forEach(e => console.error('  ' + e));
    process.exit(2);
  }

  warnRanges(loc.params, client).forEach(w => console.log(w));

  let diffs = compare(loc.params, client);
  diffs.forEach(d => console.log(d.scene + '.' + d.key + ' web=' + fmtVal(d.field, d.web) + ' client=' + fmtVal(d.field, d.client)));

  if (check) {
    console.log('differences: ' + diffs.length);
    process.exit(diffs.length > 0 ? 1 : 0);
  }

  const r = rewrite(lines, loc, client);
  const newText = r.out.join('\n');
  if (newText !== text) fs.writeFileSync(html, newText);
  console.log('rows changed: ' + r.changed + (newText === text ? ' (file untouched)' : ' (written)'));

  const loc2 = locateParams(r.out);
  diffs = compare(loc2.params, client);
  if (diffs.length) {
    console.error('ERROR: ' + diffs.length + ' differences remain after write');
    diffs.forEach(d => console.error('  ' + d.scene + '.' + d.key + ' web=' + fmtVal(d.field, d.web) + ' client=' + fmtVal(d.field, d.client)));
    process.exit(1);
  }
  console.log('verified: 0 differences');
}

main();
