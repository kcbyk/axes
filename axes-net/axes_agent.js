'use strict';
/**
 * axes_agent.js — Axes.io netcode PoC / istemci ajani (Frida)
 * ==========================================================
 * Bu script oyunun ICINE enjekte edilir (bkz. axes_bridge.js).
 * Tek basina da calisir:  frida -U -f com.yuriychechulin.throwio -l axes_agent.js
 *
 * Yaptigi is
 * -----------
 *  1) Yerel oyuncunun girdisini (Move / Rotation / Fire) her update'te okur
 *     ve 20 Hz'de kopruye (bridge) yollar.
 *  2) Sunucudan gelen girdi paketlerini, uzak oyunculara karsilik gelen
 *     "proxy" botlara yazar. Boylece oyunun KENDI fizigi / carpismasi /
 *     silahi / skini bedavaya calisir; biz sadece niyeti aktariyoruz.
 *  3) Ayni takimdaki oyunculara dostu atesi kapatir (ApplyHit hasarini sifirlar).
 *  4) Davet / cagri bildirimlerini telefon ekraninda Android Toast olarak gosterir.
 *
 * Mimari notu
 * -----------
 * Oyun offline bot simulasyonu uzerine kurulu; Photon istemcisi strip edilmis.
 * Bu yuzden "multiplayer" = her istemcide, uzak oyuncular icin birer proxy
 * karakter (mevcut BotController) calistirmak ve ona ag girdisi beslemek.
 *
 * Binary alan yerlesimi dump.cs'ten alindi (Axes.io 2.8.16, arm64-v8a).
 * Kendi surumunuzu dump ettiginizde RVA / offset tablolarini guncelleyin.
 */

/* ================================================================ */
/* 0. Yardimcilar                                                    */
/* ================================================================ */
function log() {
  send({ t: 'log', msg: Array.prototype.map.call(arguments, String).join(' ') });
}

/* ================================================================ */
/* 1. Modul tabani ve RVA -> adres cozumlemesi                       */
/* ================================================================ */
const RVA = {
  // --- cagri noktalari (hook) ---
  SetMe:                  0x1322244,  // GameCore.SetMe(Character me)
  AddPlayer:              0x13222B0,  // GameCore.AddPlayer(Character player)
  PlayerControllerUpdate: 0x1327B9C,  // PlayerController.update(float)   <- yerel oyuncu girdisi
  BotControllerUpdate:    0x131A97C,  // BotController.update(float)      <- proxy bot
  OnBotSpawned:           0x1320C90,  // BotsManager.OnBotSpawned(BotController)
  ApplyHit:               0x12FDB40,  // Character.ApplyHit(int toCharViewId, long dmg, ...)

  // --- cagrilan yardimcilar ---
  TransformGetPosition:   0x25899FC,  // UnityEngine.Transform.get_position()
  TransformSetPosition:   0x2589A9C,  // UnityEngine.Transform.set_position(Vector3)
};

let mod = null;
try {
  mod = Process.getModuleByName('libil2cpp.so');
} catch (e) {
  mod = Process.enumerateModules().find(function (m) { return /il2cpp/i.test(m.name); });
}
if (!mod) {
  send({ t: 'fatal', msg: 'libil2cpp.so bulunamadi — dogru pakete mi baglandiniz?' });
}

const KOK = mod.base;                        // ASLR tabani
const A = {};                                // isim -> mutlak adres
Object.keys(RVA).forEach(function (k) { A[k] = KOK.add(RVA[k]); });

/* ================================================================ */
/* 2. Yapı alan offsetleri (dump.cs)                                 */
/* ================================================================ */
const OFF = {
  C_viewID:      0x20,   // Character.viewID                 (int32)
  C_t:           0x150,  // Character.t                      (Transform*)
  C_input:       0x168,  // Character.input                  (PlayerInput*)
  C_bot:         0x170,  // Character.bot                    (BotController*)
  C_Spawned:     0x161,  // Character.Spawned                (bool)

  B_character:   0x38,   // BotController.character          (Character*)
  B_botName:     0x48,   // BotController.botName            (Il2CppString*)
  B_t:           0x50,   // BotController.t                  (Transform*)

  PI_Move:       0x20,   // PlayerInput.Move                 (Vector2)
  PI_Rotation:   0x28,   // PlayerInput.Rotation             (Vector2)
  PI_Fire:       0x30,   // PlayerInput.Fire                 (bool)

  S_LEN:         0x10,   // Il2CppString.length              (int32)
  S_CHARS:       0x14,   // Il2CppString.chars               (utf16)
};

