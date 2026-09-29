/**
 * Экспорт расписания в календарь iOS (.ics) и в JSON для приложения.
 *
 * Зачем .ics: напоминание о паре должно приходить всегда — даже без сети,
 * без Cloudflare и без GitHub. Если внести расписание в системный календарь
 * iPhone, напоминания делает сама iOS: это надёжнее любого веб-сервера,
 * потому что не зависит ни от одного внешнего сервиса.
 *
 * Зачем next.json: приложение и внешние скрипты берут расписание отсюда,
 * а не парсят index.html.
 *
 * Запуск:  node .github/scripts/export-calendar.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PAIRS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/const PAIRS = (\[[\s\S]*?\]);/)[1]
);

// --- утилиты iCalendar ---
const pad = n => String(n).padStart(2, '0');
// Дата в iCalendar пишется без разделителей: 20260928T143000
function icsDate(d, h, m){
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
         'T' + pad(h) + pad(m) + '00';
}
function icsStamp(dt){
  return dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate()) +
         'T' + pad(dt.getUTCHours()) + pad(dt.getUTCMinutes()) + pad(dt.getUTCSeconds()) + 'Z';
}
// Строка с кириллицей: iOS ждёт UTF-8, длинные строки переносим.
function fold(line){
  if (line.length <= 73) return line;
  const out = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length){
    out.push(' ' + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  return out.join('\r\n');
}
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

// Смещение часового пояса: расписание записано в местном времени (Москва, +3).
const TZ_OFFSET_MIN = 180;
const t0 = Date.now();
const lines = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Sharaga//Schedule//RU',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Учёбные пары Б-ОРМ-41',
  'X-WR-TIMEZONE:Europe/Moscow',
];

for (const p of PAIRS){
  // p.d в формате ГГГГ-ММ-ДД. Разбор по именам: порядок важен, путать
  // год с месяцем нельзя — иначе все пары попадут на 1 января.
  const [YEAR, MONTH, DAY] = p.d.split('-').map(Number);
  const [fh, fm] = p.t.split(' - ')[0].split(':').map(Number);
  const [th, tm] = p.t.split(' - ')[1].split(':').map(Number);
  const dt = new Date(Date.UTC(YEAR, MONTH - 1, DAY));

  // Проверка: разобранная дата обязана совпасть с исходной строкой.
  if (dt.getUTCFullYear() !== YEAR || dt.getUTCMonth() !== MONTH - 1 || dt.getUTCDate() !== DAY){
    throw new Error('дата разобралась неверно: ' + p.d + ' -> ' + dt.toISOString().slice(0, 10));
  }

  const title = p.ds + ' (' + p.tp + ')';
  const desc = [
    'Пара: ' + p.ds,
    'Вид: ' + p.tp,
    'Кабинет: ' + p.rm,
    'Преподаватель: ' + p.st,
    '',
    'Открыть расписание: https://storytailer.github.io/sharaga/',
  ].join('\n');

  lines.push(
    'BEGIN:VEVENT',
    'UID:sharaga-' + p.d.replace(/-/g, '') + '-' + p.t.replace(/[^0-9]/g, '') + '@kgu',
    // DTSTAMP обязателен, без него iOS считает файл повреждённым
    'DTSTAMP:' + icsStamp(new Date()),
    'DTSTART:' + icsDate(dt, fh, fm),
    'DTEND:' + icsDate(dt, th, tm),
    fold('SUMMARY:' + esc(title)),
    fold('LOCATION:' + esc(p.rm)),
    fold('DESCRIPTION:' + esc(desc)),
    // Напоминание за 25 минут: система пришлёт его сама, без сети и сервера.
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT25M',
    fold('DESCRIPTION:' + esc('Через 25 минут: ' + p.ds + ', ' + p.rm)),
    'END:VALARM',
    'END:VEVENT'
  );
}
lines.push('END:VCALENDAR');

const ics = lines.join('\r\n') + '\r\n';
fs.writeFileSync(path.join(ROOT, 'schedule.ics'), ics, 'utf8');

// --- JSON для приложения и внешних скриптов ---
const json = {
  group: 'Б-ОРМ-41',
  tz: 'Europe/Moscow',
  tzOffsetMin: TZ_OFFSET_MIN,
  exported: new Date().toISOString(),
  count: PAIRS.length,
  pairs: PAIRS,
};
fs.writeFileSync(path.join(ROOT, 'schedule.json'), JSON.stringify(json, null, 1), 'utf8');

console.log('schedule.ics:  ' + PAIRS.length + ' пар, ' + Math.round(ics.length / 1024) + ' КБ');
console.log('schedule.json: ' + PAIRS.length + ' пар, ' + Math.round(fs.statSync(path.join(ROOT, 'schedule.json')).size / 1024) + ' КБ');
console.log('первая пара:   ' + PAIRS[0].d + ' ' + PAIRS[0].t);
console.log('последняя:     ' + PAIRS[PAIRS.length - 1].d + ' ' + PAIRS[PAIRS.length - 1].t);
