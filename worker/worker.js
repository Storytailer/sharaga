/**
 * «Шарага» — синхронизация и push-уведомления о парах.
 *
 * Почему этот файл существует в репозитории: раньше воркер жил только в
 * панели Cloudflare, исходника нигде не было. Из-за этого нельзя было ни
 * починить его, ни перенести, ни понять, что он делает. Теперь всё здесь.
 *
 * Что делает:
 *   GET  /api/data              — прочитать задания;
 *   POST /api/data              — записать задания (заголовок x-sync-key);
 *   POST /api/subscribe         — зарегистрировать push-подписку;
 *   POST /api/unsubscribe       — снять подписку;
 *   GET  /api/subs              — список подписок (для отправителя);
 *   GET  /api/vapid             — публичный ключ отправителя;
 *   POST /api/settings          — настройки напоминаний;
 *   scheduled (каждую минуту)  — проверка расписания и отправка push.
 *
 * Почему отправка живёт здесь, а не в GitHub Actions: у Actions cron
 * заявлено «каждые 5 минут», а по факту он запускается раз в 3–6 часов
 * (замерено 27–29.09.2026). Из-за этого напоминания о парах не приходили
 * вообще ни разу. У этого воркера свой таймер, он честно срабатывает
 * раз в минуту.
 */

const SYNC_KEY = 'sharaga-sync-2026';
const CONTACT = 'mailto:sharaga@example.com';

