'use strict';
/**
 * axes_server.js — Axes.io netcode PoC, oda / davet / takim sunucusu.
 *
 * Sorumluluklar
 *  - Oda yasam dongusu: olustur (davet kodu uret), kod ile katil, ayril
 *  - Takim atamasi (auto-balance veya host elle) + "ayni takimda oynama"
 *  - Oyuncu girdilerini (input) 20 Hz snapshot olarak yayinlama
 *  - Sunucu tarafi bot simulasyonu (dummy entity akisi)
 *  - Davet / cagri (call) bildirimleri
 *
 * Protokol
 *  kontrol duzlemi : JSON  { t: '...', ... }
 *  sicak yol       : binary (aşağıdaki codec)
 *
 * Binary INPUT    (C->S): [u8 0x01][u32 netId][u32 seq][f32 mx][f32 my][f32 rx][f32 ry][u8 fire] = 26 B
 * Binary SNAPSHOT (S->C): [u8 0x02][u16 tick][u32 n]  { [u32 netId][f32 x][f32 y][f32 z][f32 ry][u8 flags] } = 7 + 21n
 *
 * mx,my = PlayerInput.Move   (yurume girdisi)
 * rx,ry = PlayerInput.Rotation (nisan alma girdisi)
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const PORT           = Number(process.env.PORT || 9000);
const TICK_MS        = 50;      // 20 Hz snapshot
const CLIENT_TIMEOUT = 4000;    // ms — bu sureden uzun sessizlik = kopuk
const MAX_PLAYERS    = 8;
const BOTS_PER_ROOM  = 4;       // sunucu tarafi dummy bot sayisi

/* ---------------- opcode / bayrak ---------------- */
const OP_INPUT    = 0x01;
const OP_SNAPSHOT = 0x02;

const F_FIRE = 1 << 0;
const F_BOT  = 1 << 1;

/* ---------------- davet kodu ---------------- */
// Karisik harfler (I, O, 0, 1) cikarildi — telefonla okunup yazilabilsin.
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () =>
  Array.from(crypto.randomBytes(6), b => ALPHA[b % ALPHA.length]).join('');

/* ---------------- binary codec ---------------- */
function decodeInput(b) {
  if (b.length < 26 || b[0] !== OP_INPUT) return null;
  return {
    netId: b.readUInt32LE(1),
    seq:   b.readUInt32LE(5),
    mx:    b.readFloatLE(9),
    my:    b.readFloatLE(13),
    rx:    b.readFloatLE(17),
    ry:    b.readFloatLE(21),
    fire:  b.readUInt8(25) !== 0,
  };
}

function encodeSnapshot(tick, ents) {
  const b = Buffer.allocUnsafe(7 + ents.length * 21);
  b.writeUInt8(OP_SNAPSHOT, 0);
  b.writeUInt16LE(tick & 0xffff, 1);
  b.writeUInt32LE(ents.length, 3);
  let o = 7;
  for (const e of ents) {
    b.writeUInt32LE(e.netId >>> 0, o);
    b.writeFloatLE(e.x, o + 4);
    b.writeFloatLE(e.y, o + 8);
    b.writeFloatLE(e.z, o + 12);
    b.writeFloatLE(e.ry, o + 16);
    b.writeUInt8(e.flags, o + 20);
    o += 21;
  }
  return b;
}

/* ---------------- oda ---------------- */
class Room {
  constructor(code, opts = {}) {
    this.code        = code;
    this.mode        = opts.mode === 'ffa' ? 'ffa' : 'team';   // 'team' | 'ffa'
    this.maxPlayers  = Math.min(opts.maxPlayers || 4, MAX_PLAYERS);
    this.players     = new Map();   // netId -> player
    this.bots        = new Map();   // netId -> bot
    this.started     = false;
    this.tick        = 0;
    this.nextNet     = 1;
    this.nextBotNet  = 10000;
    this.createdAt   = Date.now();
  }

  get hostId() {
    let best = -1;
    for (const id of this.players.keys()) if (best < 0 || id < best) best = id;
    return best;
  }

