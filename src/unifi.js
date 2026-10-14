'use strict';
// Controller UniFi Network: lettura dei client, autorizzazione e revoca degli ospiti.
// Due varianti, riconosciute da sole:
//  - UniFi OS (UDM, UCG, Cloud Key Gen2+, UniFi OS Server): login su /api/auth/login, poi
//    /proxy/network/api/... con l'header X-CSRF-Token ricevuto al login;
//  - controller "classico" (UniFi Network Application in Docker o su un PC): login su /api/login, poi /api/...
const http = require('http');
const https = require('https');

// Letta a ogni uso, non al caricamento: il wizard scrive la configurazione dopo che il modulo è già caricato.
const CFG = {
  get url() { return process.env.UNIFI_URL; }, // es. https://unifi.lan:8443 oppure https://192.168.1.1
  get user() { return process.env.UNIFI_USER; },
  get pass() { return process.env.UNIFI_PASS; },
  get site() { return process.env.UNIFI_SITE || 'default'; }, // nome breve del sito, quello che compare negli URL
};

// Chiamata a un controller qualsiasi (serve anche al wizard, prima che la configurazione esista).
// Il controller ha di solito un certificato autofirmato: lo si accetta, solo per queste chiamate.
function richiestaA(base, method, path, { headers = {}, body, cookie, timeout = 10000 } = {}) {
  const u = new URL(path, base);
  const dati = body === undefined ? null : JSON.stringify(body);
  const h = { Accept: 'application/json', ...headers };
  if (dati) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(dati); }
  if (cookie) h.Cookie = cookie;
  return new Promise((ok, ko) => {
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(u, { method, headers: h, rejectUnauthorized: false, timeout }, res => {
      let s = '';
      res.on('data', c => (s += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(s); } catch { /* risposta non JSON */ }
        ok({ status: res.statusCode, headers: res.headers, json });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout controller')));
    r.on('error', ko);
    if (dati) r.write(dati);
    r.end();
  });
}

const cookieDa = r => (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

// UniFi OS ha il prefisso /proxy/network; un controller classico risponde 404 a quel percorso.
async function variante(base) {
  const r = await richiestaA(base, 'GET', '/proxy/network/status');
  return r.status === 404 ? 'classico' : 'unifios';
}

// Login → { base, os, cookie, csrf }. Errori con `codice` leggibile dal wizard.
async function accedi(base, user, pass) {
  const os = (await variante(base)) === 'unifios';
  const r = await richiestaA(base, 'POST', os ? '/api/auth/login' : '/api/login', {
    body: os ? { username: user, password: pass, rememberMe: false } : { username: user, password: pass },
  });
  if (r.status === 401 || r.status === 400 || r.json?.meta?.rc === 'error') {
    const e = new Error(r.json?.meta?.msg || r.json?.message || `HTTP ${r.status}`);
    e.codice = /2fa|mfa|ubic_2fa/i.test(e.message) ? 'dueFattori' : 'credenziali';
    throw e;
  }
  if (r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.codice = 'nonUnifi'; throw e; }
  return { base, os, cookie: cookieDa(r), csrf: r.headers['x-csrf-token'] || r.headers['x-updated-csrf-token'] || '' };
}

// Chiamata all'API Network di un sito, con una sessione già aperta.
async function apiCon(s, method, path, body) {
  const headers = s.csrf ? { 'X-CSRF-Token': s.csrf } : {};
  const r = await richiestaA(s.base, method, (s.os ? '/proxy/network' : '') + path, { headers, cookie: s.cookie, body });
  const nuovo = r.headers['x-updated-csrf-token'];
  if (nuovo) s.csrf = nuovo;
  return r;
}

// ---- Sessione del portale (credenziali della configurazione), rinnovata quando scade ----
let sessione = null;
async function api(method, path, body) {
  for (let tentativo = 0; tentativo < 2; tentativo++) {
    if (!sessione) sessione = await accedi(CFG.url, CFG.user, CFG.pass);
    const r = await apiCon(sessione, method, path, body);
    if (r.status === 401 || r.json?.meta?.msg === 'api.err.LoginRequired') { sessione = null; continue; }
    if (r.json?.meta?.rc === 'ok') return r.json.data;
    const e = new Error(r.json?.meta?.msg || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  throw new Error('login rifiutato');
}

// Nel portale i MAC sono "AA-BB-CC-DD-EE-FF"; UniFi li vuole "aa:bb:cc:dd:ee:ff".
const macUnifi = mac => String(mac).toLowerCase().replace(/-/g, ':');

// Client collegato in questo momento: nome, produttore, sistema, AP e SSID. null se il controller non lo vede.
async function cliente(mac) {
  let c;
  try { [c] = await api('GET', `/api/s/${CFG.site}/stat/sta/${macUnifi(mac)}`); } catch (e) { if (/UnknownUser|UnknownStation/.test(e.message)) return null; throw e; }
  if (!c) return null;
  let apName = '';
  if (c.ap_mac) {
    try { apName = (await api('GET', `/api/s/${CFG.site}/stat/device-basic`)).find(d => d.mac === c.ap_mac)?.name || ''; } catch { /* nome AP facoltativo */ }
  }
  return {
    name: c.name || c.hostname || '', vendor: c.oui || '', osName: '',
    apName: apName || c.ap_mac || '', ssid: c.essid || '',
  };
}

// Autorizza il client per `ore` ore: UniFi vuole i minuti e risponde con la scadenza (`end`, in secondi).
async function autorizza(c, ore) {
  try {
    const [r] = await api('POST', `/api/s/${CFG.site}/cmd/stamgr`, {
      cmd: 'authorize-guest', mac: macUnifi(c.mac), minutes: Math.round(ore * 60), ...(c.apMac ? { ap_mac: macUnifi(c.apMac) } : {}),
    });
    return r?.end ? r.end * 1000 : Date.now() + ore * 3600000;
  } catch (e) { throw new Error('autorizzazione: ' + e.message); }
}

// Revoca: vale anche per un dispositivo scollegato (l'autorizzazione resta legata al MAC).
async function revoca(mac) {
  try { await api('POST', `/api/s/${CFG.site}/cmd/stamgr`, { cmd: 'unauthorize-guest', mac: macUnifi(mac) }); }
  catch (e) { throw new Error('revoca: ' + e.message); }
  // Le connessioni già aperte (per esempio una VPN in UDP) possono sopravvivere alla revoca: si sgancia il
  // client dal Wi-Fi, che si ricollega e trova il portale. Se non è collegato il controller dà errore: va bene.
  try { await api('POST', `/api/s/${CFG.site}/cmd/stamgr`, { cmd: 'kick-sta', mac: macUnifi(mac) }); } catch { /* non collegato */ }
}

module.exports = { cliente, autorizza, revoca, richiestaA, accedi, apiCon, variante, macUnifi, CFG };