// Расписание — тот же источник правды, что и в index.html. Второй источник
// запрещён: если они разойдутся, напоминания будут приходить не о тех парах.
const PAIRS = [
  {"d":"2026-09-02","t":"14:10 - 15:45","ds":"Организация культурно-массовых мероприятий для молодежи","tp":"Пр","rm":"к. 1/303","st":"Садовникова Ю.М."},
  {"d":"2026-09-02","t":"15:55 - 17:30","ds":"Проектирование в профессиональной деятельности","tp":"КрП","rm":"к. 1/708","st":"Познякова К.Н."},
  {"d":"2026-09-02","t":"17:40 - 19:15","ds":"Социология молодежи","tp":"Лек","rm":"к. 1/205","st":"Максимов М.А."},
  {"d":"2026-09-03","t":"10:25 - 12:00","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/204","st":"Иванова И.В."},
  {"d":"2026-09-03","t":"12:20 - 13:55","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Пр","rm":"к. 1/210","st":"Портнова О.А."},
  {"d":"2026-09-03","t":"14:10 - 15:45","ds":"Социология молодежи","tp":"Пр","rm":"к. 1/305","st":"Максимов М.А."},
  {"d":"2026-09-04","t":"12:20 - 13:55","ds":"Практикум по социальному проектированию","tp":"Инд","rm":"к. 1/211","st":"Иванова И.В."},
  {"d":"2026-09-04","t":"14:10 - 15:45","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Пр","rm":"к. 1/910","st":"Познякова К.Н."},
  {"d":"2026-09-04","t":"15:55 - 17:30","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Инд","rm":"к. 1/904","st":"Портнова О.А."},
  {"d":"2026-09-07","t":"08:30 - 10:05","ds":"Проектирование в профессиональной деятельности","tp":"КрП","rm":"к. 1/705","st":"Познякова К.Н."},
  {"d":"2026-09-07","t":"10:25 - 12:00","ds":"Организация культурно-массовых мероприятий для молодежи","tp":"Пр","rm":"к. 1/210","st":"Садовникова Ю.М."},
  {"d":"2026-09-08","t":"08:30 - 10:05","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Инд","rm":"к. 1/211","st":"Познякова К.Н."},
  {"d":"2026-09-08","t":"10:25 - 12:00","ds":"Практикум проектирования культурно-массовой работы в молодежной среде","tp":"Пр","rm":"к. 1/210","st":"Садовникова Ю.М."},
  {"d":"2026-09-08","t":"12:20 - 13:55","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/210","st":"Иванова И.В."},
  {"d":"2026-09-09","t":"08:30 - 10:05","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Пр","rm":"к. 1/211","st":"Познякова К.Н."},
  {"d":"2026-09-09","t":"10:25 - 12:00","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/907","st":"Иванова И.В."},
  {"d":"2026-09-09","t":"12:20 - 13:55","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Лек","rm":"к. 1/210","st":"Портнова О.А."},
  {"d":"2026-09-09","t":"14:10 - 15:45","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Инд","rm":"к. 1/303","st":"Портнова О.А."},
  {"d":"2026-09-10","t":"12:20 - 13:55","ds":"Социология","tp":"Инд","rm":"к. 1/705","st":"Максимов М.А."},
  {"d":"2026-09-10","t":"14:10 - 15:45","ds":"Практикум проектирования культурно-массовой работы в молодежной среде","tp":"Инд","rm":"к. 1/310","st":"Садовникова Ю.М."},
  {"d":"2026-09-10","t":"15:55 - 17:30","ds":"Организация культурно-массовых мероприятий для молодежи","tp":"Лек","rm":"к. 1/310","st":"Садовникова Ю.М."},
  {"d":"2026-09-11","t":"08:30 - 10:05","ds":"Практикум по социальному проектированию","tp":"Инд","rm":"к. 1/309","st":"Иванова И.В."},
  {"d":"2026-09-11","t":"10:25 - 12:00","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Пр","rm":"к. 1/204","st":"Портнова О.А."},
  {"d":"2026-09-14","t":"14:10 - 15:45","ds":"Проектирование в профессиональной деятельности","tp":"КрП","rm":"к. 1/704","st":"Познякова К.Н."},
  {"d":"2026-09-14","t":"15:55 - 17:30","ds":"Социология","tp":"Лек","rm":"к. 1/204","st":"Максимов М.А."},
  {"d":"2026-09-14","t":"17:40 - 19:15","ds":"Социология","tp":"Пр","rm":"к. 1/204","st":"Максимов М.А."},
  {"d":"2026-09-15","t":"10:25 - 12:00","ds":"Практикум проектирования культурно-массовой работы в молодежной среде","tp":"Пр","rm":"к. 1/403","st":"Садовникова Ю.М."},
  {"d":"2026-09-15","t":"12:20 - 13:55","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/210","st":"Иванова И.В."},
  {"d":"2026-09-15","t":"14:10 - 15:45","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Лек","rm":"к. 1/704","st":"Познякова К.Н."},
  {"d":"2026-09-16","t":"14:10 - 15:45","ds":"Организация культурно-массовых мероприятий для молодежи","tp":"Пр","rm":"к. 1/303","st":"Садовникова Ю.М."},
  {"d":"2026-09-16","t":"15:55 - 17:30","ds":"Проектирование в профессиональной деятельности","tp":"КрП","rm":"к. 1/708","st":"Познякова К.Н."},
  {"d":"2026-09-16","t":"17:40 - 19:15","ds":"Социология молодежи","tp":"Лек","rm":"к. 1/205","st":"Максимов М.А."},
  {"d":"2026-09-17","t":"10:25 - 12:00","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/204","st":"Иванова И.В."},
  {"d":"2026-09-17","t":"12:20 - 13:55","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Пр","rm":"к. 1/711","st":"Портнова О.А."},
  {"d":"2026-09-17","t":"14:10 - 15:45","ds":"Социология молодежи","tp":"Пр","rm":"к. 1/305","st":"Максимов М.А."},
  {"d":"2026-09-18","t":"12:20 - 13:55","ds":"Практикум по социальному проектированию","tp":"Инд","rm":"к. 1/211","st":"Иванова И.В."},
  {"d":"2026-09-18","t":"14:10 - 15:45","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Пр","rm":"к. 1/910","st":"Познякова К.Н."},
  {"d":"2026-09-18","t":"15:55 - 17:30","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Инд","rm":"к. 1/904","st":"Портнова О.А."},
  {"d":"2026-09-21","t":"08:30 - 10:05","ds":"Проектирование в профессиональной деятельности","tp":"КрП","rm":"к. 1/705","st":"Познякова К.Н."},
  {"d":"2026-09-21","t":"10:25 - 12:00","ds":"Организация культурно-массовых мероприятий для молодежи","tp":"Пр","rm":"к. 1/210","st":"Садовникова Ю.М."},
  {"d":"2026-09-22","t":"08:30 - 10:05","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Инд","rm":"к. 1/211","st":"Познякова К.Н."},
  {"d":"2026-09-22","t":"10:25 - 12:00","ds":"Практикум проектирования культурно-массовой работы в молодежной среде","tp":"Пр","rm":"к. 1/210","st":"Садовникова Ю.М."},
  {"d":"2026-09-22","t":"12:20 - 13:55","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/210","st":"Иванова И.В."},
  {"d":"2026-09-23","t":"08:30 - 10:05","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Пр","rm":"к. 1/211","st":"Познякова К.Н."},
  {"d":"2026-09-23","t":"10:25 - 12:00","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/204","st":"Иванова И.В."},
  {"d":"2026-09-23","t":"12:20 - 13:55","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Инд","rm":"к. 1/210","st":"Портнова О.А."},
  {"d":"2026-09-24","t":"12:20 - 13:55","ds":"Социология","tp":"Инд","rm":"к. 1/705","st":"Максимов М.А."},
  {"d":"2026-09-24","t":"14:10 - 15:45","ds":"Практикум проектирования культурно-массовой работы в молодежной среде","tp":"Инд","rm":"к. 1/310","st":"Садовникова Ю.М."},
  {"d":"2026-09-25","t":"08:30 - 10:05","ds":"Практикум по социальному проектированию","tp":"Инд","rm":"к. 1/309","st":"Иванова И.В."},
  {"d":"2026-09-25","t":"10:25 - 12:00","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Пр","rm":"к. 1/204","st":"Портнова О.А."},
  {"d":"2026-09-28","t":"14:10 - 15:45","ds":"Проектирование в профессиональной деятельности","tp":"КрП","rm":"к. 1/704","st":"Познякова К.Н."},
  {"d":"2026-09-28","t":"15:55 - 17:30","ds":"Социология","tp":"Лек","rm":"к. 1/204","st":"Максимов М.А."},
  {"d":"2026-09-28","t":"17:40 - 19:15","ds":"Социология","tp":"Пр","rm":"к. 1/204","st":"Максимов М.А."},
  {"d":"2026-09-29","t":"10:25 - 12:00","ds":"Практикум проектирования культурно-массовой работы в молодежной среде","tp":"Пр","rm":"к. 1/403","st":"Садовникова Ю.М."},
  {"d":"2026-09-29","t":"12:20 - 13:55","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/210","st":"Иванова И.В."},
  {"d":"2026-09-29","t":"14:10 - 15:45","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Лек","rm":"к. 1/704","st":"Познякова К.Н."},
  {"d":"2026-09-30","t":"14:10 - 15:45","ds":"Организация культурно-массовых мероприятий для молодежи","tp":"Пр","rm":"к. 1/303","st":"Садовникова Ю.М."},
  {"d":"2026-09-30","t":"15:55 - 17:30","ds":"Проектирование в профессиональной деятельности","tp":"КрП","rm":"к. 1/708","st":"Познякова К.Н."},
  {"d":"2026-09-30","t":"17:40 - 19:15","ds":"Социология молодежи","tp":"Лек","rm":"к. 1/205","st":"Максимов М.А."},
  {"d":"2026-10-01","t":"10:25 - 12:00","ds":"Практикум по социальному проектированию","tp":"Пр","rm":"к. 1/204","st":"Иванова И.В."},
  {"d":"2026-10-01","t":"12:20 - 13:55","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Пр","rm":"к. 1/210","st":"Портнова О.А."},
  {"d":"2026-10-01","t":"14:10 - 15:45","ds":"Социология молодежи","tp":"Пр","rm":"к. 1/305","st":"Максимов М.А."},
  {"d":"2026-10-02","t":"12:20 - 13:55","ds":"Практикум по социальному проектированию","tp":"Инд","rm":"к. 1/211","st":"Иванова И.В."},
  {"d":"2026-10-02","t":"14:10 - 15:45","ds":"Руководство деятельностью детско-подростковых и молодёжных организаций и объединений","tp":"Пр","rm":"к. 1/910","st":"Познякова К.Н."},
  {"d":"2026-10-02","t":"15:55 - 17:30","ds":"Организация социально-полезной деятельности в молодёжных организациях","tp":"Инд","rm":"к. 1/904","st":"Портнова О.А."}
];

