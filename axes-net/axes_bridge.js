'use strict';
/**
 * axes_bridge.js — Frida ajanini oyuna enjekte eder ve WebSocket sunucusuna baglar.
 * =================================================================================
 *   [ Axes.io (Android) ]  <--Frida-->  [ axes_bridge.js ]  <--ws-->  [ axes_server.js ]
 *
 * Kullanim
 * --------
 *   Oda kur (host):
 *     node axes_bridge.js --pid 12345 --create --name Ali
 *
 *   Davet koduyla katil:
 *     node axes_bridge.js --pid 12345 --room ABC234 --name Veli --team a
 *
 *   Sadece listele (PID bulmak icin):
 *     frida-ps -Ua
 *
 * Bilgisayar ayni agda degilse:
 *     node axes_bridge.js --pid 12345 --server ws://192.168.1.20:9000 --create --name Ali
 *
 * Konsol komutlari (calisirken yazabilirsiniz)
 * -------------------------------------------
 *   davet                 oda kodunu goster
 *   kim                   odadaki oyuncular ve takimlar
 *   takim <netId> a|b     host: oyuncuyu takima yerlestir
 *   mod team|ffa          host: mod degistir
 *   basla                 host: maci baslat (proxy'ler dogar)
 *   cagir <netId> <mesaj> oyuncuyu cagir (karsida Toast cikar)
 *   herkes <mesaj>        odadaki herkese Toast
 *   dur                   aktarimi durdur
 *   q                     cikis
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const WebSocket = require('ws');

/* ---------------- kalici kimlik (uid) ----------------
 * Arkadas listesi isme degil uid'ye baglidir; ayni ismi secen iki kisi
 * cakismasin diye her isme bir kez rastgele uid uretilip uid.json'da saklanir.
 */
const UID_FILE = path.join(__dirname, 'uid.json');

function loadUid(name) {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(UID_FILE, 'utf8')); } catch { /* ilk calistirma */ }
  if (!map[name]) {
    map[name] = 'u' + crypto.randomBytes(6).toString('hex');
    try { fs.writeFileSync(UID_FILE, JSON.stringify(map, null, 2)); } catch (e) {}
  }
  return map[name];
}

/* ---------------- argümanlar ---------------- */
function parseArgs(argv) {
  const o = {
    pid: null, server: 'ws://127.0.0.1:9000', name: 'player',
    room: null, create: false, mode: null, team: null, max: 4, uid: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--pid':    o.pid = Number(argv[++i]); break;
      case '--server': o.server = argv[++i]; break;
      case '--name':   o.name = argv[++i]; break;
      case '--uid':    o.uid = argv[++i]; break;
      case '--room':   o.room = String(argv[++i] || '').toUpperCase(); break;
      case '--team':   o.team = String(argv[++i] || '').toLowerCase(); break;
      case '--mode':   o.mode = argv[++i]; break;
      case '--max':    o.max = Number(argv[++i]); break;
      case '--create': o.create = true; break;
      case '-h':
      case '--help':   usage(); process.exit(0);
    }
  }
  if (!o.pid) { usage(); process.exit(1); }
  /* --create / --room artik zorunlu degil: arkadas modunda
   * sadece baglanip "git <isim>" ile arkadasin odasina girilebilir. */
  if (!o.uid) o.uid = loadUid(o.name);
  return o;
}

function usage() {
  console.log(`
Kullanim: node axes_bridge.js --pid <PID> [--create | --room <KOD>] [secenekler]

  --pid     <sayi>          hedef uygulama PID'si (frida-ps -Ua)
  --create                  yeni oda kur (davet kodu uretilir)
  --room    <KOD>           davet koduyla odaya katil
  --name    <isim>          oyuncu adi (arkadas listesinde gorunen ad)
  --uid     <kimlik>        kalici kimlik (verilmezse isme gore uretilip saklanir)
  --team    a|b             ayni takimda oynamak icin takim tercihi
  --mode    team|ffa        oda modu (host)
  --max     <sayi>          oda kapasitesi (host)
  --server  ws://host:port  sunucu adresi (varsayilan ws://127.0.0.1:9000)

Arkadas modu: --create / --room vermeden baslat, sonra konsoldan
  ad <isim>      arkadas ekle        arkadaslar      listeyi goster
  sil <isim>     arkadas cikar       buyur <isim>    odana davet et
  git <isim>     arkadasin odasina katil
`);
}