/* ================================================================ */
/* 3. Vector3 koprusu — arm64 trampolin                              */
/* ================================================================ */
/* Frida'nin NativeFunction'i, 3 float'lık HFA donduren bir fonksiyonu
 * ifade edemez. Bu yuzden calisma zamaninda 28 baytlik iki kucuk stub
 * uretiyoruz.  x1 = tampon adresi, x2 = hedef fonksiyon.
 *
 *  get_pos(t, out, fn):  stp x19,x30,[sp,#-16]! ; mov x19,x1 ; blr x2
 *                        stp s0,s1,[x19]       ; str s2,[x19,#8]
 *                        ldp x19,x30,[sp],#16  ; ret
 *  set_pos(t, in, fn):   stp x19,x30,[sp,#-16]! ; mov x19,x1
 *                        ldp s0,s1,[x19]       ; ldr s2,[x19,#8]
 *                        blr x2 ; ldp x19,x30,[sp],#16 ; ret
 */
//                                      stp        mov        blr        stp s0,s1  str s2,#8  ldp        ret
const STUB_GET_POS = [0xA9BF7BF3, 0xAA0103F3, 0xD63F0040, 0x2D000660, 0xBD000A62, 0xA8C17BF3, 0xD65F03C0];
//                                      stp        mov        ldp s0,s1  ldr s2,#8  blr        ldp        ret
const STUB_SET_POS = [0xA9BF7BF3, 0xAA0103F3, 0x2D400660, 0xBD400A62, 0xD63F0040, 0xA8C17BF3, 0xD65F03C0];

function buildStub(words) {
  const size = Process.pageSize;
  const mem = Memory.alloc(size);                 // Frida: rw- gelir
  const bytes = [];
  words.forEach(function (w) {
    bytes.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
  });
  // Android 10+ W^X: yazma ve calistirma ayni sayfada olamaz.
  // Bu yuzden once yaz, sonra sayfayi r-x'e cevir (rwx denemesi SELinux'ta reddedilir).
  mem.writeByteArray(bytes);
  try {
    Memory.protect(mem, size, 'r-x');
  } catch (e) {
    Memory.protect(mem, size, 'rwx');             // eski/rooted cihazlar icin yedek yol
  }
  return mem;
}

const fnGetPos = new NativeFunction(buildStub(STUB_GET_POS), 'void', ['pointer', 'pointer', 'pointer']);
const fnSetPos = new NativeFunction(buildStub(STUB_SET_POS), 'void', ['pointer', 'pointer', 'pointer']);
const vecBuf = Memory.alloc(16);

function getPos(t) {
  if (t.isNull()) return null;
  try {
    fnGetPos(t, vecBuf, A.TransformGetPosition);
    return [vecBuf.readFloat(), vecBuf.add(4).readFloat(), vecBuf.add(8).readFloat()];
  } catch (e) { return null; }
}

function setPos(t, x, y, z) {
  if (t.isNull()) return;
  try {
    vecBuf.writeFloat(x);
    vecBuf.add(4).writeFloat(y);
    vecBuf.add(8).writeFloat(z);
    fnSetPos(t, vecBuf, A.TransformSetPosition);
  } catch (e) { }
}

/* ================================================================ */
/* 4. Il2Cpp string (bot adini degistirmek icin)                     */
/* ================================================================ */
let fnStringNew = null;
try {
  const p = Module.findExportByName(null, 'il2cpp_string_new');
  if (p) fnStringNew = new NativeFunction(p, 'pointer', ['pointer']);
} catch (e) { }

