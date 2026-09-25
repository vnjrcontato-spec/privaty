import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  EMPTY_INPUT,
  MAP_NAME,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  ROUND_LENGTH_SECONDS,
  ROUNDS_TO_WIN,
  SERVER_NAME,
  SERVER_TICK_RATE,
  type ClientMessage,
  type GameState,
  type PlayerInput,
  type PlayerPosition,
  type PublicPlayer,
  type ServerEvent,
  type Team,
  type WeaponAmmo,
  type WeaponId,
} from "../../shared/src/protocol.js";
import { COLLIDERS, movePlayer, spawnPosition } from "../../shared/src/movement.js";

const PORT = Number(process.env.PORT || 3000);
const TICK_MS = 1000 / SERVER_TICK_RATE;
const RELOAD_MS: Record<WeaponId, number> = { AR12: 1650, V9: 1250 };
const MAGAZINE_SIZE: Record<WeaponId, number> = { AR12: 30, V9: 12 };
const SHOT_COOLDOWN: Record<WeaponId, number> = { AR12: 125, V9: 270 };
const DAMAGE: Record<WeaponId, { body: number; head: number }> = {
  AR12: { body: 34, head: 100 },
  V9: { body: 24, head: 62 },
};

interface Player {
  id: string;
  name: string;
  team: Team;
  socket: WebSocket;
  x: number;
  y: number;
  z: number;
  velocityY: number;
  grounded: boolean;
  yaw: number;
  pitch: number;
  input: PlayerInput;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
  weapon: WeaponId;
  ammo: Record<WeaponId, WeaponAmmo>;
  reloadAt: number;
  lastShot: number;
  lastAction: number;
}

const players = new Map<string, Player>();
let hostId: string | null = null;
let phase: GameState["phase"] = "WAITING";
let round = 0;
let secondsLeft = ROUND_LENGTH_SECONDS;
let roundEndAt = 0;
let matchScore: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
let message = "Waiting for players";
let stateTimer: NodeJS.Timeout | undefined;

function safeName(value: unknown): string {
  if (typeof value !== "string") return "PLAYER";
  const cleaned = value.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 18);
  return cleaned || "PLAYER";
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(payload: unknown): void {
  for (const player of players.values()) send(player.socket, payload);
}

function broadcastEvent(event: ServerEvent): void {
  broadcast({ type: "event", event });
}

function teamCounts(): Record<Team, number> {
  const counts: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
  for (const player of players.values()) counts[player.team] += 1;
  return counts;
}

function publicPlayer(player: Player): PublicPlayer {
  const ammo = player.ammo[player.weapon];
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    health: player.health,
    alive: player.alive,
    kills: player.kills,
    deaths: player.deaths,
    weapon: player.weapon,
    magazine: ammo.magazine,
    reserve: ammo.reserve,
    crouching: player.input.crouch,
    host: player.id === hostId,
  };
}

function gameState(): GameState {
  return {
    phase,
    round,
    secondsLeft: Math.max(0, Math.ceil(secondsLeft)),
    score: { ...matchScore },
    hostId,
    roomId: "LOCAL-01",
    serverName: SERVER_NAME,
    map: MAP_NAME,
    maxPlayers: MAX_PLAYERS,
    players: [...players.values()].map(publicPlayer),
    message,
    protocolVersion: PROTOCOL_VERSION,
  };
}

function broadcastState(): void {
  broadcast({ type: "state", state: gameState(), serverTime: Date.now() });
}

function chooseTeam(): Team {
  const counts = teamCounts();
  return counts.ALPHA <= counts.BRAVO ? "ALPHA" : "BRAVO";
}

function resetPlayerForRound(player: Player, index: number): void {
  const position = spawnPosition(player.team, index);
  player.x = position.x;
  player.y = position.y;
  player.z = position.z;
  player.velocityY = 0;
  player.grounded = true;
  player.health = 100;
  player.alive = true;
  player.yaw = player.team === "ALPHA" ? Math.PI : 0;
  player.pitch = 0;
  player.input = { ...EMPTY_INPUT, yaw: player.yaw };
  player.weapon = "AR12";
  player.ammo = {
    AR12: { magazine: 30, reserve: 90 },
    V9: { magazine: 12, reserve: 36 },
  };
  player.reloadAt = 0;
}

function startRound(): void {
  round += 1;
  phase = "ROUND_ACTIVE";
  secondsLeft = ROUND_LENGTH_SECONDS;
  message = "Round " + String(round).padStart(2, "0") + " — engage";
  const spawnIndexes: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
  for (const player of players.values()) {
    resetPlayerForRound(player, spawnIndexes[player.team]);
    spawnIndexes[player.team] += 1;
  }
  broadcastEvent({ type: "round-start", round });
  broadcastState();
}