/* ---------------- frida yukle ---------------- */
let frida = null;
try {
  frida = require('frida');
} catch (e) {
  console.error('[kopru] "frida" paketi yok. Kurmak icin:  npm i frida');
  process.exit(1);
}

const AGENT_PATH = path.join(__dirname, 'axes_agent.js');

/* ---------------- WebSocket istemcisi ---------------- */
class NetClient {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.ws = null;
    this.netId = -1;
    this.handlers = [];      // (obj) => void
  }

  onMessage(fn) { this.handlers.push(fn); }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => {
        console.log('[kopru] sunucuya baglandi: ' + this.url);
        // Once kimlik kaydi (arkadas sistemi uid'ye bagli), sonra oda islemi.
        this.sendRaw({ t: 'hello', uid: this.opts.uid, name: this.opts.name });
        if (this.opts.create) {
          this.sendRaw({
            t: 'create', name: this.opts.name, team: this.opts.team,
            mode: this.opts.mode || 'team', maxPlayers: this.opts.max,
          });
        } else if (this.opts.room) {
          this.sendRaw({ t: 'join', code: this.opts.room, name: this.opts.name, team: this.opts.team });
        } else {
          console.log('[kopru] arkadas modu — konsoldan: ad <isim> | git <isim>');
        }
        resolve();
      });
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) { this.onSnapshot(data); return; }
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.t === 'joined') this.netId = m.netId;
        this.handlers.forEach(h => h(m));
      });
      this.ws.on('error', e => reject(e));
      this.ws.on('close', () => { console.log('[kopru] sunucu baglantisi kapandi'); });
    });
  }

  onSnapshot(buf) {
    // Sunucu tick'i: 7 bayt header + 21n entity.
    // Proxy'ler girdi relay'iyle suruldugu icin bu paketi sadece
    // teshis amaciyla cozuyoruz; oyuna yazmiyoruz.
    if (buf.length < 7 || buf[0] !== 0x02) return;
    const n = buf.readUInt32LE(3);
    if (n === 0) return;
    this.lastSnapshot = { tick: buf.readUInt16LE(1), count: n };
  }

  sendRaw(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  /** sicak yol: 26 baytlik girdi paketi */
  sendInput(i) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const b = Buffer.allocUnsafe(26);
    b.writeUInt8(0x01, 0);
    b.writeUInt32LE(this.netId >>> 0, 1);
    b.writeUInt32LE((this.seq = ((this.seq || 0) + 1) >>> 0), 5);
    b.writeFloatLE(i.mx, 9);
    b.writeFloatLE(i.my, 13);
    b.writeFloatLE(i.rx, 17);
    b.writeFloatLE(i.ry, 21);
    b.writeUInt8(i.fire ? 1 : 0, 25);
    this.ws.send(b, { binary: true });
  }

  close() { try { this.ws.close(); } catch (e) {} }
}