function readIl2CppString(p) {
  if (!p || p.isNull()) return '';
  try {
    const len = p.add(OFF.S_LEN).readS32();
    return p.add(OFF.S_CHARS).readUtf16String(Math.min(len, 64));
  } catch (e) { return ''; }
}

function writeIl2CppString(slotPtr, text) {
  if (!fnStringNew) return;
  try {
    slotPtr.writePointer(fnStringNew(Memory.allocUtf8String(text)));
  } catch (e) { }
}

/* ================================================================ */
/* 5. Android Toast (davet / cagri bildirimi)                        */
/* ================================================================ */
function toast(msg) {
  try {
    if (!Java.available) return;
    Java.perform(function () {
      const ActivityThread = Java.use('android.app.ActivityThread');
      const app = ActivityThread.currentApplication();
      if (app === null) return;
      const Toast = Java.use('android.widget.Toast');
      const ctx = app.getApplicationContext();
      Java.scheduleOnMainThread(function () {
        Toast.makeText(ctx, msg, Toast.LENGTH_LONG.value).show();
      });
    });
  } catch (e) { }
}

/* ================================================================ */
/* 6. Ortak durum                                                    */
/* ================================================================ */
const S = {
  mePtr:    null,      // yerel Character*
  meTeam:   null,      // 0 = A, 1 = B, null = bilinmiyor
  meNetId:  -1,
  room:     null,      // davet kodu
  isHost:   false,
  mode:     'team',    // 'team' | 'ffa'
  running:  false,     // mac basladi mi (proxy aktarimi acik mi)

  botsPtr:  null,      // BotsManager*
  bots:     [],        // BotController* listesi (dogus sirasi)
  botToNet: new Map(), // BotController* (string) -> netId
  netToBot: new Map(), // netId -> BotController*
  netInput: new Map(), // netId -> {mx,my,rx,ry,fire}
  pending:  [],        // henuz proxy atanmamis uzak oyuncular

  viewToChar: new Map(), // viewID -> Character*
  charTeam:   new Map(), // Character* (string) -> team
};

const key = function (p) { return p.toString(); };

function viewIdOf(c) {
  try { return c.add(OFF.C_viewID).readS32(); } catch (e) { return 0; }
}
function charOfBot(b) {
  try { return b.add(OFF.B_character).readPointer(); } catch (e) { return ptr(0); }
}
function transformOf(c) {
  try { return c.add(OFF.C_t).readPointer(); } catch (e) { return ptr(0); }
}
function isSpawned(c) {
  try { return c.add(OFF.C_Spawned).readU8() !== 0; } catch (e) { return false; }
}
function teamOfChar(c) { return S.charTeam.get(key(c)); }
function teamOfView(v) {
  const c = S.viewToChar.get(v);
  return c ? teamOfChar(c) : undefined;
}
const teamTag = function (t) { return t === 0 ? 'A' : t === 1 ? 'B' : '?'; };

/* Proxy girdisini PlayerInput alanlarina yaz — oyunun fizigi gerisini yapar */
function writeInput(p, i) {
  try {
    p.add(OFF.PI_Move).writeFloat(i.mx);
    p.add(OFF.PI_Move + 4).writeFloat(i.my);
    p.add(OFF.PI_Rotation).writeFloat(i.rx);
    p.add(OFF.PI_Rotation + 4).writeFloat(i.ry);
    p.add(OFF.PI_Fire).writeU8(i.fire ? 1 : 0);
  } catch (e) { }
}

