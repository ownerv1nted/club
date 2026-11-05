// Без зависимостей. Node 18+.
// Переменные: BOT_TOKEN, BASE_URL, ALLOWED_IDS (через запятую). Необязательно: OWNER_ID, DATA_FILE, PORT.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const TOKEN = process.env.BOT_TOKEN, BASE = process.env.BASE_URL, PORT = process.env.PORT || 3000;
const ALLOWED = (process.env.ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const OWNER = process.env.OWNER_ID || ALLOWED[0];
const DEV = process.env.DEV === '1';
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let DB = {}, dirty = false, timer = null, backupMsg = null;
try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const empty = () => !Object.values(DB).some(c => Object.keys(c || {}).length);

const API = m => `https://api.telegram.org/bot${TOKEN}/${m}`;
const tg = (m, b) => fetch(API(m), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => ({ ok: false }));
const tgForm = (m, fd) => fetch(API(m), { method: 'POST', body: fd }).then(r => r.json()).catch(() => ({ ok: false }));

// --- Резервная копия в Telegram: файл в закреплённом сообщении личного чата с ботом ---
const persist = () => {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(DB)); fs.renameSync(FILE + '.tmp', FILE);
  dirty = true; if (!timer) timer = setTimeout(() => { timer = null; backup(); }, 30000);
};
async function backup() {
  if (!TOKEN || !OWNER || !dirty) return;
  dirty = false;
  const json = JSON.stringify(DB), cap = 'Резервная копия ' + new Date().toISOString();
  const blob = () => new Blob([json], { type: 'application/json' });
  if (backupMsg) {
    const fd = new FormData();
    fd.append('chat_id', OWNER); fd.append('message_id', backupMsg);
    fd.append('media', JSON.stringify({ type: 'document', media: 'attach://f', caption: cap }));
    fd.append('f', blob(), 'club-backup.json');
    if ((await tgForm('editMessageMedia', fd)).ok) return;
  }
  const fd = new FormData();
  fd.append('chat_id', OWNER); fd.append('caption', cap); fd.append('disable_notification', 'true');
  fd.append('document', blob(), 'club-backup.json');
  const r = await tgForm('sendDocument', fd);
  if (r.ok) { backupMsg = r.result.message_id; await tg('pinChatMessage', { chat_id: OWNER, message_id: backupMsg, disable_notification: true }); }
  else { dirty = true; console.log('Не удалось сделать копию:', r.description); }
}
async function restore() {
  if (!TOKEN || !OWNER) return;
  const c = await tg('getChat', { chat_id: OWNER }), pm = c.result && c.result.pinned_message;
  if (!pm || !pm.document) return console.log('Резервной копии в Telegram нет');
  backupMsg = pm.message_id;
  if (!empty()) return;
  const f = await tg('getFile', { file_id: pm.document.file_id });
  if (!f.ok) return console.log('getFile:', f.description);
  DB = JSON.parse(await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`).then(r => r.text()));
  fs.writeFileSync(FILE, JSON.stringify(DB)); console.log('Данные восстановлены из Telegram');
}
process.on('SIGTERM', async () => { await Promise.race([backup(), new Promise(r => setTimeout(r, 8000))]); process.exit(0); });

function authed(initData) {
  if (DEV) return true;
  if (!initData || !TOKEN) return false;
  const p = new URLSearchParams(initData), hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  if (crypto.createHmac('sha256', secret).update(str).digest('hex') !== hash) return false;
  try { return ALLOWED.includes(String(JSON.parse(p.get('user')).id)); } catch (e) { return false; }
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/api/')) {
    const f = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(fs.existsSync);
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(f));
  }
  if (!authed(req.headers['x-init'])) { res.statusCode = 403; return res.end('{"error":"forbidden"}'); }
  const [, , col, id] = u.pathname.split('/');
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json'); DB[col] = DB[col] || {};
    if (req.method === 'GET') return res.end(JSON.stringify(DB[col]));
    if (!id) { res.statusCode = 400; return res.end('{}'); }
    const d = body ? JSON.parse(body) : {};
    if (req.method === 'PUT') DB[col][id] = d;
    else if (req.method === 'PATCH') DB[col][id] = { ...(DB[col][id] || {}), ...d };
    else if (req.method === 'DELETE') delete DB[col][id];
    persist(); res.end('{"ok":true}');
  });
});
async function bot() {
  if (!TOKEN) return console.log('BOT_TOKEN не задан — бот выключен');
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Клуб', web_app: { url: BASE } } });
  let off = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset: off, timeout: 30 });
      for (const up of r.result || []) {
        off = up.update_id + 1; const m = up.message; if (!m) continue;
        if (!ALLOWED.includes(String(m.from.id))) { await tg('sendMessage', { chat_id: m.chat.id, text: 'Нет доступа. Ваш ID: ' + m.from.id }); continue; }
        if (m.text === '/backup') { const fd = new FormData(); fd.append('chat_id', m.chat.id); fd.append('document', new Blob([JSON.stringify(DB)]), 'club-backup.json'); await tgForm('sendDocument', fd); continue; }
        await tg('sendMessage', { chat_id: m.chat.id, text: 'Учёт клуба', reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: BASE } }]] } });
      }
    } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
  }
}
(async () => {
  await Promise.race([restore().catch(e => console.log('restore:', e.message)), new Promise(r => setTimeout(r, 10000))]);
  server.listen(PORT, () => console.log('Сервер на порту', PORT)); bot();
})();