  /* ---- takim atama ----
   * 1) Oyuncunun "team" tercihi (a/b) varsa ona yaz.
   * 2) Kalanlar A/B/A/B seklinde dengelenir (auto-balance).
   * Boylece "ayni takimda oynayalim" istegi tek komutla karsilanir.
   */
  assignTeams() {
    if (this.mode === 'ffa') {
      for (const p of this.players.values()) p.team = 0;
      return;
    }
    const ids = [...this.players.keys()].sort((a, b) => a - b);
    const count = [0, 0];
    for (const id of ids) {
      const p = this.players.get(id);
      if (p.pref === 0 || p.pref === 1) { p.team = p.pref; count[p.team]++; }
      else p.team = -1;
    }
    for (const id of ids) {
      const p = this.players.get(id);
      if (p.team !== -1) continue;
      p.team = count[0] <= count[1] ? 0 : 1;
      count[p.team]++;
    }
  }

  playerList() {
    return [...this.players.values()].map(p => ({
      netId: p.netId, name: p.name, team: p.team, ready: p.ready,
    }));
  }

  entityList() {
    const list = this.playerList().map(p => {
      const st = this.players.get(p.netId).st;
      return {
        netId: p.netId, name: p.name, team: p.team, isBot: false,
        x: st.x, y: st.y, z: st.z, ry: st.ry,     // proxy'nin dogacagi nokta
      };
    });
    for (const b of this.bots.values())
      list.push({ netId: b.netId, name: b.name, team: b.team, isBot: true, x: b.x, y: b.y, z: b.z, ry: b.ry });
    return list;
  }

  send(p, obj) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj));
  }

  broadcast(obj, exceptNetId = -1) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values())
      if (p.netId !== exceptNetId && p.ws.readyState === 1) p.ws.send(s);
  }

  /* ---- katilma ---- */
  join(ws, name, prefTeam) {
    const netId = this.nextNet++;
    // prefTeam: 'a' | 'b' | undefined  -> kullanici ayni takimda kalmak istiyorsa
    const pref = prefTeam === 'a' ? 0 : prefTeam === 'b' ? 1 : -1;
    const p = {
      netId, ws,
      name: String(name || 'player').slice(0, 12),
      team: 0, pref, ready: false,
      lastSeen: Date.now(),
      st: { mx: 0, my: 0, rx: 0, ry: 0, fire: false, x: 0, y: 0, z: 0 },
    };
    this.players.set(netId, p);
    this.assignTeams();

    // Yeni oyuncuya mevcut durumu gonder
    this.send(p, {
      t: 'joined', code: this.code, netId, hostId: this.hostId,
      mode: this.mode, started: this.started,
      players: this.playerList(),
    });

    // Mevcut oyunculara duyur
    this.broadcast({ t: 'player_join', netId, name: p.name, team: p.team }, netId);
    this.broadcast({ t: 'teams', players: this.playerList() });
    return p;
  }

  leave(netId) {
    const p = this.players.get(netId);
    if (!p) return;
    this.players.delete(netId);
    this.assignTeams();
    this.broadcast({ t: 'player_leave', netId });
    this.broadcast({ t: 'teams', players: this.playerList() });
    if (this.players.size === 0) rooms.delete(this.code);
  }

  /* ---- mac baslat: proxy'lerin dogmasi icin entity listesi yayinla ---- */
  start() {
    this.started = true;
    this.spawnServerBots();
    // Her istemciye, kimin proxy'sini doguracagini soyle (kendisi haric)
    for (const p of this.players.values()) {
      const others = this.entityList().filter(e => e.netId !== p.netId);
      this.send(p, {
        t: 'match_start',
        tickHz: Math.round(1000 / TICK_MS),
        mode: this.mode,
        friendlyFire: this.mode === 'team' ? false : true,
        entities: others,
      });
    }
  }

  /* ---- sunucu tarafi bot simulasyonu ---- */
  spawnServerBots(n = BOTS_PER_ROOM) {
    for (let i = 0; i < n; i++) {
      const netId = this.nextBotNet++;
      const team  = this.mode === 'team' ? (i % 2) : 0;
      this.bots.set(netId, {
        netId, name: `BOT_${netId % 1000}`, team,
        x: (Math.random() - 0.5) * 40,
        z: (Math.random() - 0.5) * 40,
        y: 0, ry: 0,
        phase: Math.random() * Math.PI * 2,
      });
      this.broadcast({ t: 'spawn', netId, name: `BOT_${netId % 1000}`, team, isBot: true });
    }
  }

  stepBots(dt) {
    for (const b of this.bots.values()) {
      b.phase += 0.7 * dt;                       // dairesel devriye
      b.x += Math.cos(b.phase) * 3.5 * dt;
      b.z += Math.sin(b.phase) * 3.5 * dt;
      b.ry = (b.phase * 180 / Math.PI) % 360;
    }
  }

  /* ---- tick ---- */
  step(dt) {
    this.tick++;
    this.stepBots(dt);

    const now = Date.now();
    for (const [id, p] of [...this.players])
      if (now - p.lastSeen > CLIENT_TIMEOUT) { p.ws.terminate(); this.leave(id); }

    const ents = [];
    for (const p of this.players.values())
      ents.push({
        netId: p.netId, x: p.st.x, y: p.st.y, z: p.st.z, ry: p.st.ry,
        flags: p.st.fire ? F_FIRE : 0,
      });
    for (const b of this.bots.values())
      ents.push({ netId: b.netId, x: b.x, y: b.y, z: b.z, ry: b.ry, flags: F_BOT });

    const frame = encodeSnapshot(this.tick, ents);

    // Proxy'ler icin asil tasiyici: girdi relay'i.
    // Konum yerine "niyeti" yayinliyoruz; uzak tarafta karakterin kendi
    // fizigi/carpismasi/silahi calistigi icin bu cok daha stabil.
    let inputMsg = null;
    if (this.started && this.players.size > 1) {
      inputMsg = JSON.stringify({
        t: 'input',
        list: [...this.players.values()].map(p => ({
          netId: p.netId, mx: p.st.mx, my: p.st.my,
          rx: p.st.rx, ry: p.st.ry, fire: p.st.fire ? 1 : 0,
        })),
      });
    }

    for (const p of this.players.values()) {
      if (p.ws.readyState !== 1) continue;
      if (p.ws.bufferedAmount > 64 * 1024) continue;       // backpressure: yavas istemciyi atla
      if (inputMsg) p.ws.send(inputMsg);
      p.ws.send(frame, { binary: true });
    }
  }
}