/* ================================================================ */
/* 7. Proxy atamasi: uzak oyuncu  <->  yerel bot                     */
/* ================================================================ */
function tryAssign() {
  for (let n = 0; n < S.pending.length; n++) {
    const ent = S.pending[n];
    if (S.netToBot.has(ent.netId)) continue;

    // Bostaki ilk botu al
    let bot = null;
    for (let k = 0; k < S.bots.length; k++) {
      const b = S.bots[k];
      if (b.isNull()) continue;
      if (S.botToNet.has(key(b))) continue;
      bot = b; break;
    }
    if (!bot) return;                       // bot yok — dogal dogusu bekle

    S.netToBot.set(ent.netId, bot);
    S.botToNet.set(key(bot), ent.netId);
    S.netInput.set(ent.netId, { mx: 0, my: 0, rx: 0, ry: 0, fire: 0 });

    const ch = charOfBot(bot);
    if (!ch.isNull()) {
      S.charTeam.set(key(ch), ent.team);
      S.viewToChar.set(viewIdOf(ch), ch);
    }
    // Isim etiketinde takim harfi -> oyunda kimi dost bilmenin en basit yolu
    writeIl2CppString(bot.add(OFF.B_botName), '[' + teamTag(ent.team) + '] ' + ent.name);

    // Uzak oyuncunun bildirdigi noktaya tasi — "ayni takim ayni yerde dogsun"
    if (typeof ent.x === 'number' && !ch.isNull() && isSpawned(ch) &&
        Math.abs(ent.x) + Math.abs(ent.z) > 0.01) {          // (0,0) = henuz konum gelmedi
      setPos(transformOf(ch), ent.x, ent.y || 0, ent.z);
    }

    log('proxy atandi: ' + ent.name + ' (netId ' + ent.netId + ', takim ' + teamTag(ent.team) + ')');
    toast('[' + teamTag(ent.team) + '] ' + ent.name + ' oyuna katildi');
  }
}

/* ================================================================ */
/* 8. Hook'lar                                                       */
/* ================================================================ */

/* 8.1 GameCore.SetMe(Character) — yerel oyuncuyu yakala */
Interceptor.attach(A.SetMe, {
  onEnter: function (args) {
    S.mePtr = args[0];
    S.viewToChar.set(viewIdOf(S.mePtr), S.mePtr);
    log('yerel karakter yakalandi: ' + S.mePtr);
    send({ t: 'me_ready' });
  },
});

/* 8.2 GameCore.AddPlayer(Character) — odadaki tum karakterleri izle */
Interceptor.attach(A.AddPlayer, {
  onEnter: function (args) {
    const c = args[0];
    if (c.isNull()) return;
    S.viewToChar.set(viewIdOf(c), c);
  },
});

/* 8.3 BotsManager.OnBotSpawned(BotController) — proxy havuzu */
Interceptor.attach(A.OnBotSpawned, {
  onEnter: function (args) {
    S.botsPtr = args[0];                 // BotsManager instance (this)
    const bot = args[1];
    if (bot.isNull()) return;
    S.bots.push(bot);
    send({ t: 'bot_pool', size: S.bots.length });
    tryAssign();
  },
});

/* 8.4 Yerel oyuncu girdisini oku ve gonder */
let pcSelf = null;
let lastInput = 0;
let lastPos = 0;

Interceptor.attach(A.PlayerControllerUpdate, {
  onEnter: function (args) { pcSelf = args[0]; },
  onLeave: function () {
    if (!S.running || !pcSelf || pcSelf.isNull()) return;
    const now = Date.now();

    if (now - lastInput >= 45) {                       // ~20 Hz
      lastInput = now;
      try {
        send({
          t: 'in',
          mx: pcSelf.add(OFF.PI_Move).readFloat(),
          my: pcSelf.add(OFF.PI_Move + 4).readFloat(),
          rx: pcSelf.add(OFF.PI_Rotation).readFloat(),
          ry: pcSelf.add(OFF.PI_Rotation + 4).readFloat(),
          fire: pcSelf.add(OFF.PI_Fire).readU8() ? 1 : 0,
        });
      } catch (e) { }
    }

    if (now - lastPos >= 200 && S.mePtr && !S.mePtr.isNull()) {   // ~5 Hz mutlak konum
      lastPos = now;
      const p = getPos(transformOf(S.mePtr));
      if (p) send({ t: 'pos', x: p[0], y: p[1], z: p[2] });
    }
  },
});

/* 8.5 Proxy botlara ag girdisini yaz.
 * Onemli: onLeave kullaniyoruz — botun kendi AI'si girdiyi yazar, biz
 * SONRADAN ezip kendi niyetimizi birakiyoruz. Boylece dogus/olme gibi
 * yan etkiler normal calismaya devam eder. */
