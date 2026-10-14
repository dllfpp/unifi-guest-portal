'use strict';
// Controller UniFi e Telegram finti per i test del wizard e dell'avvio.
const http = require('http');
const assert = require('node:assert');

const json = (res, x) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
const leggi = req => new Promise(ok => { let s = ''; req.on('data', c => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });

// ---- Controller finto (UniFi Network "classico": /api/login, cookie unifises) ----
const ACCOUNT = { username: 'portal', password: 'segreto' };
const unifi = http.createServer(async (req, res) => {
  const u = req.url, b = await leggi(req);
  if (u === '/proxy/network/status') { res.writeHead(404); return res.end(); }
  if (u === '/status') return json(res, { meta: { rc: 'ok', up: true, server_version: '10.0.0' }, data: [] });
  if (u === '/api/login' && req.method === 'POST') {
    if (b.username !== ACCOUNT.username || b.password !== ACCOUNT.password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ meta: { rc: 'error', msg: 'api.err.Invalid' }, data: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'unifises=S1; Path=/; HttpOnly' });
    return res.end(JSON.stringify({ meta: { rc: 'ok' }, data: [] }));
  }
  if (u.startsWith('/api/')) {
    if (!String(req.headers.cookie || '').includes('unifises=S1')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ meta: { rc: 'error', msg: 'api.err.LoginRequired' }, data: [] }));
    }
    if (u === '/api/self/sites') return json(res, { meta: { rc: 'ok' }, data: [{ name: 'default', desc: 'Home' }] });
    if (u === '/api/s/default/rest/wlanconf') {
      return json(res, { meta: { rc: 'ok' }, data: [{ name: 'HOME', is_guest: false, security: 'wpapsk', enabled: true }, { name: 'GUEST-WIFI', is_guest: true, security: 'open', enabled: true }] });
    }
  }
  res.writeHead(404); res.end();
});

// ---- Telegram finto ----
const TOKEN = '123456:AAbbccddeeffgghhiijjkkll';
const TOKEN_WEBHOOK = '654321:ZZyyxxwwvvuuttssrrqqpp';
const inviati = [];
const telegram = http.createServer(async (req, res) => {
  const [, bot, metodo] = req.url.split('/');
  const b = await leggi(req);
  if (bot === 'bot' + TOKEN_WEBHOOK) {
    return json(res, metodo === 'getMe' ? { ok: true, result: { username: 'shared_bot' } } : { ok: true, result: { url: 'https://n8n.example.org/webhook/abc' } });
  }
  if (bot !== 'bot' + TOKEN) return json(res, { ok: false, error_code: 401, description: 'Unauthorized' });
  if (metodo === 'getWebhookInfo') return json(res, { ok: true, result: { url: '' } });
  if (metodo === 'getMe') return json(res, { ok: true, result: { username: 'demo_portal_bot', first_name: 'Demo' } });
  if (metodo === 'getUpdates') {
    return json(res, { ok: true, result: [
      { update_id: 1, message: { chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Owner' } } },
      { update_id: 2, message: { chat: { id: -100, type: 'supergroup', title: 'Family' }, from: { id: 42, first_name: 'Owner' }, is_topic_message: true, message_thread_id: 7, reply_to_message: { forum_topic_created: { name: 'Guest WiFi' } } } },
    ] });
  }
  if (metodo === 'sendMessage') { inviati.push(b); return json(res, { ok: true, result: { message_id: 1 } }); }
  json(res, { ok: false, error_code: 404, description: 'Not Found' });
});

module.exports = { unifi, telegram, ACCOUNT, inviati, TOKEN, TOKEN_WEBHOOK };