function startMatch(requesterId: string): void {
  if (requesterId !== hostId) {
    const requester = players.get(requesterId);
    if (requester) send(requester.socket, { type: "error", message: "Only the host can start the match." });
    return;
  }
  if (players.size < 2) {
    const host = players.get(requesterId);
    if (host) send(host.socket, { type: "error", message: "A second player must join before starting." });
    return;
  }
  const counts = teamCounts();
  if (counts.ALPHA === 0 || counts.BRAVO === 0) {
    const host = players.get(requesterId);
    if (host) send(host.socket, { type: "error", message: "Both teams need at least one player." });
    return;
  }
  if (phase === "MATCH_END") matchScore = { ALPHA: 0, BRAVO: 0 };
  round = 0;
  startRound();
}

function endRound(winner: Team | null, reason: string): void {
  if (phase !== "ROUND_ACTIVE") return;
  phase = "ROUND_END";
  secondsLeft = 4;
  roundEndAt = Date.now() + 4000;
  message = winner ? winner + " takes the round" : "Round drawn";
  if (winner) matchScore[winner] += 1;
  broadcastEvent({ type: "round-end", winner, reason });
  if (winner && matchScore[winner] >= ROUNDS_TO_WIN) {
    phase = "MATCH_END";
    message = winner + " wins the match";
    broadcastEvent({ type: "match-end", winner });
  }
  broadcastState();
}

function checkElimination(): void {
  const counts = teamCounts();
  if (!counts.ALPHA && counts.BRAVO) {
    endRound("BRAVO", "Team Alpha left the server");
    return;
  }
  if (!counts.BRAVO && counts.ALPHA) {
    endRound("ALPHA", "Team Bravo left the server");
    return;
  }
  if (!counts.ALPHA || !counts.BRAVO) return;
  const alive: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
  for (const player of players.values()) if (player.alive) alive[player.team] += 1;
  if (alive.ALPHA === 0) endRound("BRAVO", "Team Alpha eliminated");
  else if (alive.BRAVO === 0) endRound("ALPHA", "Team Bravo eliminated");
}

function directionFor(player: Player): { x: number; y: number; z: number } {
  const cosPitch = Math.cos(player.pitch);
  return {
    x: Math.sin(player.yaw) * cosPitch,
    y: Math.sin(player.pitch),
    z: -Math.cos(player.yaw) * cosPitch,
  };
}