/* ---------------- sunucu ---------------- */
const rooms = new Map();          // code -> Room
const byWs  = new Map();          // ws -> { room, netId }

function findRoom(code) {
  return rooms.get(String(code || '').toUpperCase().trim());
}

/* ---------------- arkadas sistemi ----------------
 * Kalici kimlik: istemci kendi uid'sini uretir (cihazda saklanir) ve
 * baglaninca "hello" ile bildirir. Arkadas iliskileri kalici olarak tutulur:
 * REDIS_URL tanimliysa Redis'te, degilse yerel friends.json'da.
 * PoC oldugu icin arkadaslik karsilikli ve otomatik kabul edilir.
 */
const STORE_FILE = path.join(__dirname, 'friends.json');
const REDIS_KEY  = 'axes:accounts';
const accounts   = new Map();   // uid -> { uid, name, friends:Set<uid>, ws, code, netId }
const uidByWs    = new Map();   // ws  -> uid

let redis = null;               // REDIS_URL verilirse dolu olur

/* Kalici depo: REDIS_URL varsa Redis (Upstash vb.), yoksa yerel friends.json.
 * Render'in ucretsiz diski gecici oldugu icin kalicilik Redis ile saglanir. */
function loadStoreFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    applyStore(raw);
    console.log(`[arkadas] ${accounts.size} hesap yuklendi (${STORE_FILE})`);
  } catch { /* ilk calistirma — kayit yok */ }
}

function applyStore(raw) {
  for (const [uid, a] of Object.entries(raw || {})) {
    const old = accounts.get(uid);
    accounts.set(uid, {
      uid, name: a.name || uid,
      friends: new Set(a.friends || []),
      ws: old ? old.ws : null, code: old ? old.code : null, netId: old ? old.netId : -1,
    });
  }
}

function snapshot() {
  const out = {};
  for (const a of accounts.values()) out[a.uid] = { name: a.name, friends: [...a.friends] };
  return out;
}

async function initStore() {
  const url = process.env.REDIS_URL;
  if (!url) { loadStoreFile(); return; }
  try {
    const { createClient } = require('redis');
    const client = createClient({
      url,
      // Sinirli yeniden deneme: Redis yoksa acilista sonsuza kadar takilmasin.
      socket: { reconnectStrategy: n => (n > 8 ? false : Math.min(n * 250, 2000)) },
    });
    client.on('error', e => console.error('[redis] ' + e.message));
    await client.connect();
    redis = client;
    const raw = await client.get(REDIS_KEY);
    if (raw) applyStore(JSON.parse(raw));
    console.log(`[redis] bagli — ${accounts.size} hesap yuklendi`);
  } catch (e) {
    console.error('[redis] baglanamadi (' + e.message + ') — dosya moduna donuluyor');
    try { if (redis) await redis.disconnect(); } catch { /* yoksay */ }
    redis = null;
    loadStoreFile();
  }
}