let botSelf = null;
Interceptor.attach(A.BotControllerUpdate, {
  onEnter: function (args) { botSelf = args[0]; },
  onLeave: function () {
    if (!botSelf || botSelf.isNull()) return;
    const netId = S.botToNet.get(key(botSelf));
    if (netId === undefined) return;
    const inp = S.netInput.get(netId);
    if (inp) writeInput(botSelf, inp);
  },
});

/* 8.6 Dostu ates kapali.
 * ApplyHit(int toCharViewId, long damage, ...) — hasar argumanini
 * sifirlamak yeterli; fonksiyon yine calisir, sadece 0 hasar isler. */
Interceptor.attach(A.ApplyHit, {
  onEnter: function (args) {
    if (S.mode !== 'team') return;
    const atkTeam = teamOfChar(args[0]);
    const tgtTeam = teamOfView(args[1].toInt32());
    if (atkTeam === undefined || tgtTeam === undefined) return;
    if (atkTeam === tgtTeam) args[2] = ptr(0);        // dostu vurma
  },
});

/* ================================================================ */
/* 9. Kopruden (bridge) gelen mesajlar                               */
/* ================================================================ */
function onNet(p) {
  if (!p) return;
  switch (p.t) {

    case 'room':
      S.room = p.code; S.isHost = !!p.host; S.meNetId = p.netId;
      if (p.mode) S.mode = p.mode;
      log('oda: ' + p.code + '  netId=' + p.netId + (p.host ? ' (host)' : ''));
      toast('Oda ' + p.code + ' — sen: #' + p.netId);
      break;

    case 'teams': {
      const list = p.players || [];
      list.forEach(function (pl) {
        if (pl.netId === S.meNetId) {
          S.meTeam = pl.team;
          if (S.mePtr) S.charTeam.set(key(S.mePtr), pl.team);
          return;
        }
        const bot = S.netToBot.get(pl.netId);
        if (!bot) return;
        const ch = charOfBot(bot);
        if (!ch.isNull()) S.charTeam.set(key(ch), pl.team);
        writeIl2CppString(bot.add(OFF.B_botName), '[' + teamTag(pl.team) + '] ' + pl.name);
      });
      break;
    }

    case 'match_start':
      S.running = true;
      if (p.mode) S.mode = p.mode;
      // netId < 10000 olanlar gercek oyuncular; sunucu botlarini (>=10000) yoksay,
      // oyunda zaten kendi botlari var.
      S.pending = (p.entities || []).filter(function (e) {
        return !e.isBot && e.netId < 10000;
      });
      log('mac basladi — ' + S.pending.length + ' uzak oyuncu, mod=' + S.mode);
      toast('Mac basladi! ' + S.pending.length + ' oyuncu — takim ' + teamTag(S.meTeam));
      tryAssign();
      break;

    case 'started':
      S.running = true;
      break;

    case 'spawn':
      if (p.netId < 10000 && !S.netToBot.has(p.netId)) {
        S.pending.push(p);
        tryAssign();
      }
      break;

    case 'entity_pos': {
      // Uzak oyuncunun canli konumu geldi: proxy'si varsa oraya tasi
      const bot = S.netToBot.get(p.netId);
      if (!bot) break;
      const ch = charOfBot(bot);
      if (ch.isNull() || !isSpawned(ch)) break;
      setPos(transformOf(ch), p.x, p.y || 0, p.z);
      break;
    }

    case 'input':
      (p.list || []).forEach(function (i) {
        if (i.netId === S.meNetId) return;
        S.netInput.set(i.netId, i);
      });
      break;

    case 'called':
      log('CAGRI — ' + p.from + ': ' + p.msg);
      toast('CAGRI — ' + p.from + ': ' + p.msg);
      break;

    case 'chat':
      toast(p.from + ': ' + p.msg);
      break;

    case 'stop':
      S.running = false;
      S.netInput.clear();
      log('aktarim durduruldu');
      break;
  }
}
recv('net', onNet);

/* ================================================================ */
/* 10. Hazir bildirimi                                               */
/* ================================================================ */
send({
  t: 'ready',
  module: mod.name,
  base: KOK.toString(),
  hasStringNew: !!fnStringNew,
});
