// Без зависимостей. Node 18+. Запуск: BOT_TOKEN=... BASE_URL=https://ваш.домен ALLOWED_IDS=111,222 node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const TOKEN = process.env.BOT_TOKEN, BASE = process.env.BASE_URL, PORT = process.env.PORT || 3000;
const ALLOWED = (process.env.ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEV = process.env.DEV === '1'; // только для локальной проверки без Telegram
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let DB = {}; try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const persist = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(DB)); fs.renameSync(FILE + '.tmp', FILE); };

function authed(initData) {
  if (DEV) return true;
  if (!initData || !TOKEN) return false;
  const p = new URLSearchParams(initData), hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc !== hash) return false;
  try { return ALLOWED.includes(String(JSON.parse(p.get('user')).id)); } catch (e) { return false; }
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const f = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(fs.existsSync);
    return res.end(fs.readFileSync(f));
  }
  if (!authed(req.headers['x-init'])) { res.statusCode = 403; return res.end('{"error":"forbidden"}'); }
  const [, , col, id] = u.pathname.split('/');
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    DB[col] = DB[col] || {};
    if (req.method === 'GET') return res.end(JSON.stringify(DB[col]));
    if (!id) { res.statusCode = 400; return res.end('{}'); }
    const d = body ? JSON.parse(body) : {};
    if (req.method === 'PUT') DB[col][id] = d;
    else if (req.method === 'PATCH') DB[col][id] = { ...(DB[col][id] || {}), ...d };
    else if (req.method === 'DELETE') delete DB[col][id];
    persist(); res.end('{"ok":true}');
  });
}).listen(PORT, () => console.log('Сервер на порту', PORT));

// --- Бот (long polling) ---
const tg = (m, b) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
async function bot() {
  if (!TOKEN) return console.log('BOT_TOKEN не задан — бот выключен');
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Клуб', web_app: { url: BASE } } });
  let off = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset: off, timeout: 30 });
      for (const up of r.result || []) {
        off = up.update_id + 1;
        const m = up.message; if (!m) continue;
        if (!ALLOWED.includes(String(m.from.id))) { await tg('sendMessage', { chat_id: m.chat.id, text: 'Нет доступа. Ваш ID: ' + m.from.id }); continue; }
        await tg('sendMessage', { chat_id: m.chat.id, text: 'Учёт клуба', reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: BASE } }]] } });
      }
    } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
  }
}
bot();
