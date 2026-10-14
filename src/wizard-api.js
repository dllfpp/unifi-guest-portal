'use strict';
// Chiamate del wizard verso il controller UniFi e Telegram, con i valori ancora da salvare.
// Ogni errore ha un `codice` che il wizard traduce in un messaggio per l'utente.
const { accedi, apiCon } = require('./unifi');

const errore = (codice, dettaglio = '') => Object.assign(new Error(`${codice}: ${dettaglio}`), { codice, dettaglio });

// "192.168.1.10:8443" → "https://192.168.1.10:8443" (senza percorso né barra finale).
function normUrl(testo) {
  let t = String(testo || '').trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  try { const u = new URL(t); return `${u.protocol}//${u.host}`; } catch { return ''; }
}

// ---- Controller ----
// Login con le credenziali digitate: riconosce UniFi OS o controller classico e legge la versione.
async function accediController(url, utente, password) {
  let s;
  try { s = await accedi(url, utente, password); } catch (e) {
    if (e.codice) throw errore(e.codice, e.message);
    throw errore('irraggiungibile', e.code || e.message);
  }
  const r = await apiCon(s, 'GET', '/status').catch(() => null);
  return { sessione: s, versione: r?.json?.meta?.server_version || '' };
}

async function letturaApi(s, path) {
  const r = await apiCon(s, 'GET', path).catch(e => { throw errore('irraggiungibile', e.code || e.message); });
  if (r.json?.meta?.rc !== 'ok') throw errore('api', r.json?.meta?.msg || `HTTP ${r.status}`);
  return r.json.data || [];
}

// Siti visibili all'account: `id` è il nome breve usato negli URL (es. "default"), `nome` la descrizione.
async function siti(s) {
  return (await letturaApi(s, '/api/self/sites')).map(x => ({ id: x.name, nome: x.desc || x.name }));
}

// Reti Wi-Fi del sito, con la spunta "rete ospiti" (Hotspot) e la sicurezza.
async function ssidDelSito(s, sito) {
  return (await letturaApi(s, `/api/s/${sito}/rest/wlanconf`))
    .map(w => ({ nome: w.name, ospiti: Boolean(w.is_guest), aperta: w.security === 'open', attiva: w.enabled !== false }));
}

// ---- Telegram ----
const TG = () => process.env.TG_API_URL || 'https://api.telegram.org';

async function telegram(token, metodo, params = {}) {
  let j;
  try {
    const r = await fetch(`${TG()}/bot${token}/${metodo}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
    });
    j = await r.json();
  } catch (e) { throw errore('telegramIrraggiungibile', e.message); }
  if (!j.ok) throw errore(j.error_code === 409 ? 'conflitto' : 'telegram', j.description || String(j.error_code));
  return j.result;
}

async function bot(token) {
  if (!/^\d+:[\w-]{20,}$/.test(String(token || '').trim())) throw errore('formatoToken');
  const me = await telegram(token.trim(), 'getMe');
  // Un webhook attivo vuol dire che un altro programma (n8n, Home Assistant…) riceve già i messaggi del bot.
  const wh = await telegram(token.trim(), 'getWebhookInfo');
  if (wh?.url) { let host = wh.url; try { host = new URL(wh.url).host; } catch { /* url strano */ } throw errore('webhook', host); }
  return { username: me.username, nome: me.first_name };
}

// Chat e topic in cui qualcuno ha scritto di recente al bot. Non conferma gli aggiornamenti
// (nessun offset): restano disponibili per il portale.
async function chatRecenti(token) {
  const agg = await telegram(token, 'getUpdates', { timeout: 0, limit: 100, allowed_updates: ['message', 'my_chat_member'] });
  const trovate = new Map();
  for (const u of agg.reverse()) {
    const m = u.message || u.my_chat_member;
    if (!m?.chat) continue;
    const c = m.chat, privata = c.type === 'private';
    const thread = !privata && m.is_topic_message ? m.message_thread_id : 0;
    const chiave = `${c.id}:${thread}`;
    if (trovate.has(chiave)) continue;
    const nomePersona = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || '';
    trovate.set(chiave, {
      tipo: privata ? 'privata' : thread ? 'topic' : 'gruppo',
      chat: String(c.id), thread: thread ? String(thread) : '',
      titolo: privata ? nomePersona : c.title || '',
      topic: thread ? m.reply_to_message?.forum_topic_created?.name || m.forum_topic_created?.name || '' : '',
      admin: m.from && !m.from.is_bot ? String(m.from.id) : '',
      persona: nomePersona,
    });
  }
  return [...trovate.values()];
}

const inviaProva = (token, chat, thread, testo) => telegram(token, 'sendMessage', {
  chat_id: chat, text: testo, parse_mode: 'HTML', ...(thread ? { message_thread_id: Number(thread) } : {}),
});

module.exports = { normUrl, accediController, siti, ssidDelSito, bot, chatRecenti, inviaProva };