// ============ хранилище (KV) ============
// KV, а не переменная: переменная переживает передеплой, и за пару минут
// активной синхронизации можно было потерять всё накопленное.
const DB = 'sharaga';           // KV-биндинг
const SUBS = 'sharaga_subs';    // KV-биндинг
const VAPID_KV = 'sharaga_vapid';
const SETTINGS_KV = 'sharaga_settings';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-sync-key',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
});

export default {
  async fetch(req, env){
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const u = new URL(req.url);
    try {
      if (u.pathname === '/api/data' && req.method === 'GET') return await getData(env);
      if (u.pathname === '/api/data' && req.method === 'POST') return await putData(req, env);
      if (u.pathname === '/api/subscribe' && req.method === 'POST') return await subscribe(req, env);
      if (u.pathname === '/api/unsubscribe' && req.method === 'POST') return await unsubscribe(req, env);
      if (u.pathname === '/api/subs') return await listSubs(req, env);
      if (u.pathname === '/api/vapid') return await vapidInfo(env);
      if (u.pathname === '/api/settings' && req.method === 'POST') return await saveSettings(req, env);
      if (u.pathname === '/api/settings') return await getSettings(env);
      if (u.pathname === '/api/ping') return await ping(env);
      if (u.pathname === '/') return new Response('Sharaga sync ok', { headers: CORS });
      return json({ ok: false, error: 'not-found' }, 404);
    } catch (e){
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },

  // Таймер воркера срабатывает раз в минуту — в отличие от cron в GitHub.
  async scheduled(event, env, ctx){
    ctx.waitUntil(tick(env, event && event.cron).catch(e => console.error('tick:', e && e.message)));
  },
};

async function ping(env){
  const t = await getKeys(env);
  return json({ ok: true, vapid: await publicKey(env), subs: t.length, pairs: PAIRS.length });
}

function authorized(req){
  return req.headers.get('x-sync-key') === SYNC_KEY;
}

async function getData(env){
  const raw = await env[DB].get('pairs', 'json');
  return json({ ok: true, data: { pairs: raw || {} } });
}

async function putData(req, env){
  if (!authorized(req)) return json({ ok: false, error: 'bad-key' }, 401);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !body.pairs || typeof body.pairs !== 'object'){
    // Пустой объект тоже принимаем: раньше воркер падал на {}, и это выглядело
    // как «ошибка отправки» при вполне рабочей сети.
    await env[DB].put('pairs', JSON.stringify({}));
    return json({ ok: true, data: { pairs: {} } });
  }
  const pairs = body.pairs;
  const n = Object.keys(pairs).filter(k => k !== '_loose').length;
  await env[DB].put('pairs', JSON.stringify(pairs));
  return json({ ok: true, n, data: { pairs } });
}

