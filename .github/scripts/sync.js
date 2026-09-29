#!/usr/bin/env node
/**
 * Синхронизатор «Шараги» для ноутбука.
 *
 * Зачем он нужен: телефон пишет в облако, ноутбуку нужно видеть это само,
 * а готовое решение с ноутбука должно само возвращаться в облако.
 * Раньше для этого надо было вручную нажимать кнопки в приложении, из-за
 * чего «связь» и выглядела ненадёжной.
 *
 * Что делает:
 *   pull — забрать задания из облака в дз/домашка.json (то, что задал телефон);
 *   push — положить готовое из готовые/ в облако (то, что сделал ассистент);
 *   auto — pull + push, ничего не спрашивая (для автозапуска по расписанию);
 *   list — показать, что сейчас ждёт решения.
 *
 * Ключи лежат в переменных окружения SHARAGA_KEY (облако). Если ключа нет —
 * берётся из index.html, чтобы на ноутбуке с репозиторием работало сразу.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// Скрипт живёт в .github/scripts, поэтому до корня репозитория два шага вверх.
const ROOT = path.join(__dirname, '..', '..');
const CLOUD_URL = 'https://sharaga-sync.sharaga.workers.dev/api/data';
const TASKLIST_URL = 'https://storytailer.github.io/sharaga/cloud/tasks.json';
const OUT_DIR = path.join(ROOT, 'дз');
const READY_DIR = path.join(ROOT, 'готовые');
// Файлы (презентации, методички) живут в files/ и раздаются с GitHub Pages.
// Папка латинская: кириллица в URL ломает ссылки на iPhone.
const FILES_DIR = path.join(ROOT, 'files');
const PAGES_BASE = 'https://storytailer.github.io/sharaga/files/';
const SNAPSHOT = path.join(OUT_DIR, 'домашка.json');

function readKey(){
  if (process.env.SHARAGA_KEY) return process.env.SHARAGA_KEY;
  // Ключ есть в приложении — берём оттуда, чтобы не заводить второй.
  try {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/const CLOUD_KEY = '([^']+)'/);
    if (m) return m[1];
  } catch(e){}
  throw new Error('не найден ключ облака. Задай SHARAGA_KEY в переменных окружения.');
}

function request(method, url, body, headers){
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body, 'utf8') : null;
    const u = new URL(url);
    const req = https.request({
      method: method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({}, headers, data ? { 'Content-Length': data.length } : {}),
      timeout: 25000,
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(buf)); } catch(e){ reject(new Error('плохой ответ: ' + buf.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('облако не ответило вовремя')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Связь с воркером бывает рваной: соединение обрывается или подвисает.
// Без повторов фоновая синхронизация просто молча не отрабатывает. Три
// попытки с паузой — этого хватает; дальше бессмысленно мешать сети.
async function retry(fn, tries = 3, delayMs = 1200){
  let last;
  for (let i = 0; i < tries; i++){
    try { return await fn(); }
    catch (e){
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

// ====== Слияние: то же правило, что в приложении ======
// Побеждает более свежее поле по метке времени. Так готовое с ноутбука
// не затирает ДЗ, написанное на телефоне, и наоборот.
function mergeTasks(remote, local){
  const out = {};
  const copy = r => { const c = {}; for (const k in r) c[k] = r[k]; return c; };
  for (const k in (remote || {})) if (k !== '_loose') out[k] = copy(remote[k]);
  for (const k in (local || {})){
    if (k === '_loose') continue;
    const r = remote ? remote[k] : null;
    const l = local[k];
    if (!r){ out[k] = copy(l); continue; }
    const m = copy(r);
    if (l.dz && (!r.dz || (l.dzAt || 0) > (r.dzAt || 0))){ m.dz = l.dz; m.dzAt = l.dzAt; }
    if (l.ready && (!r.ready || (l.readyAt || 0) > (r.readyAt || 0))){ m.ready = l.ready; m.readyAt = l.readyAt; }
    if (l.dueD && !m.dueD){ m.dueD = l.dueD; m.dueT = l.dueT; }
    if (l.files && (!r.files || (l.filesAt || 0) > (r.filesAt || 0))){ m.files = l.files; m.filesAt = l.filesAt; }
    if (!m.ds && l.ds) m.ds = l.ds;
    out[k] = m;
  }
  return out;
}

function readSnapshot(){
  try { return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).tasks || {}; }
  catch(e){ return {}; }
}
function writeSnapshot(tasks){
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = { app: 'sharaga', version: 3, exported: new Date().toISOString(), group: 'Б-ОРМ-41', tasks };
  fs.writeFileSync(SNAPSHOT, JSON.stringify(payload, null, 2), 'utf8');
}

// Готовое, сделанное на ноутбуке: готовые/<дата>_<час-минуты>.txt
// Например: готовые/2026-09-29_12-20.txt
// Имя файла НЕ содержит «|» — этот символ зарезервирован в Windows и файл
// с таким именем просто не создаётся. Ключ записи восстанавливается по паре.
function readyFileName(id){
  const p = id.split('|');
  return p[0] + '_' + String(p[1] || '').split(' - ')[0].replace(':', '-') + '.txt';
}
function readyFileToId(name, pairs){
  const m = name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})$/);
  if (!m) return null;
  const hm = m[2] + ':' + m[3];
  const p = pairs.find(x => x.d === m[1] && String(x.t).split(' - ')[0] === hm);
  return p ? pairId(p.d, p.t) : null;
}
function readReadyFiles(){
  const out = {};
  if (!fs.existsSync(READY_DIR)) return out;
  const pairs = readPairs();
  for (const f of fs.readdirSync(READY_DIR)){
    if (!/\.txt$/i.test(f)) continue;
    const id = readyFileToId(f.replace(/\.txt$/i, ''), pairs);
    if (!id){
      console.error('  пропущен готовый/файл: имя "' + f + '" не похоже на пару (нужно 2026-09-29_12-20.txt)');
      continue;
    }
    const txt = fs.readFileSync(path.join(READY_DIR, f), 'utf8').trim();
    if (txt) out[id] = txt;
  }
  return out;
}

function readPairs(){
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/const\s+PAIRS\s*=\s*(\[[\s\S]*?\]);/);
  return m ? JSON.parse(m[1]) : [];
}
function fmtDate(iso){
  const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const p = String(iso || '').split('-');
  return p.length === 3 ? Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] : '—';
}
function pairId(d, t){ return d + '|' + t; }
function startTime(t){ return String(t || '').split(' - ')[0] || ''; }
function dueLabel(rec, pairs){
  if (!rec.dueD) return 'срок не назначен';
  const p = pairs.find(x => x.d === rec.dueD && x.t === rec.dueT);
  return 'сдать ' + fmtDate(rec.dueD) + (p ? ' ' + startTime(p.t) : '');
}
// Запись годна, только если её ключ — настоящая пара расписания.
// Мусор из прежней версии (ключ — название предмета, без дат) сюда не попадает.
function isRealTask(k, rec, pairs){
  if (k === '_loose' || !rec || typeof rec !== 'object') return false;
  const p = k.split('|');
  return p.length === 2 && pairs.some(x => x.d === p[0] && x.t === p[1]);
}

async function cloudGet(key){
  const d = await retry(() => request('GET', CLOUD_URL, null, { 'x-sync-key': key }));
  return (d && d.ok && d.data && d.data.pairs) ? d.data.pairs : {};
}
async function cloudSet(key, tasks){
  return retry(() => request('POST', CLOUD_URL, JSON.stringify({ pairs: tasks }), {
    'Content-Type': 'application/json', 'x-sync-key': key,
  }));
}

function listTasks(tasks){
  const pairs = readPairs();
  const rows = [];
  for (const k in tasks){
    const r = tasks[k];
    if (!isRealTask(k, r, pairs)) continue;
    if (!(r.dz && r.dz.trim())) continue;
    const done = !!(r.ready && r.ready.trim());
    const due = r.dueD ? new Date(r.dueD + 'T' + startTime(r.dueT) + ':00') : null;
    rows.push({ k, r, done, late: !!(due && due < new Date()) });
  }
  rows.sort((a, b) => (Number(a.late) - Number(b.late)) || String(a.r.dueD || '9999').localeCompare(String(b.r.dueD || '9999')));
  if (!rows.length) return 'Заданий пока нет.';
  return rows.map((x, i) =>
    (i + 1) + '. [' + (x.done ? 'готово' : 'жду' + (x.late ? ' ПРОСРОЧЕНО' : '')) + '] ' +
    (x.r.ds || '—') + ' | ' + dueLabel(x.r, pairs) +
    '\n   задали: ' + fmtDate(x.r.d) + ' ' + startTime(x.r.t) +
    '\n   ДЗ: ' + String(x.r.dz).replace(/\s+/g, ' ').slice(0, 200)
  ).join('\n');
}

// Записи, которые не соответствуют ни одной паре расписания (мусор из
// прежней версии), убираются в _loose, а не засоряют календарь.
function splitJunk(tasks){
  const pairs = readPairs();
  const good = {}, junk = {};
  for (const k in tasks){
    if (k === '_loose'){ for (const j in tasks[k]) junk[j] = tasks[k][j]; continue; }
    if (isRealTask(k, tasks[k], pairs)) good[k] = tasks[k];
    else junk[k] = tasks[k];
  }
  return { good, junk };
}

// Вложения из files/. Имя файла — та же схема, что у готовых решений:
//   files/2026-09-29_17-40.pdf          — один файл на пару
//   files/2026-09-29_17-40_prezentaciya.pdf — несколько файлов на пару
// Папка латинская: кириллица в URL ломает ссылки на iPhone.
// Файл лежит в репозитории и раздаётся с GitHub Pages, поэтому в облако
// попадает только ссылка и размер — сам PDF туда не тащится.
const FILE_EXT = /\.(pdf|pptx?|docx?|xlsx?)$/i;
let skipped = [];
function readAttachments(){
  const out = {};
  skipped = [];
  if (!fs.existsSync(FILES_DIR)) return out;
  const pairs = readPairs();
  for (const f of fs.readdirSync(FILES_DIR)){
    if (f === '.gitkeep' || f.startsWith('.')) continue;
    // Любой файл в files/, который не привязался, попадает в skipped.
    // Молча пропускать нельзя: пользователь положил презентацию и ждёт её,
    // а она не появилась бы без единого слова.
    if (!FILE_EXT.test(f)){
      skipped.push('files/' + f + ' — не pdf/презентация/документ');
      continue;
    }
    const stem = f.replace(FILE_EXT, '');
    // хвост после времени — необязательный: он различает несколько файлов
    const m = stem.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})(?:_(.+))?$/);
    if (!m){
      skipped.push('files/' + f + ' — имя должно быть вида 2026-09-29_17-40.pdf');
      continue;
    }
    const p = pairs.find(x => x.d === m[1] && String(x.t).split(' - ')[0] === m[2] + ':' + m[3]);
    if (!p){
      skipped.push('files/' + f + ' — нет такой пары в расписании');
      continue;
    }
    const id = pairId(p.d, p.t);
    const st = fs.statSync(path.join(FILES_DIR, f));
    (out[id] = out[id] || []).push({
      name: f,
      url: PAGES_BASE + encodeURIComponent(f),
      size: st.size,
      ext: path.extname(f).slice(1).toLowerCase(),
    });
  }
  // Стабильный порядок, чтобы список не прыгал между запусками.
  for (const id in out) out[id].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function pull(key){
  const remote = await cloudGet(key);
  const merged = mergeTasks(remote, readSnapshot());
  const { good, junk } = splitJunk(merged);
  if (Object.keys(junk).length) good._loose = junk;
  writeSnapshot(good);
  return { n: Object.keys(good).filter(k => k !== '_loose').length, tasks: good, junk: Object.keys(junk) };
}

async function push(key, local){
  let tasks = local;
  // Файлы из готовые/ важнее облака: они свежее, их только что сделали.
  const files = readReadyFiles();
  const remote = await cloudGet(key);
  tasks = mergeTasks(files.size ? {} : remote, tasks);
  const pairs = readPairs();
  for (const id in files){
    if (!tasks[id]) tasks[id] = { d: id.split('|')[0], t: id.split('|')[1], ds: '' };
    tasks[id].ready = files[id];
    tasks[id].readyAt = Date.now();
    const p = pairs.find(x => x.d === tasks[id].d && x.t === tasks[id].t);
    if (p) tasks[id].ds = p.ds;
  }
  // Вложения приклеиваем всегда, даже если готовых решений не было.
  const att = readAttachments();
  let nAtt = 0;
  for (const id in att){
    if (!tasks[id]) tasks[id] = { d: id.split('|')[0], t: id.split('|')[1], ds: '' };
    const p = pairs.find(x => x.d === tasks[id].d && x.t === tasks[id].t);
    if (p) tasks[id].ds = p.ds;
    tasks[id].files = att[id];
    tasks[id].filesAt = Date.now();
    nAtt += att[id].length;
  }
  await cloudSet(key, tasks);
  // Снимок на ноутбуке обновляем сразу, иначе в дз/домашка.json файлов
  // не будет до следующего pull — и на ноутбуке они будут выглядеть
  // потерянными, хотя в облаке лежат.
  const { good } = splitJunk(tasks);
  writeSnapshot(good);
  return { n: Object.keys(files).length, nAtt, tasks };
}

async function main(){
  const cmd = process.argv[2] || 'auto';
  const key = readKey();
  const quiet = cmd === 'auto';
  const say = s => { if (!quiet) console.log(s); };

  if (cmd === 'list'){
    const remote = await cloudGet(key);
    console.log(listTasks(mergeTasks(remote, readSnapshot())));
    return;
  }

  // clean — убрать из облака записи, не соответствующие расписанию.
  // Нужна один раз: в облаке остался мусор из прежней версии («кирилл: x»).
  if (cmd === 'clean'){
    const remote = await cloudGet(key);
    const { good, junk } = splitJunk(mergeTasks(remote, readSnapshot()));
    const names = Object.keys(junk);
    if (!names.length){ console.log('Мусора нет — облако чистое.'); return; }
    await cloudSet(key, good);
    writeSnapshot(good);
    console.log('Убрано записей: ' + names.length + ' -> ' + names.join(', '));
    return;
  }

  if (cmd === 'pull' || cmd === 'auto'){
    const before = JSON.stringify(readSnapshot());
    const r = await pull(key);
    const changed = JSON.stringify(r.tasks) !== before;
    if (cmd === 'pull'){
      say('Забрал из облака: записей ' + r.n + (changed ? ' (домашка.json обновлён)' : ' (без изменений)'));
      if (r.junk.length) say('  неучтённый мусор (команда clean): ' + r.junk.join(', '));
    }
  }

  if (cmd === 'push' || cmd === 'auto'){
    const r = await push(key, readSnapshot());
    if (skipped.length) for (const s of skipped) console.error('  пропущен ' + s);
    if (cmd === 'push'){
      say('Залил в облако: готовых решений ' + r.n + ', файлов ' + r.nAtt +
          (skipped.length ? ', пропущено ' + skipped.length : ''));
    }
  }
}

main().catch(e => { console.error('Ошибка: ' + e.message); process.exit(1); });