async function persist() {
  const out = snapshot();
  if (redis) {
    try { await redis.set(REDIS_KEY, JSON.stringify(out)); }
    catch (e) { console.error('[redis] yazilamadi: ' + e.message); }
    return;
  }
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(out, null, 2)); }
  catch (e) { console.error('[arkadas] kaydedilemedi: ' + e.message); }
}

function account(uid, name) {
  uid = String(uid || '').trim();
  if (!uid) return null;
  let a = accounts.get(uid);
  if (!a) {
    a = { uid, name: name || uid, friends: new Set(), ws: null, code: null, netId: -1 };
    accounts.set(uid, a);
  }
  if (name) a.name = String(name).slice(0, 16);
  return a;
}

const isOnline = a => !!(a && a.ws && a.ws.readyState === 1);

function pubFriend(fid) {
  const f = accounts.get(fid);
  if (!f) return { uid: fid, name: fid, online: false, code: null };
  return { uid: f.uid, name: f.name, online: isOnline(f), code: isOnline(f) ? f.code : null };
}

function friendList(uid) {
  const a = accounts.get(uid);
  return a ? [...a.friends].map(pubFriend) : [];
}

function sendUid(uid, obj) {
  const a = accounts.get(uid);
  if (isOnline(a)) a.ws.send(JSON.stringify(obj));
}

function notifyFriends(uid, obj) {
  const a = accounts.get(uid);
  if (!a) return;
  for (const fid of a.friends) sendUid(fid, obj);
}

function findByUid(uid) {
  return accounts.get(String(uid || '').trim()) || null;
}

function findByName(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return null;
  for (const a of accounts.values()) if (a.name.toLowerCase() === n) return a;
  return null;
}

/* Odaya giren istemcinin hesabini isaretle ve arkadaslarina haber ver. */
function markRoom(ws, code, netId) {
  const a = accounts.get(uidByWs.get(ws));
  if (!a) return;
  a.code = code;
  a.netId = netId;
  notifyFriends(a.uid, { t: 'friend_status', uid: a.uid, name: a.name, online: true, code });
}

/* HTTP + WebSocket ayni portta.
 * Render gibi bulut platformlari servisi "ayakta mi" diye HTTP ile yoklar;
 * WebSocket yukseltmesi de ayni port uzerinden yapilir.
 *  /        -> saglik metni (Render healthCheckPath)
 *  /lobby   -> telefondan acilan lobi arayuzu (public/lobby.html)
 */
const PUBLIC_DIR = path.join(__dirname, 'public');

