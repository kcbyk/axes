'use strict';
/**
 * sim_client.js — Oyunsuz test istemcisi.
 * ======================================
 * Telefonda oyun olmadan sunucu protokolunu dogrulamak icin kullanilir:
 * oda kurar / katilir, 20 Hz'de sahte girdi yollar, gelen olaylari yazar.
 *
 * Ornek: iki terminalde
 *   1)  node axes_server.js
 *   2)  node sim_client.js --create --name Ali --team a --walk
 *   3)  node sim_client.js --room <KOD> --name Veli --team a --walk
 */
const WebSocket = require('ws');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const SERVER = arg('server', 'ws://127.0.0.1:9000');
const NAME   = arg('name', 'sim');
const TEAM   = arg('team', null);
const CODE   = arg('room', null);
const CREATE = !!arg('create', false);
const WALK   = !!arg('walk', false);
const MODE   = arg('mode', 'team');

const ws = new WebSocket(SERVER);
let netId = -1;
let phase = Math.random() * Math.PI * 2;
let seq = 0;
let started = false;

ws.on('open', () => {
  console.log('[sim] baglandi -> ' + SERVER);
  if (CREATE) ws.send(JSON.stringify({ t: 'create', name: NAME, team: TEAM, mode: MODE }));
  else if (CODE) ws.send(JSON.stringify({ t: 'join', code: CODE, name: NAME, team: TEAM }));
  else { console.error('[sim] --create veya --room gerekli'); process.exit(1); }
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;                       // 20 Hz snapshot — sim icin gereksiz
  const m = JSON.parse(data);

  switch (m.t) {
    case 'joined':
      netId = m.netId;
      console.log('[sim] odada #' + netId + '  kod=' + m.code + '  mod=' + m.mode);
      break;
    case 'teams':
      console.log('[sim] takimlar: ' + m.players.map(p => p.name + '#' + p.netId + '=' + (p.team === 0 ? 'A' : 'B')).join(' | '));
      break;
    case 'player_join':
      console.log('[sim] + ' + m.name + ' (#' + m.netId + ')');
      break;
    case 'match_start':
      started = true;
      console.log('[sim] MAC BASLADI  entity=' + m.entities.length + '  mod=' + m.mode);
      break;
    case 'started':
      started = true;
      break;
    case 'called':
      console.log('[sim] !!! CAGRI — ' + m.from + ': ' + m.msg);
      break;
    case 'error':
      console.error('[sim] hata: ' + m.msg);
      process.exit(1);
  }
});

ws.on('close', () => console.log('[sim] baglanti kapandi'));
ws.on('error', e => { console.error('[sim] ' + e.message); process.exit(1); });

/* 20 Hz sahte girdi */
setInterval(() => {
  if (!started || netId < 0 || ws.readyState !== 1) return;
  let mx = 0, my = 0, rx = 0, ry = 0;
  if (WALK) {
    phase += 0.05;
    mx = Math.cos(phase);
    my = Math.sin(phase);
    rx = Math.cos(phase * 0.5);
  }
  const b = Buffer.allocUnsafe(26);
  b.writeUInt8(0x01, 0);
  b.writeUInt32LE(netId >>> 0, 1);
  b.writeUInt32LE((seq = (seq + 1) >>> 0), 5);
  b.writeFloatLE(mx, 9);
  b.writeFloatLE(my, 13);
  b.writeFloatLE(rx, 17);
  b.writeFloatLE(ry, 21);
  b.writeUInt8(0, 25);
  ws.send(b, { binary: true });
}, 50);

/* 5 Hz konum raporu (yururken) */
setInterval(() => {
  if (!started || netId < 0 || !WALK || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'pos', x: Math.cos(phase) * 10, y: 0, z: Math.sin(phase) * 10 }));
}, 200);

/* Host isen 1 sn sonra maci baslat */
setTimeout(() => {
  if (CREATE && ws.readyState === 1) ws.send(JSON.stringify({ t: 'start' }));
}, 1500);