/* ---------------- ana akis ---------------- */
(async function main() {
  const args = parseArgs(process.argv);

  const source = fs.readFileSync(AGENT_PATH, 'utf8');

  let session, script;
  try {
    session = await frida.attach(args.pid);
    script = await session.createScript(source, { name: 'axes_agent.js' });
  } catch (e) {
    console.error('[kopru] Frida baglantisi kurulamadi: ' + e.message);
    console.error('       Hedef uygulama calisiyor mu? frida-server aktif mi? PID dogru mu?');
    process.exit(1);
  }

  const net = new NetClient(args.server, args);
  let started = false;
  let lastBots = 0;

  /* --- oyundan gelen olaylar -> sunucu --- */
  script.message.connect(msg => {
    if (msg.type === 'error') { console.error('[ajan] ' + msg.description); return; }
    if (msg.type !== 'send') return;
    const p = msg.payload || {};

    switch (p.t) {
      case 'ready':
        console.log('[ajan] yuklendi  modul=' + p.module + '  base=' + p.base +
                    '  string_new=' + p.hasStringNew);
        break;

      case 'me_ready':
        console.log('[ajan] yerel oyuncu karakteri hazir');
        break;

      case 'log':
        console.log('[ajan] ' + p.msg);
        break;

      case 'fatal':
        console.error('[ajan] HATA: ' + p.msg);
        break;

      case 'bot_pool':
        if (p.size !== lastBots) { lastBots = p.size; }
        break;

      case 'in':
        if (started) net.sendInput(p);
        break;

      case 'pos':
        if (started) net.sendRaw({ t: 'pos', x: p.x, y: p.y, z: p.z });
        break;
    }
  });

  script.load()
    .then(() => console.log('[kopru] ajan enjekte edildi (pid ' + args.pid + ')'))
    .catch(e => { console.error('[kopru] ajan yuklenemedi: ' + e.message); process.exit(1); });

  /* --- sunucudan gelen olaylar -> oyun --- */
  net.onMessage(m => {
    switch (m.t) {
      case 'joined':
        console.log('');
        console.log('  ==============================================');
        console.log('   DAVET KODU : ' + m.code);
        console.log('   sen        : #' + m.netId + (m.netId === m.hostId ? '  (HOST)' : ''));
        console.log('   mod        : ' + m.mode);
        console.log('  ==============================================');
        console.log('   Arkadasina ver:  node axes_bridge.js --pid <PID> --room ' + m.code + ' --name <isim> --team ' + (args.team || 'a'));
        console.log('');
        net.code = m.code;
        net.isHost = m.netId === m.hostId;
        script.post({ type: 'net', payload: { t: 'room', code: m.code, netId: m.netId, host: net.isHost, mode: m.mode } });
        if (m.started) { started = true; script.post({ type: 'net', payload: { t: 'started' } }); }
        break;

      case 'teams':
        printTeams(m.players, net.netId);
        script.post({ type: 'net', payload: { t: 'teams', players: m.players } });
        break;

      case 'player_join':
        console.log('[oda] ' + m.name + ' katildi (#' + m.netId + ')');
        break;

      case 'player_leave':
        console.log('[oda] #' + m.netId + ' ayrildi');
        break;

      case 'match_start':
      case 'started':
        started = true;
        script.post({ type: 'net', payload: m });
        console.log('[oda] mac basladi');
        break;

      case 'spawn':
      case 'entity_pos':
      case 'input':
        script.post({ type: 'net', payload: m });
        break;

      case 'called':
        console.log('[cagri] ' + m.from + ': ' + m.msg);
        script.post({ type: 'net', payload: m });
        break;

      case 'mode':
        console.log('[oda] mod: ' + m.mode);
        break;

      /* ---- arkadas sistemi ---- */
      case 'hello_ok':
        net.uid = m.uid;
        console.log('[arkadas] kimlik: ' + m.name + ' (' + m.uid + ')  —  ' + (m.friends || []).length + ' arkadas');
        printFriends(m.friends);
        break;

      case 'friend_list':
        printFriends(m.friends);
        break;

      case 'invited':
        console.log('[davet] ' + m.from + ' seni odasina cagiriyor — kod: ' + m.code);
        console.log('        katilmak icin:  git ' + m.from);
        // Telefonda da bildirim cikar
        script.post({ type: 'net', payload: { t: 'called', from: m.from, msg: m.msg + ' (' + m.code + ')' } });
        break;

      case 'invite_sent':
        console.log('[davet] gonderildi -> ' + m.uid + '  (oda ' + m.code + ')');
        break;

      case 'friend_status':
        console.log('[arkadas] ' + m.name + ' ' + (m.online ? ('cevrimici' + (m.code ? ' — oda ' + m.code : '')) : 'cevrimdisi'));
        break;

      case 'friend_room':
        if (net.code) {                        // zaten bir odadayiz
          console.log('[arkadas] ' + m.name + ' odasi: ' + m.code + '  (su an baska odadasin — once ayril)');
        } else {
          console.log('[arkadas] ' + m.name + ' odasina katiliyorsun: ' + m.code);
          net.sendRaw({ t: 'join', code: m.code, name: args.name, team: args.team });
        }
        break;

      case 'error':
        console.error('[oda] HATA: ' + m.msg);
        break;
    }
  });

  await net.connect();

  /* --- konsol --- */
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Komutlar: ad <isim> | arkadaslar | sil <isim> | buyur <isim> | git <isim>');
  console.log('          davet | kim | takim <netId> a|b | mod team|ffa | basla | cagir <netId> <mesaj> | herkes <mesaj> | dur | q');

  rl.on('line', line => {
    const t = line.trim();
    if (!t) return;
    const [cmd, ...rest] = t.split(/\s+/);

    switch (cmd) {
      case 'davet':
        console.log('Davet kodu: ' + (net.code || '(henuz yok)') + '   netId: #' + net.netId);
        break;

      case 'kim':
        net.sendRaw({ t: 'ping' });
        console.log('netId #' + net.netId + (net.isHost ? ' (HOST)' : ''));
        break;

      case 'takim': {
        const id = Number(rest[0]);
        const team = (rest[1] || '').toLowerCase() === 'b' ? 1 : 0;
        net.sendRaw({ t: 'team', netId: id, team });
        break;
      }

      case 'mod':
        net.sendRaw({ t: 'mode', mode: rest[0] === 'ffa' ? 'ffa' : 'team' });
        break;

      case 'basla':
        net.sendRaw({ t: 'start' });
        break;

      case 'cagir': {
        const id = Number(rest[0]);
        const msg = rest.slice(1).join(' ') || 'Seni cagiriyor!';
        net.sendRaw({ t: 'call', to: id, msg });
        console.log('cagri gonderildi -> #' + id);
        break;
      }

      case 'herkes': {
        const msg = rest.join(' ') || 'Gel buraya!';
        net.sendRaw({ t: 'broadcast_call', msg });
        break;
      }

      /* ---- arkadas komutlari ---- */
      case 'ad':                                  // arkadas ekle
        if (!rest[0]) { console.log('kullanim: ad <isim>'); break; }
        net.sendRaw({ t: 'friend_add', name: rest.join(' ') });
        break;

      case 'arkadaslar':                          // listeyi yenile
        net.sendRaw({ t: 'friend_list' });
        break;

      case 'sil':                                 // arkadas cikar
        if (!rest[0]) { console.log('kullanim: sil <isim>'); break; }
        net.sendRaw({ t: 'friend_remove', name: rest.join(' ') });
        break;

      case 'buyur':                               // arkadasi odama davet et
        if (!rest[0]) { console.log('kullanim: buyur <isim>'); break; }
        net.sendRaw({ t: 'invite', name: rest.join(' '), msg: args.name + ' seni odasina davet ediyor' });
        break;

      case 'git':                                 // arkadasin odasina katil
        if (!rest[0]) { console.log('kullanim: git <isim>'); break; }
        net.sendRaw({ t: 'join_friend', name: rest.join(' ') });
        break;

      case 'dur':
        started = false;
        script.post({ type: 'net', payload: { t: 'stop' } });
        console.log('aktarim durduruldu');
        break;

      case 'q':
        cleanup();
        break;

      default:
        console.log('bilinmeyen komut: ' + cmd);
    }
  });

  process.on('SIGINT', cleanup);

  async function cleanup() {
    console.log('\n[kopru] kapatiliyor...');
    try { await script.unload(); } catch (e) {}
    try { await session.detach(); } catch (e) {}
    net.close();
    rl.close();
    process.exit(0);
  }
})().catch(e => {
  console.error('[kopru] beklenmeyen hata: ' + (e && e.stack || e));
  process.exit(1);
});

/* ---------------- yardimci ---------------- */
function printFriends(friends) {
  friends = friends || [];
  if (!friends.length) { console.log('  (arkadas yok — "ad <isim>" ile ekle)'); return; }
  friends.forEach(f => {
    const durum = f.online ? ('CEVRIMICI' + (f.code ? '  oda=' + f.code : '')) : 'cevrimdisi';
    console.log('  - ' + f.name + '  [' + durum + ']');
  });
}

function printTeams(players, meNetId) {
  if (!players) return;
  const A = players.filter(p => p.team === 0);
  const B = players.filter(p => p.team === 1);
  const tag = p => (p.netId === meNetId ? ' <- sen' : '');
  console.log('  TAKIM A: ' + (A.map(p => p.name + '#' + p.netId + tag(p)).join(', ') || '-'));
  console.log('  TAKIM B: ' + (B.map(p => p.name + '#' + p.netId + tag(p)).join(', ') || '-'));
}