function serveLobby(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'lobby.html'), (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('lobby.html bulunamadi');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const httpServer = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/lobby' || url === '/oyna') return serveLobby(res);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`axes-net ok  |  oda: ${rooms.size}  |  hesap: ${accounts.size}\n`);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  ws.binaryType = 'nodebuffer';

  ws.on('message', (data, isBinary) => {
    const ctx = byWs.get(ws);

    /* ---- sicak yol: girdi ---- */
    if (isBinary) {
      if (!ctx) return;
      const inp = decodeInput(data);
      if (!inp || inp.netId !== ctx.netId) return;         // sahte netId'yi yoksay
      const p = ctx.room.players.get(ctx.netId);
      if (!p) return;
      p.lastSeen = Date.now();
      Object.assign(p.st, { mx: inp.mx, my: inp.my, rx: inp.rx, ry: inp.ry, fire: inp.fire });
      // Konum, girdiden basit bir olu integrasyonla turetilir (istemci fizigi asil kaynaktir;
      // gercek konum 5 Hz'de ayrica 'pos' mesaji ile duzeltilir).
      p.st.x += inp.mx * 0.25;
      p.st.z += inp.my * 0.25;
      return;
    }

    /* ---- kontrol duzlemi ---- */
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'create': {
        if (ctx) return;
        let code = newCode();
        while (rooms.has(code)) code = newCode();
        const room = new Room(code, m);
        rooms.set(code, room);
        const p = room.join(ws, m.name, m.team);
        byWs.set(ws, { room, netId: p.netId });
        markRoom(ws, room.code, p.netId);
        console.log(`[oda] ${code} olusturuldu (${room.mode}, max ${room.maxPlayers})`);
        break;
      }
      case 'join': {
        if (ctx) return;
        const room = findRoom(m.code);
        if (!room) return ws.send(JSON.stringify({ t: 'error', msg: 'Oda bulunamadi' }));
        if (room.players.size >= room.maxPlayers)
          return ws.send(JSON.stringify({ t: 'error', msg: 'Oda dolu' }));
        const p = room.join(ws, m.name, m.team);
        byWs.set(ws, { room, netId: p.netId });
        markRoom(ws, room.code, p.netId);
        console.log(`[oda] ${room.code} <- ${p.name} (#${p.netId})`);
        break;
      }
      case 'leave': {                                 // odadan ayril (baglanti acik kalir)
        if (!ctx) return;
        byWs.delete(ws);
        ctx.room.leave(ctx.netId);
        const acc = accounts.get(uidByWs.get(ws));
        if (acc) { acc.code = null; acc.netId = -1; notifyFriends(acc.uid, { t: 'friend_status', uid: acc.uid, name: acc.name, online: true, code: null }); }
        ws.send(JSON.stringify({ t: 'left' }));
        break;
      }
      case 'ready': {
        if (!ctx) return;
        const p = ctx.room.players.get(ctx.netId);
        if (!p) return;
        p.ready = !!m.ready;
        ctx.room.broadcast({ t: 'teams', players: ctx.room.playerList() });
        break;
      }
      case 'team': {                                  // host: elle takim ata
        if (!ctx || ctx.room.hostId !== ctx.netId) return;
        const target = ctx.room.players.get(m.netId | 0);
        if (!target) return;
        target.team = m.team ? 1 : 0;
        target.pref = target.team;                  // tercihi sabitle (yeniden dengelenmesin)
        ctx.room.broadcast({ t: 'teams', players: ctx.room.playerList() });
        break;
      }
      case 'mode': {                                  // host: ffa <-> team
        if (!ctx || ctx.room.hostId !== ctx.netId) return;
        ctx.room.mode = m.mode === 'ffa' ? 'ffa' : 'team';
        ctx.room.assignTeams();
        ctx.room.broadcast({ t: 'mode', mode: ctx.room.mode });
        ctx.room.broadcast({ t: 'teams', players: ctx.room.playerList() });
        break;
      }
      case 'start': {                                 // host: proxy'leri dogur
        if (!ctx || ctx.room.hostId !== ctx.netId) return;
        ctx.room.start();
        ctx.room.broadcast({ t: 'started' });
        console.log(`[oda] ${ctx.room.code} mac basladi (${ctx.room.entityList().length} entity)`);
        break;
      }
      case 'call': {                                  // davet / cagri: "X seni cagiriyor"
        if (!ctx) return;
        const from = ctx.room.players.get(ctx.netId);
        if (!from) return;
        const to = ctx.room.players.get(m.to | 0);
        if (to) ctx.room.send(to, { t: 'called', from: from.name, fromNetId: from.netId, msg: m.msg || 'Seni cagiriyor!' });
        break;
      }
      case 'broadcast_call': {                        // odadaki herkese cagri
        if (!ctx) return;
        const from = ctx.room.players.get(ctx.netId);
        if (!from) return;
        ctx.room.broadcast(
          { t: 'called', from: from.name, fromNetId: from.netId, msg: m.msg || 'Gel buraya!' },
          from.netId,
        );
        break;
      }
      case 'pos': {                                   // seyrek mutlak konum duzeltmesi (5 Hz)
        if (!ctx) return;
        const p = ctx.room.players.get(ctx.netId);
        if (!p) return;
        p.lastSeen = Date.now();
        Object.assign(p.st, { x: m.x, y: m.y || 0, z: m.z });
        if (typeof m.ry === 'number') p.st.ry = m.ry;
        // Yeni gelen oyuncuya bu oyuncunun canli konumunu bildir (proxy dogru yere dogsun)
        ctx.room.broadcast(
          { t: 'entity_pos', netId: p.netId, x: p.st.x, y: p.st.y, z: p.st.z, ry: p.st.ry },
          p.netId,
        );
        break;
      }
      /* ---- arkadas: kimlik kaydi ---- */
      case 'hello': {
        const a = account(m.uid, m.name);
        if (!a) return ws.send(JSON.stringify({ t: 'error', msg: 'uid gerekli' }));
        if (a.ws && a.ws !== ws && a.ws.readyState === 1) { try { a.ws.close(); } catch {} }
        a.ws = ws;
        uidByWs.set(ws, a.uid);
        ws.send(JSON.stringify({ t: 'hello_ok', uid: a.uid, name: a.name, friends: friendList(a.uid) }));
        notifyFriends(a.uid, { t: 'friend_status', uid: a.uid, name: a.name, online: true, code: a.code });
        console.log(`[arkadas] ${a.name} (${a.uid}) baglandi — ${a.friends.size} arkadas`);
        break;
      }
      /* ---- arkadas ekle (uid veya isimle) ---- */
      case 'friend_add': {
        const a = accounts.get(uidByWs.get(ws));
        if (!a) return ws.send(JSON.stringify({ t: 'error', msg: 'once hello gonder' }));
        const f = m.uid ? findByUid(m.uid) : findByName(m.name);
        if (!f || f.uid === a.uid) return ws.send(JSON.stringify({ t: 'error', msg: 'Arkadas bulunamadi' }));
        a.friends.add(f.uid);
        f.friends.add(a.uid);                     // PoC: karsilikli otomatik kabul
        persist();
        ws.send(JSON.stringify({ t: 'friend_list', friends: friendList(a.uid) }));
        sendUid(f.uid, { t: 'friend_list', friends: friendList(f.uid) });
        console.log(`[arkadas] ${a.name} <-> ${f.name}`);
        break;
      }
      /* ---- arkadas cikar ---- */
      case 'friend_remove': {
        const a = accounts.get(uidByWs.get(ws));
        if (!a) return;
        const f = m.uid ? findByUid(m.uid) : findByName(m.name);
        if (!f) return ws.send(JSON.stringify({ t: 'error', msg: 'Arkadas bulunamadi' }));
        a.friends.delete(f.uid);
        f.friends.delete(a.uid);
        persist();
        ws.send(JSON.stringify({ t: 'friend_list', friends: friendList(a.uid) }));
        sendUid(f.uid, { t: 'friend_list', friends: friendList(f.uid) });
        break;
      }
      /* ---- arkadas listesi ---- */
      case 'friend_list': {
        const a = accounts.get(uidByWs.get(ws));
        if (!a) return;
        ws.send(JSON.stringify({ t: 'friend_list', friends: friendList(a.uid) }));
        break;
      }
      /* ---- arkadasi odama davet et (odada olmam sart) ---- */
      case 'invite': {
        const a = accounts.get(uidByWs.get(ws));
        const f = findByUid(m.uid) || findByName(m.name);
        if (!a || !f) return ws.send(JSON.stringify({ t: 'error', msg: 'Arkadas bulunamadi' }));
        if (!a.code) return ws.send(JSON.stringify({ t: 'error', msg: 'Once oda kur veya katil' }));
        sendUid(f.uid, {
          t: 'invited', fromUid: a.uid, from: a.name, code: a.code,
          msg: m.msg || `${a.name} seni odasina davet ediyor`,
        });
        ws.send(JSON.stringify({ t: 'invite_sent', uid: f.uid, code: a.code }));
        console.log(`[arkadas] ${a.name} -> ${f.name} davet (${a.code})`);
        break;
      }
      /* ---- arkadasin odasina katil ---- */
      case 'join_friend': {
        const f = findByUid(m.uid) || findByName(m.name);
        if (!f) return ws.send(JSON.stringify({ t: 'error', msg: 'Arkadas bulunamadi' }));
        if (!isOnline(f) || !f.code)
          return ws.send(JSON.stringify({ t: 'error', msg: 'Arkadas su an odada degil' }));
        ws.send(JSON.stringify({ t: 'friend_room', uid: f.uid, name: f.name, code: f.code }));
        break;
      }
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', ts: Date.now() }));
        break;
    }
  });

  ws.on('close', () => {
    /* hesabi cevrimdisi say ve arkadaslarina haber ver */
    const uid = uidByWs.get(ws);
    if (uid) {
      const a = accounts.get(uid);
      if (a && a.ws === ws) {
        a.ws = null; a.code = null; a.netId = -1;
        notifyFriends(uid, { t: 'friend_status', uid, name: a.name, online: false, code: null });
      }
      uidByWs.delete(ws);
    }

    const ctx = byWs.get(ws);
    if (!ctx) return;
    byWs.delete(ws);
    ctx.room.leave(ctx.netId);
    console.log(`[oda] ${ctx.room.code} -> #${ctx.netId} ayrildi`);
  });

  ws.on('error', () => {});
});

/* ---------------- tek tick dongusu ---------------- */
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  for (const room of [...rooms.values()]) room.step(dt);
}, TICK_MS);

initStore().finally(() => {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[axes] sunucu hazir -> ws://0.0.0.0:${PORT}`);
  });
});