/* ---------- подписки ---------- */

async function getKeys(env){
  const list = await env[SUBS].list();
  return list.keys.map(k => k.name);
}

async function subscribe(req, env){
  const body = await req.json().catch(() => null);
  if (!body || !body.subscription || !body.subscription.endpoint) return json({ ok: false, error: 'no-sub' }, 400);
  const sub = body.subscription;
  await env[SUBS].put(hashKey(sub.endpoint), JSON.stringify({ sub, min: body.min || 5, at: Date.now() }));
  return json({ ok: true });
}

async function unsubscribe(req, env){
  const body = await req.json().catch(() => null);
  if (!body || !body.endpoint) return json({ ok: false, error: 'no-endpoint' }, 400);
  await env[SUBS].delete(hashKey(body.endpoint));
  return json({ ok: true });
}

async function listSubs(req, env){
  if (!authorized(req)) return json({ ok: false, error: 'bad-key' }, 403);
  const names = await getKeys(env);
  const subs = [];
  for (const n of names){
    const rec = await env[SUBS].get(n, 'json');
    if (rec && rec.sub) subs.push(rec.sub);
  }
  return json({ ok: true, subs });
}

async function saveSettings(req, env){
  const body = await req.json().catch(() => ({}));
  await env[SETTINGS_KV].put('global', JSON.stringify({ min: body.min || 5 }));
  return json({ ok: true });
}
async function getSettings(env){
  const s = await env[SETTINGS_KV].get('global', 'json');
  return json({ ok: true, settings: s || { min: 5 } });
}

