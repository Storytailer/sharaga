/**
 * Отправка push-напоминаний о парах.
 * Запускается из GitHub Actions по расписанию (cron) каждые 5 минут.
 *
 * Почему так: Cloudflare-воркер умеет только ХРАНИТЬ подписки, он никогда
 * ничего не отправлял — поэтому пуши и не приходили. Отправителем стал Actions.
 */
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const WORKER = process.env.WORKER_URL || 'https://sharaga-sync.sharaga.workers.dev';
const SYNC_KEY = process.env.SYNC_KEY || 'sharaga-sync-2026';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const CONTACT = process.env.VAPID_CONTACT || 'mailto:sharaga@example.com';

// Часовой пояс университета. Расписание в index.html записано в местном времени.
const TZ_OFFSET_MIN = parseInt(process.env.TZ_OFFSET_MIN || '180', 10); // UTC+3, Москва

// За сколько минут до пары напоминать и запас на задержку планировщика Actions.
const LEAD_MIN = parseInt(process.env.LEAD_MIN || '10', 10);
const GRACE_MIN = parseInt(process.env.GRACE_MIN || '9', 10);

// Утренняя сводка за день — окно по местному времени.
const DIGEST_FROM = process.env.DIGEST_FROM || '07:00';
const DIGEST_TO = process.env.DIGEST_TO || '07:59';

const STATE_FILE = process.env.STATE_FILE || 'sent.json';
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE_TEST = process.env.FORCE_TEST === '1';

function log(...a){ console.log(...a); }

/* ---------- расписание ---------- */

function readPairs(){
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const m = html.match(/const\s+PAIRS\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error('не нашёл PAIRS в index.html');
  return JSON.parse(m[1]);
}

/** Местное "YYYY-MM-DD" + "HH:MM" -> epoch ms (UTC). */
function localToEpoch(dateStr, hhmm){
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - TZ_OFFSET_MIN * 60000;
}

function nowLocalParts(){
  const local = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  return {
    date: local.toISOString().slice(0, 10),
    hhmm: local.toISOString().slice(11, 16),
  };
}

function startTime(p){ return p.t.split(' - ')[0].trim(); }

/* ---------- состояние (чтобы не слать дважды) ---------- */

function loadState(){
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e){ return {}; }
}
function saveState(state){
  // держим файл маленьким: чистим всё старше двух суток
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  for (const k of Object.keys(state)) if (state[k] < cutoff) delete state[k];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

/* ---------- подписки ---------- */

async function getSubs(){
  const r = await fetch(WORKER + '/api/subs', { headers: { 'x-sync-key': SYNC_KEY } });
  if (!r.ok) throw new Error('worker /api/subs -> HTTP ' + r.status);
  const d = await r.json();
  return Array.isArray(d.subs) ? d.subs : [];
}

async function dropSub(endpoint){
  try {
    await fetch(WORKER + '/api/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    log('  ↳ подписка устарела, удалил из воркера');
  } catch(e){ log('  ↳ не смог удалить подписку:', e.message); }
}

async function send(subs, payload){
  if (DRY_RUN){ log('  [dry-run]', JSON.stringify(payload)); return 0; }
  let ok = 0;
  for (const sub of subs){
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 1800, urgency: 'high' });
      ok++;
    } catch(e){
      const code = e.statusCode || 0;
      log('  ↳ ошибка отправки (' + code + '):', (e.body || e.message || '').toString().slice(0, 200));
      if (code === 404 || code === 410) await dropSub(sub.endpoint);
    }
  }
  return ok;
}

/* ---------- основное ---------- */

async function main(){
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error('нет секретов VAPID_PUBLIC / VAPID_PRIVATE');
  webpush.setVapidDetails(CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

  const pairs = readPairs();
  const subs = await getSubs();
  const state = loadState();
  const now = Date.now();
  const { date: today, hhmm: nowHHMM } = nowLocalParts();

  log('Сейчас (местное):', today, nowHHMM, '| подписок:', subs.length, '| пар в расписании:', pairs.length);

  if (!subs.length){
    log('Подписок нет — отправлять некому. Включи напоминания в приложении на телефоне.');
    return;
  }

  let sentAnything = false;

  if (FORCE_TEST){
    const n = await send(subs, {
      title: '✅ Тест Шараги',
      body: 'Push работает. Напоминания о парах будут приходить за ' + LEAD_MIN + ' мин.',
      tag: 'sharaga-test-' + now,
    });
    log('Тестовое отправлено на', n, 'устройств(а)');
    return;
  }

  /* 1. Утренняя сводка на день */
  if (nowHHMM >= DIGEST_FROM && nowHHMM <= DIGEST_TO){
    const key = 'digest|' + today;
    const todays = pairs
      .filter(p => p.d === today)
      .sort((a, b) => startTime(a).localeCompare(startTime(b)));
    if (!state[key] && todays.length){
      const body = todays.map(p => startTime(p) + ' · ' + p.ds + ' (' + (p.rm || 'каб. ?') + ')').join('\n');
      const n = await send(subs, {
        title: '📅 Сегодня ' + todays.length + ' ' + plural(todays.length, 'пара', 'пары', 'пар'),
        body,
        tag: 'sharaga-digest-' + today,
      });
      log('Сводка на день отправлена на', n, 'устройств(а)');
      state[key] = now; sentAnything = true;
    }
  }

  /* 2. Напоминания перед парой */
  const lookaheadMs = (LEAD_MIN + GRACE_MIN) * 60000;
  for (const p of pairs){
    const start = localToEpoch(p.d, startTime(p));
    const left = start - now;
    if (left < 0 || left > lookaheadMs) continue;

    const key = p.d + '|' + p.t;
    if (state[key]) continue;

    const mins = Math.max(1, Math.round(left / 60000));
    const n = await send(subs, {
      title: '🔔 Через ' + mins + ' ' + plural(mins, 'минуту', 'минуты', 'минут') + ' — ' + p.ds,
      body: startTime(p) + ' · ' + (p.rm || 'каб. ?') + ' · ' + (p.st || '') + ' · ' + (p.tp || ''),
      tag: 'sharaga-pair-' + key,
    });
    log('Напоминание "' + p.ds + '" (' + startTime(p) + ') отправлено на', n, 'устройств(а)');
    state[key] = now; sentAnything = true;
  }

  if (!sentAnything) log('Отправлять нечего — ближайших пар в окне нет.');
  saveState(state);
}

function plural(n, one, few, many){
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