function firstWallDistance(startX: number, startZ: number, directionX: number, directionZ: number): number {
  let nearest = 34;
  for (const block of COLLIDERS) {
    let entry = 0;
    let exit = nearest;
    const axes = [
      { origin: startX, direction: directionX, min: block.minX, max: block.maxX },
      { origin: startZ, direction: directionZ, min: block.minZ, max: block.maxZ },
    ];
    let intersects = true;
    for (const axis of axes) {
      if (Math.abs(axis.direction) < 0.00001) {
        if (axis.origin < axis.min || axis.origin > axis.max) {
          intersects = false;
          break;
        }
        continue;
      }
      const first = (axis.min - axis.origin) / axis.direction;
      const second = (axis.max - axis.origin) / axis.direction;
      entry = Math.max(entry, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
      if (exit < entry) {
        intersects = false;
        break;
      }
    }
    if (intersects && exit >= 0 && entry < nearest) nearest = Math.max(0, entry);
  }
  return nearest;
}

function traceShot(shooter: Player, now: number): void {
  if (phase !== "ROUND_ACTIVE" || !shooter.alive) return;
  if (now - shooter.lastShot < SHOT_COOLDOWN[shooter.weapon] || now < shooter.reloadAt) return;
  const ammo = shooter.ammo[shooter.weapon];
  if (ammo.magazine <= 0) {
    send(shooter.socket, { type: "error", message: "Magazine empty — press R to reload." });
    return;
  }
  shooter.lastShot = now;
  ammo.magazine -= 1;
  const direction = directionFor(shooter);
  const start = { x: shooter.x, y: shooter.y + (shooter.input.crouch ? 1.2 : 1.58), z: shooter.z };
  const horizontal = Math.hypot(direction.x, direction.z) || 1;
  let wallDistance = firstWallDistance(start.x, start.z, direction.x / horizontal, direction.z / horizontal);
  let nearestDistance = wallDistance;
  let target: Player | null = null;
  let headshot = false;

  for (const candidate of players.values()) {
    if (candidate.id === shooter.id || candidate.team === shooter.team || !candidate.alive) continue;
    const dx = candidate.x - start.x;
    const dz = candidate.z - start.z;
    const along = dx * (direction.x / horizontal) + dz * (direction.z / horizontal);
    const lateral = Math.abs(dx * (direction.z / horizontal) - dz * (direction.x / horizontal));
    if (along <= 0 || along >= nearestDistance - 0.35 || lateral > 0.53) continue;
    const shotHeight = start.y + (along / horizontal) * direction.y;
    if (shotHeight < candidate.y + 0.2 || shotHeight > candidate.y + 1.78) continue;
    nearestDistance = along;
    target = candidate;
    headshot = shotHeight >= candidate.y + 1.39;
  }

  const end: PlayerPosition = target
    ? { x: target.x, y: target.y + (headshot ? 1.58 : 0.95), z: target.z }
    : {
        x: start.x + direction.x * wallDistance,
        y: start.y + direction.y * wallDistance,
        z: start.z + direction.z * wallDistance,
      };
  broadcastEvent({
    type: "shot",
    playerId: shooter.id,
    weapon: shooter.weapon,
    start,
    end,
    hitPlayerId: target?.id ?? null,
    headshot,
  });

  if (!target) return;
  const damage = DAMAGE[shooter.weapon][headshot ? "head" : "body"];
  target.health = Math.max(0, target.health - damage);
  broadcastEvent({ type: "hit", attackerId: shooter.id, targetId: target.id, damage, headshot });
  if (target.health <= 0) {
    target.alive = false;
    target.deaths += 1;
    shooter.kills += 1;
    broadcastEvent({ type: "kill", killerId: shooter.id, victimId: target.id, weapon: shooter.weapon });
    checkElimination();
  }
}

function processMessage(player: Player, messageValue: ClientMessage): void {
  switch (messageValue.type) {
    case "input": {
      if (!messageValue.input || phase !== "ROUND_ACTIVE" || !player.alive) return;
      const input = messageValue.input;
      player.input = {
        forward: !!input.forward,
        backward: !!input.backward,
        left: !!input.left,
        right: !!input.right,
        sprint: !!input.sprint,
        crouch: !!input.crouch,
        jump: !!input.jump,
        yaw: Number.isFinite(input.yaw) ? input.yaw : player.yaw,
        pitch: Number.isFinite(input.pitch) ? Math.max(-1.45, Math.min(1.45, input.pitch)) : player.pitch,
      };
      player.yaw = player.input.yaw;
      player.pitch = player.input.pitch;
      return;
    }
    case "shoot":
      traceShot(player, Date.now());
      return;
    case "reload": {
      const now = Date.now();
      const ammo = player.ammo[player.weapon];
      if (phase !== "ROUND_ACTIVE" || !player.alive || player.reloadAt > now || ammo.reserve <= 0 || ammo.magazine >= MAGAZINE_SIZE[player.weapon]) return;
      player.reloadAt = now + RELOAD_MS[player.weapon];
      broadcastEvent({ type: "reload", playerId: player.id, weapon: player.weapon });
      return;
    }
    case "weapon":
      if ((messageValue.weapon === "AR12" || messageValue.weapon === "V9") && phase === "ROUND_ACTIVE" && player.alive && Date.now() - player.lastAction > 180) {
        player.weapon = messageValue.weapon;
        player.lastAction = Date.now();
        broadcastEvent({ type: "weapon-switch", playerId: player.id, weapon: player.weapon });
      }
      return;
    case "team":
      if (phase !== "WAITING" || (messageValue.team !== "ALPHA" && messageValue.team !== "BRAVO")) return;
      if (messageValue.team !== player.team && teamCounts()[messageValue.team] >= teamCounts()[player.team] + 1) {
        send(player.socket, { type: "error", message: "Teams may differ by at most one player." });
        return;
      }
      player.team = messageValue.team;
      broadcastState();
      return;
    case "start":
      startMatch(player.id);
      return;
    case "ping":
      send(player.socket, { type: "pong", sentAt: messageValue.sentAt, serverTime: Date.now() });
      return;
    case "join":
      return;
  }
}

function tick(): void {
  const now = Date.now();
  for (const player of players.values()) {
    if (player.reloadAt > 0 && now >= player.reloadAt) {
      const ammo = player.ammo[player.weapon];
      const needed = MAGAZINE_SIZE[player.weapon] - ammo.magazine;
      const loaded = Math.min(needed, ammo.reserve);
      ammo.magazine += loaded;
      ammo.reserve -= loaded;
      player.reloadAt = 0;
    }
    if (phase === "ROUND_ACTIVE" && player.alive) {
      const moved = movePlayer(
        { x: player.x, y: player.y, z: player.z },
        player.velocityY,
        player.grounded,
        player.input,
        TICK_MS / 1000,
      );
      player.x = moved.position.x;
      player.y = moved.position.y;
      player.z = moved.position.z;
      player.velocityY = moved.velocityY;
      player.grounded = moved.grounded;
    }
  }

  if (phase === "ROUND_ACTIVE") {
    secondsLeft -= TICK_MS / 1000;
    if (secondsLeft <= 0) endRound("BRAVO", "Time expired");
  } else if (phase === "ROUND_END" && now >= roundEndAt) {
    startRound();
  }
  broadcastState();
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
    return;
  }
  if (url.pathname === "/api/status") {
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    response.end(JSON.stringify(gameState()));
    return;
  }

  const staticRoot = resolve(process.cwd(), "dist/client");
  const requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(join(staticRoot, safePath));
  if (!filePath.startsWith(staticRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(staticRoot, "index.html");
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
  };
  response.writeHead(200, { "content-type": contentTypes[extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(filePath).pipe(response);
}

const httpServer = createServer(handleHttp);
const websocketServer = new WebSocketServer({ server: httpServer, path: "/game", maxPayload: 16_384 });

websocketServer.on("connection", (socket) => {
  let player: Player | undefined;
  socket.on("message", (raw) => {
    let payload: ClientMessage;
    try {
      payload = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(socket, { type: "error", message: "Invalid network message." });
      return;
    }
    if (!player) {
      if (payload.type !== "join") {
        send(socket, { type: "error", message: "Send a join request to enter the server." });
        return;
      }
      if (payload.protocolVersion !== PROTOCOL_VERSION) {
        send(socket, { type: "error", message: "Protocol version mismatch. Reload the game page." });
        socket.close(1008, "version mismatch");
        return;
      }
      if (players.size >= MAX_PLAYERS) {
        send(socket, { type: "error", message: "Server is full." });
        socket.close(1008, "server full");
        return;
      }
      if (phase !== "WAITING" && phase !== "MATCH_END") {
        send(socket, { type: "error", message: "Match is in progress. Join after the current match." });
        socket.close(1008, "match in progress");
        return;
      }
      const id = randomUUID();
      const requestedHost = payload.host && hostId === null;
      if (hostId === null || !players.has(hostId)) hostId = id;
      const team = chooseTeam();
      const spawn = spawnPosition(team, teamCounts()[team]);
      player = {
        id,
        name: safeName(payload.name),
        team,
        socket,
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        velocityY: 0,
        grounded: true,
        yaw: team === "ALPHA" ? Math.PI : 0,
        pitch: 0,
        input: { ...EMPTY_INPUT },
        health: 100,
        alive: true,
        kills: 0,
        deaths: 0,
        weapon: "AR12",
        ammo: { AR12: { magazine: 30, reserve: 90 }, V9: { magazine: 12, reserve: 36 } },
        reloadAt: 0,
        lastShot: 0,
        lastAction: 0,
      };
      if (requestedHost && players.size === 0) hostId = id;
      players.set(id, player);
      send(socket, { type: "welcome", playerId: id, hostId, roomId: "LOCAL-01", protocolVersion: PROTOCOL_VERSION });
      broadcastEvent({ type: "player-joined", playerId: id, name: player.name, team });
      message = player.name + " joined " + team;
      broadcastState();
      console.log("[JOIN] " + player.name + " connected id=" + id.slice(0, 8) + " team=" + team);
      return;
    }
    processMessage(player, payload);
  });

  socket.on("close", () => {
    if (!player) return;
    players.delete(player.id);
    console.log("[LEAVE] " + player.name + " disconnected");
    broadcastEvent({ type: "player-left", playerId: player.id, name: player.name });
    if (hostId === player.id) hostId = players.keys().next().value || null;
    if (players.size === 0) {
      phase = "WAITING";
      round = 0;
      matchScore = { ALPHA: 0, BRAVO: 0 };
      message = "Waiting for players";
    } else {
      message = player.name + " disconnected";
      checkElimination();
    }
    broadcastState();
  });
  socket.on("error", (error) => console.warn("[ERROR] WebSocket", error.message));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("[SERVER] " + SERVER_NAME + " ready on 0.0.0.0:" + PORT);
  console.log("[SERVER] LAN clients connect to http://<host-ip>:" + PORT);
});

stateTimer = setInterval(tick, TICK_MS);
process.on("SIGINT", () => {
  if (stateTimer) clearInterval(stateTimer);
  websocketServer.close();
  httpServer.close(() => process.exit(0));
});