function hashKey(s){
  // Подписки накапливаются, а endpoint'ы длинные — нужен короткий ключ.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'sub_' + h.toString(16);
}

/* ---------- ключи отправителя ---------- */
// Пара ключей генерируется один раз и кладётся в KV. Публичный ключ
// дублируется в index.html (VAPID_PUBLIC) — при смене ключей менять оба места.

async function loadVapid(env){
  const rec = await env[VAPID_KV].get('keys', 'json');
  if (rec) return rec;
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']
  );
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const rec2 = { publicRaw: b64url(pub), privatePkcs8: b64url(new Uint8Array(priv)) };
  await env[VAPID_KV].put('keys', JSON.stringify(rec2));
  return rec2;
}
async function publicKey(env){
  const v = await loadVapid(env);
  return v.publicRaw;
}
async function vapidInfo(env){
  return json({ ok: true, publicKey: await publicKey(env) });
}

/* ---------- уведомления о парах ---------- */

const TZ_OFFSET_MIN = 180;   // UTC+3, Москва
const LEAD_MIN = 10;         // за сколько минут предупреждать
const GRACE_MIN = 3;         // воркер просыпается каждую минуту, тут запас маленький
const DIGEST_FROM = '07:00';
const DIGEST_TO = '07:59';

function localToEpoch(dateStr, hhmm){
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - TZ_OFFSET_MIN * 60000;
}
function nowLocal(){
  const d = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  return { date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) };
}
const startTime = p => String(p.t).split(' - ')[0];
function plural(n, one, few, many){
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function tick(env, cron){
  const now = Date.now();
  const { date: today, hhmm } = nowLocal();

  // Не присылать одно и то же дважды: метки лежат в KV с TTL 2 дня.
  const seen = (await env[SETTINGS_KV].get('seen:' + today, 'json')) || {};

  const names = await getKeys(env);
  if (!names.length){ await env[SETTINGS_KV].put('log:' + today, 'нет подписок', { expirationTtl: 172800 }); return; }
  const subs = [];
  for (const n of names){
    const rec = await env[SUBS].get(n, 'json');
    if (rec && rec.sub) subs.push(rec.sub);
  }
  if (!subs.length) return;

  const out = [];

  // 1. Утренняя сводка на день.
  if (hhmm >= DIGEST_FROM && hhmm <= DIGEST_TO && !seen['digest']){
    const todays = PAIRS.filter(p => p.d === today).sort((a, b) => startTime(a).localeCompare(startTime(b)));
    if (todays.length){
      out.push({
        title: '📅 Сегодня ' + todays.length + ' ' + plural(todays.length, 'пара', 'пары', 'пар'),
        body: todays.map(p => startTime(p) + ' · ' + p.ds + ' (' + (p.rm || 'каб. ?') + ')').join('\n'),
        tag: 'sharaga-digest-' + today,
      });
      seen['digest'] = now;
    }
  }

  // 2. Напоминание перед парой.
  const window = (LEAD_MIN + GRACE_MIN) * 60000;
  for (const p of PAIRS){
    const left = localToEpoch(p.d, startTime(p)) - now;
    if (left < 0 || left > window) continue;
    const key = p.d + '|' + p.t;
    if (seen[key]) continue;
    const mins = Math.max(1, Math.round(left / 60000));
    out.push({
      title: '🔔 Через ' + mins + ' ' + plural(mins, 'минуту', 'минуты', 'минут') + ' — ' + p.ds,
      body: startTime(p) + ' · ' + (p.rm || 'каб. ?') + ' · ' + (p.st || '') + ' · ' + (p.tp || ''),
      tag: 'sharaga-pair-' + key,
    });
    seen[key] = now;
  }

  if (out.length) await env[SETTINGS_KV].put('seen:' + today, JSON.stringify(seen), { expirationTtl: 172800 });

  for (const payload of out){
    for (const sub of subs){
      try {
        await sendPush(env, sub, payload);
      } catch (e){
        const msg = String(e && e.message || e);
        // 404/410 — подписки больше нет; VapidPkHashMismatch — подписка
        // сделана под другим ключом и не примет пуш никогда. В обоих
        // случаях держать её бессмысленно.
        if (/404|410|gone|VapidPkHashMismatch/i.test(msg)){
          await env[SUBS].delete(hashKey(sub.endpoint));
        }
        console.error('push:', msg);
      }
    }
  }
  if (out.length) await env[SETTINGS_KV].put('log:' + today, 'отправлено ' + out.length, { expirationTtl: 172800 });
}

/* ---------- Web Push (RFC 8291) ---------- */
// Написано без библиотек: в воркере нет npm-пакетов, а тащить web-push
// через nodejs_compat — лишняя хрупкость. Здесь только то, что нужно.

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b64urlToBytes(s){
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function vapidAuth(endpoint, keys){
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT };
  const enc = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = enc(header) + '.' + enc(payload);
  const key = await crypto.subtle.importKey(
    'pkcs8', b64urlToBytes(keys.privatePkcs8),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  // WebCrypto отдаёт r||s — ровно то, что нужно для ES256 в JWT.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)
  ));
  return 'vapid t=' + signingInput + '.' + b64url(sig) + ', k=' + keys.publicRaw;
}

