const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── State ───────────────────────────────────────────────
const rooms = {}; // roomCode -> Room

function createRoom(code) {
  return {
    code,
    players: {},       // id -> PlayerState
    bullets: [],       // active bullets (for late-joiners snapshot)
    cratesOpened: {},  // crateId -> playerId
    structures: [],    // built structures
    started: false,
    startTime: null,
    stormRadius: 500,
    createdAt: Date.now()
  };
}

function getOrCreateRoom(code) {
  if (!rooms[code]) rooms[code] = createRoom(code);
  return rooms[code];
}

function genCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function broadcast(room, msg, excludeId = null) {
  const data = JSON.stringify(msg);
  Object.values(room.players).forEach(p => {
    if (p.id === excludeId) return;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  });
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ─── Cleanup old rooms ───────────────────────────────────
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(code => {
    const room = rooms[code];
    const alive = Object.values(room.players).filter(p => p.connected).length;
    if (alive === 0 && now - room.createdAt > 60000) {
      delete rooms[code];
      console.log(`Room ${code} cleaned up`);
    }
  });
}, 30000);

// ─── WebSocket Handler ───────────────────────────────────
wss.on('connection', (ws) => {
  let myId = null;
  let myRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── JOIN / CREATE ROOM ──
      case 'join': {
        myId = 'p_' + Math.random().toString(36).substring(2, 10);
        const code = msg.roomCode ? msg.roomCode.toUpperCase() : genCode();
        myRoom = getOrCreateRoom(code);

        const isHost = Object.keys(myRoom.players).length === 0;
        const colors = [0x00ff88, 0x00aaff, 0xff44aa, 0xffaa00, 0xaa44ff, 0xff6600, 0xff2222, 0x22ffff];
        const takenColors = Object.values(myRoom.players).map(p => p.color);
        const color = colors.find(c => !takenColors.includes(c)) || colors[0];

        const player = {
          id: myId, ws,
          name: msg.name || 'שחקן',
          color, isHost, connected: true,
          x: (Math.random() - 0.5) * 20,
          y: 1.7,
          z: (Math.random() - 0.5) * 20,
          yaw: 0, pitch: 0,
          hp: 100, shield: 50,
          alive: true,
          kills: 0,
          joinedAt: Date.now()
        };

        myRoom.players[myId] = player;

        // Send welcome to new player
        const playerList = Object.values(myRoom.players).map(p => playerSnapshot(p));
        send(ws, {
          type: 'welcome',
          id: myId,
          roomCode: code,
          isHost,
          players: playerList,
          cratesOpened: myRoom.cratesOpened,
          structures: myRoom.structures,
          started: myRoom.started,
          stormRadius: myRoom.stormRadius,
          mode: myRoom.mode || 'br'
        });

        // Notify others
        broadcast(myRoom, {
          type: 'playerJoined',
          player: playerSnapshot(player)
        }, myId);

        console.log(`[${code}] ${player.name} joined (${Object.keys(myRoom.players).length} players, host:${isHost})`);
        break;
      }

      // ── POSITION UPDATE ──
      case 'pos': {
        if (!myRoom || !myRoom.players[myId]) break;
        const p = myRoom.players[myId];
        p.x = msg.x; p.y = msg.y; p.z = msg.z;
        p.yaw = msg.yaw; p.pitch = msg.pitch;
        p.hp = msg.hp; p.shield = msg.shield;
        p.alive = msg.alive;
        broadcast(myRoom, { type: 'pos', id: myId, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch, hp: msg.hp, shield: msg.shield, alive: msg.alive }, myId);
        break;
      }

      // ── BULLET ──
      case 'bullet': {
        if (!myRoom) break;
        broadcast(myRoom, {
          type: 'bullet',
          from: myId,
          ox: msg.ox, oy: msg.oy, oz: msg.oz,
          dx: msg.dx, dy: msg.dy, dz: msg.dz,
          dmg: msg.dmg, range: msg.range,
          spread: msg.spread
        }, myId);
        break;
      }

      // ── HIT (authoritative damage) ──
      case 'hit': {
        if (!myRoom) break;
        const target = myRoom.players[msg.targetId];
        if (!target || !target.alive) break;
        target.hp -= msg.dmg;
        if (target.hp <= 0) {
          target.hp = 0;
          target.alive = false;
          if (myRoom.players[myId]) myRoom.players[myId].kills++;
          broadcast(myRoom, { type: 'killed', id: msg.targetId, by: myId });
          console.log(`[${myRoom.code}] ${target.name} killed by ${myRoom.players[myId]?.name}`);
          checkWin(myRoom);
        } else {
          send(target.ws, { type: 'damaged', dmg: msg.dmg, by: myId });
        }
        break;
      }

      // ── CRATE OPEN ──
      case 'openCrate': {
        if (!myRoom) break;
        if (myRoom.cratesOpened[msg.crateId]) break; // already taken
        myRoom.cratesOpened[msg.crateId] = myId;
        broadcast(myRoom, { type: 'crateOpened', crateId: msg.crateId, by: myId });
        break;
      }

      // ── BUILD ──
      case 'build': {
        if (!myRoom) break;
        const struct = { type: msg.buildType, x: msg.x, y: msg.y, z: msg.z, ry: msg.ry, rx: msg.rx, by: myId };
        myRoom.structures.push(struct);
        broadcast(myRoom, { type: 'build', ...struct }, myId);
        break;
      }

      // ── START GAME (host only) ──
      case 'startGame': {
        if (!myRoom) break;
        const p = myRoom.players[myId];
        if (!p || !p.isHost) break;
        myRoom.started = true;
        myRoom.startTime = Date.now();
        myRoom.mode = msg.mode || 'br'; // save mode in room
        const startMsg = { type: 'gameStart', mode: myRoom.mode };
        broadcast(myRoom, startMsg);
        send(ws, startMsg);
        console.log(`[${myRoom.code}] Game started — mode: ${myRoom.mode}, players: ${Object.keys(myRoom.players).length}`);
        break;
      }

      // ── STORM UPDATE (host syncs storm) ──
      case 'storm': {
        if (!myRoom) break;
        myRoom.stormRadius = msg.radius;
        broadcast(myRoom, { type: 'storm', radius: msg.radius }, myId);
        break;
      }

      // ── CHAT ──
      case 'chat': {
        if (!myRoom) break;
        const sender = myRoom.players[myId];
        broadcast(myRoom, { type: 'chat', name: sender?.name, msg: msg.text, color: sender?.color });
        break;
      }

      // ── PING ──
      case 'ping': {
        send(ws, { type: 'pong', t: msg.t });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myRoom || !myId) return;
    const p = myRoom.players[myId];
    if (p) {
      p.connected = false;
      broadcast(myRoom, { type: 'playerLeft', id: myId, name: p.name });
      console.log(`[${myRoom.code}] ${p.name} disconnected`);
      delete myRoom.players[myId];

      // Transfer host if needed
      const remaining = Object.values(myRoom.players).filter(x => x.connected);
      if (remaining.length > 0 && p.isHost) {
        remaining[0].isHost = true;
        send(remaining[0].ws, { type: 'youAreHost' });
        broadcast(myRoom, { type: 'newHost', id: remaining[0].id });
      }
    }
  });

  ws.on('error', () => {});
});

function playerSnapshot(p) {
  return { id: p.id, name: p.name, color: p.color, isHost: p.isHost, x: p.x, y: p.y, z: p.z, hp: p.hp, shield: p.shield, alive: p.alive, kills: p.kills };
}

function checkWin(room) {
  const alivePlayers = Object.values(room.players).filter(p => p.alive && p.connected);
  if (alivePlayers.length === 1) {
    const winner = alivePlayers[0];
    broadcast(room, { type: 'victory', winnerId: winner.id, winnerName: winner.name });
    console.log(`[${room.code}] ${winner.name} wins!`);
  }
}

// ─── HTTP endpoints ───────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'BattleZone Server Online 🎮', rooms: Object.keys(rooms).length }));
app.get('/rooms', (req, res) => {
  const list = Object.values(rooms).map(r => ({
    code: r.code,
    players: Object.keys(r.players).length,
    started: r.started
  }));
  res.json(list);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 BattleZone Server running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   HTTP:      http://localhost:${PORT}\n`);
});