async function sendPush(env, subscription, payload){
  const keys = await loadVapid(env);
  const p256dh = b64urlToBytes(subscription.keys.p256dh);
  const auth = b64urlToBytes(subscription.keys.auth);

  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const localKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const remotePub = await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Именно .privateKey: generateKey возвращает ПАРУ ключей, а deriveBits
  // принимает приватный. С самой парой вызов падает, и ни одно уведомление
  // не отправляется.
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePub }, localKeys.privateKey, 256
  ));
  const localPub = new Uint8Array(await crypto.subtle.exportKey('raw', localKeys.publicKey));

  const ua = b64url(localPub);
  const hmac = (key, ...parts) => crypto.subtle.sign('HMAC', key, concat(parts));

  const authInfo = concat([te('WebPush: info'), new Uint8Array([ua.length]), te(ua),
                           new Uint8Array([auth.length]), auth]);
  const prk = await hmac(await crypto.subtle.importKey('raw', authSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), bits);
  const ikm = await hmac(await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), authInfo, new Uint8Array([1]));

  const cek = (await hmac(await crypto.subtle.importKey('raw', ikm, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    te('Content-Encoding: aes128gcm'), new Uint8Array([1]))).slice(0, 16);
  const nonce = (await hmac(await crypto.subtle.importKey('raw', ikm, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    te('Content-Encoding: nonce'), new Uint8Array([1]))).slice(0, 12);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const body = te(JSON.stringify(payload));
  const rs = new Uint8Array(4096);
  const plain = concat([salt, rs, new Uint8Array([body.length]), body]);
  // Заголовок шифра: соль(16) + размер записи(4, big-endian) + длина(1) + ключ(65).
  // Размер записи 4096 записывается как 00 00 10 00, а длина ключа — это
  // длина СЫРОГО публичного ключа (65), а не его base64-строки (44).
  const header = concat([salt, new Uint8Array([0x00, 0x00, 0x10, 0x00]),
                         new Uint8Array([localPub.length]), localPub]);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 }, aesKey, plain
  ));

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidAuth(subscription.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '1800',
      'Urgency': 'high',
    },
    body: concat([header, sealed]),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return res;
}

const te = s => new TextEncoder().encode(s);
function concat(arrs){
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs){ out.set(a, o); o += a.length; }
  return out;
}
