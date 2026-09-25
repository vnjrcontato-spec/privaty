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
  SERVER_NAME,
  SERVER_TICK_RATE,
  type ClientMessage,
  type DroppedWeapon,
  type GameState,
  type PlayerInput,
  type PlayerPosition,
  type PublicPlayer,
  type ServerEvent,
  type Team,
  type BuyItemId,
  type DeviceInfo,
  type RoundRecord,
  type SiteId,
  type WeaponAmmo,
  type WeaponId,
} from "../../shared/src/protocol.js";
import { COLLIDERS, movePlayer, spawnPosition } from "../../shared/src/movement.js";
import { calculateWeaponAccuracy } from "../../shared/src/accuracy.js";
import { BUY_PRICES, COMPETITIVE_RULES, SITES } from "../../shared/src/competitiveConfig.js";

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
  velocityX: number;
  velocityZ: number;
  velocityY: number;
  grounded: boolean;
  jumpBufferSeconds: number;
  yaw: number;
  pitch: number;
  input: PlayerInput;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  headshots: number;
  plants: number;
  defuses: number;
  mvps: number;
  roundImpact: number;
  damageBy: Map<string, { amount: number; at: number }>;
  damageAt: number;
  money: number;
  armor: number;
  helmet: boolean;
  defuseKit: boolean;
  hasDevice: boolean;
  ready: boolean;
  weapon: WeaponId;
  ownedWeapons: Set<WeaponId>;
  ammo: Record<WeaponId, WeaponAmmo>;
  reloadAt: number;
  lastShot: number;
  burstShots: number;
  rngState: number;
  lastAction: number;
}

const players = new Map<string, Player>();
const droppedWeapons: DroppedWeapon[] = [];
let hostId: string | null = null;
let phase: GameState["phase"] = "WAITING";
let round = 0;
let secondsLeft = 0;
let phaseEndsAt = 0;
let deviceDetonatesAt = 0;
let matchScore: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
let attackingTeam: Team = "ALPHA";
let lossStreak: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
let device: DeviceInfo = { status: "none", carrierId: null, x: null, y: null, z: null, site: null, secondsLeft: 0, action: null };
let objectiveAction: { type: "PLANT" | "DEFUSE"; playerId: string; startedAt: number; required: number; site: SiteId | null; x: number; z: number; health: number; lastAction: number } | null = null;
let roundHistory: RoundRecord[] = [];
let roundMvpId: string | null = null;
let matchWinner: Team | null = null;
let lastRoundWinner: Team | null = null;
let message = "Aguardando jogadores";
let stateTimer: NodeJS.Timeout | undefined;

function safeName(value: unknown): string {
  if (typeof value !== "string") return "JOGADOR";
  const cleaned = value.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 18);
  return cleaned || "JOGADOR";
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(payload: unknown): void {
  for (const player of players.values()) send(player.socket, payload);
}

function broadcastEvent(event: ServerEvent): void {
  for (const recipient of players.values()) {
    if (event.type === "shot") {
      const shooter = players.get(event.playerId);
      if (shooter && shooter.team !== recipient.team && recipient.id !== shooter.id && !canSeePlayer(recipient, shooter)) continue;
    }
    if (event.type === "hit" && recipient.id !== event.attackerId && recipient.id !== event.targetId) continue;
    let recipientEvent = event;
    if (event.type === "device" && event.playerId) {
      const subject = players.get(event.playerId);
      if (subject && subject.team !== recipient.team && !canSeePlayer(recipient, subject)) {
        recipientEvent = { ...event, playerId: null };
      }
    }
    send(recipient.socket, { type: "event", event: recipientEvent });
  }
}

function teamCounts(): Record<Team, number> {
  const counts: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
  for (const player of players.values()) counts[player.team] += 1;
  return counts;
}

function teamLabel(team: Team): string {
  return team === "ALPHA" ? "ALFA" : "BRAVO";
}

function defendingTeam(): Team {
  return attackingTeam === "ALPHA" ? "BRAVO" : "ALPHA";
}

function phaseSeconds(now = Date.now()): number {
  const deadline = phase === "DEVICE_PLANTED" ? deviceDetonatesAt : phaseEndsAt;
  return deadline > 0 ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

function setPhase(next: GameState["phase"], duration: number, nextMessage: string): void {
  phase = next;
  secondsLeft = duration;
  phaseEndsAt = duration > 0 ? Date.now() + duration * 1000 : 0;
  message = nextMessage;
  broadcastEvent({ type: "phase-change", phase, seconds: duration, message });
}

function deviceSnapshot(now = Date.now(), viewer?: Player): DeviceInfo {
  const action = objectiveAction;
  const carrier = device.carrierId ? players.get(device.carrierId) : undefined;
  const actionPlayer = action ? players.get(action.playerId) : undefined;
  const knowsCarrier = !viewer || !carrier || viewer.id === carrier.id || viewer.team === carrier.team || canSeePlayer(viewer, carrier);
  const seesActionPlayer = !viewer || !actionPlayer || viewer.id === actionPlayer.id || viewer.team === actionPlayer.team || canSeePlayer(viewer, actionPlayer);
  return {
    ...device,
    carrierId: knowsCarrier ? device.carrierId : null,
    secondsLeft: phase === "DEVICE_PLANTED" ? Math.max(0, Math.ceil((deviceDetonatesAt - now) / 1000)) : 0,
    action: action ? {
      type: action.type,
      playerId: seesActionPlayer ? action.playerId : null,
      progress: Math.min(1, Math.max(0, (now - action.startedAt) / (action.required * 1000))),
      required: action.required,
      site: action.site,
    } : null,
  };
}

function canSeePlayer(viewer: Player, target: Player): boolean {
  if (viewer.id === target.id || viewer.team === target.team) return true;
  const dx = target.x - viewer.x;
  const dz = target.z - viewer.z;
  const distance = Math.hypot(dx, dz);
  if (distance > 22) return false;
  if (distance < 0.001) return true;
  const wallDistance = firstWallDistance(viewer.x, viewer.z, dx / distance, dz / distance);
  return wallDistance >= distance - 0.72;
}

function publicPlayer(player: Player, viewer?: Player): PublicPlayer {
  const ammo = player.ammo[player.weapon];
  const visibleToViewer = !viewer || canSeePlayer(viewer, player);
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    x: visibleToViewer ? player.x : 0,
    y: visibleToViewer ? player.y : 0,
    z: visibleToViewer ? player.z : 0,
    velocityX: visibleToViewer ? player.velocityX : 0,
    velocityZ: visibleToViewer ? player.velocityZ : 0,
    velocityY: visibleToViewer ? player.velocityY : 0,
    grounded: visibleToViewer ? player.grounded : true,
    yaw: visibleToViewer ? player.yaw : 0,
    pitch: visibleToViewer ? player.pitch : 0,
    visibleToViewer,
    health: visibleToViewer ? player.health : null,
    alive: player.alive,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    damage: player.damage,
    headshots: player.headshots,
    plants: player.plants,
    defuses: player.defuses,
    mvps: player.mvps,
    money: player.money,
    armor: player.armor,
    helmet: visibleToViewer ? player.helmet : false,
    defuseKit: visibleToViewer ? player.defuseKit : false,
    hasDevice: visibleToViewer ? player.hasDevice : false,
    ready: player.ready,
    weapon: visibleToViewer ? player.weapon : null,
    ownedWeapons: visibleToViewer ? [...player.ownedWeapons] : [],
    magazine: visibleToViewer ? ammo.magazine : null,
    reserve: visibleToViewer ? ammo.reserve : null,
    crouching: visibleToViewer && player.input.crouch,
    host: player.id === hostId,
  };
}

function gameState(viewerId?: string): GameState {
  const viewer = viewerId ? players.get(viewerId) : undefined;
  return {
    phase,
    round,
    secondsLeft: phaseSeconds(),
    score: { ...matchScore },
    attackingTeam,
    hostId,
    roomId: "LOCAL-01",
    serverName: SERVER_NAME,
    map: MAP_NAME,
    maxPlayers: MAX_PLAYERS,
    players: [...players.values()].map((player) => publicPlayer(player, viewer)),
    droppedWeapons: droppedWeapons
      .filter((weapon) => {
        if (!viewer) return false;
        const distance = Math.hypot(viewer.x - weapon.x, viewer.z - weapon.z);
        return distance <= 12 && (distance < 0.001 || firstWallDistance(viewer.x, viewer.z, (weapon.x - viewer.x) / distance, (weapon.z - viewer.z) / distance) >= distance - 0.72);
      })
      .map((weapon) => ({ ...weapon })),
    device: deviceSnapshot(Date.now(), viewer),
    sites: SITES,
    roundHistory: [...roundHistory],
    roundMvpId,
    matchWinner,
    message,
    protocolVersion: PROTOCOL_VERSION,
  };
}

function broadcastState(): void {
  const serverTime = Date.now();
  for (const player of players.values()) send(player.socket, { type: "state", state: gameState(player.id), serverTime });
}

function chooseTeam(): Team {
  const counts = teamCounts();
  return counts.ALPHA <= counts.BRAVO ? "ALPHA" : "BRAVO";
}

function resetPlayerForRound(player: Player, index: number): void {
  const survived = player.alive;
  const position = spawnPosition(player.team, index);
  player.x = position.x;
  player.y = position.y;
  player.z = position.z;
  player.velocityX = 0;
  player.velocityZ = 0;
  player.velocityY = 0;
  player.grounded = true;
  player.jumpBufferSeconds = 0;
  player.health = 100;
  player.alive = true;
  player.yaw = player.team === "ALPHA" ? Math.PI : 0;
  player.pitch = 0;
  player.input = { ...EMPTY_INPUT, yaw: player.yaw };
  if (!survived) {
    player.weapon = "V9";
    player.ownedWeapons = new Set(["V9"]);
    player.ammo = { AR12: { magazine: 0, reserve: 0 }, V9: { magazine: 12, reserve: 36 } };
    player.armor = 0;
    player.helmet = false;
    player.defuseKit = false;
  }
  player.hasDevice = false;
  player.damageBy.clear();
  player.roundImpact = 0;
  player.reloadAt = 0;
  player.lastShot = 0;
  player.burstShots = 0;
}

function startRound(): void {
  const counts = teamCounts();
  if (players.size < 2 || counts.ALPHA === 0 || counts.BRAVO === 0) {
    setPhase("WAITING", 0, "Aguardando as duas equipes");
    broadcastState();
    return;
  }
  round += 1;
  if (round === COMPETITIVE_RULES.halftimeAfterRound + 1) attackingTeam = attackingTeam === "ALPHA" ? "BRAVO" : "ALPHA";
  setPhase("FREEZE_TIME", COMPETITIVE_RULES.freezeSeconds, "Compra aberta — prepare sua equipe");
  const spawnIndexes: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
  for (const player of players.values()) {
    resetPlayerForRound(player, spawnIndexes[player.team]);
    spawnIndexes[player.team] += 1;
  }
  const carrier = [...players.values()].filter((p) => p.team === attackingTeam).sort((a, b) => a.name.localeCompare(b.name))[0];
  if (carrier) carrier.hasDevice = true;
  droppedWeapons.length = 0;
  device = carrier
    ? { status: "carried", carrierId: carrier.id, x: null, y: null, z: null, site: null, secondsLeft: 0, action: null }
    : { status: "none", carrierId: null, x: null, y: null, z: null, site: null, secondsLeft: 0, action: null };
  objectiveAction = null;
  deviceDetonatesAt = 0;
  roundMvpId = null;
  broadcastEvent({ type: "round-start", round });
  broadcastState();
}

function startMatch(requesterId: string): void {
  if (requesterId !== hostId) {
    const requester = players.get(requesterId);
    if (requester) send(requester.socket, { type: "error", message: "Somente o anfitrião pode iniciar a partida." });
    return;
  }
  if (players.size < 2) {
    const host = players.get(requesterId);
    if (host) send(host.socket, { type: "error", message: "Mais uma pessoa precisa entrar antes de iniciar." });
    return;
  }
  if (phase === "WARMUP") {
    if (requesterId === hostId) startRound();
    return;
  }
  if (phase !== "WAITING" && phase !== "MATCH_END") return;
  if ([...players.values()].some((p) => !p.ready)) {
    const host = players.get(requesterId);
    if (host) send(host.socket, { type: "error", message: "Todas as pessoas precisam marcar que estão prontas." });
    return;
  }
  const counts = teamCounts();
  if (counts.ALPHA === 0 || counts.BRAVO === 0) {
    const host = players.get(requesterId);
    if (host) send(host.socket, { type: "error", message: "As duas equipes precisam ter pelo menos uma pessoa." });
    return;
  }
  if (phase === "MATCH_END") {
    matchScore = { ALPHA: 0, BRAVO: 0 };
    roundHistory = [];
    lossStreak = { ALPHA: 0, BRAVO: 0 };
    matchWinner = null;
    for (const player of players.values()) {
      player.kills = 0; player.deaths = 0; player.assists = 0; player.damage = 0;
      player.headshots = 0; player.plants = 0; player.defuses = 0; player.mvps = 0;
      player.money = COMPETITIVE_RULES.initialMoney; player.ready = false; player.alive = true;
      player.weapon = "V9"; player.ownedWeapons = new Set(["V9"]);
      player.ammo = { AR12: { magazine: 0, reserve: 0 }, V9: { magazine: 12, reserve: 36 } };
      player.armor = 0; player.helmet = false; player.defuseKit = false;
    }
  }
  round = 0;
  attackingTeam = "ALPHA";
  for (const player of players.values()) player.ready = false;
  setPhase("WARMUP", COMPETITIVE_RULES.warmupSeconds, "Preparação — anfitrião pode iniciar a rodada");
  broadcastState();
}

function endRound(winner: Team | null, reason: string): void {
  if (phase !== "ROUND_ACTIVE" && phase !== "DEVICE_PLANTED") return;
  lastRoundWinner = winner;
  message = winner ? teamLabel(winner) + " venceu a rodada" : "Rodada empatada";
  objectiveAction = null;
  device = { status: "none", carrierId: null, x: null, y: null, z: null, site: null, secondsLeft: 0, action: null };
  for (const player of players.values()) player.hasDevice = false;
  if (winner) {
    matchScore[winner] += 1;
    if (matchScore[winner] >= COMPETITIVE_RULES.roundsToWin) matchWinner = winner;
    lossStreak[winner] = 0;
    const loser = winner === "ALPHA" ? "BRAVO" : "ALPHA";
    lossStreak[loser] = Math.min(COMPETITIVE_RULES.lossBonusMaxStreak, lossStreak[loser] + 1);
    for (const player of players.values()) {
      const reward = player.team === winner
        ? COMPETITIVE_RULES.winReward
        : COMPETITIVE_RULES.lossReward + (lossStreak[loser] - 1) * COMPETITIVE_RULES.lossStreakStep;
      player.money = Math.min(COMPETITIVE_RULES.maximumMoney, player.money + reward);
    }
  }
  const mvp = [...players.values()].sort((a, b) => b.roundImpact - a.roundImpact || a.name.localeCompare(b.name))[0];
  roundMvpId = mvp && mvp.roundImpact > 0 ? mvp.id : null;
  if (roundMvpId) players.get(roundMvpId)!.mvps += 1;
  broadcastEvent({ type: "round-mvp", playerId: roundMvpId, impact: mvp?.roundImpact || 0 });
  roundHistory.push({ round, winner, reason, mvpId: roundMvpId });
  broadcastEvent({ type: "round-end", winner, reason });
  setPhase("ROUND_END", COMPETITIVE_RULES.roundEndSeconds, message);
  phaseEndsAt = Date.now() + COMPETITIVE_RULES.roundEndSeconds * 1000;
  broadcastState();
}

function checkElimination(): void {
  if (phase !== "ROUND_ACTIVE" && phase !== "DEVICE_PLANTED") return;
  const counts = teamCounts();
  const offense = attackingTeam;
  const defense = defendingTeam();
  if (!counts[offense]) { endRound(defense, "A equipe atacante saiu do servidor"); return; }
  if (!counts[defense]) { endRound(offense, "A equipe defensora saiu do servidor"); return; }
  const alive: Record<Team, number> = { ALPHA: 0, BRAVO: 0 };
  for (const player of players.values()) if (player.alive) alive[player.team] += 1;
  if (alive[defense] === 0) endRound(offense, "A equipe defensora foi eliminada");
  else if (alive[offense] === 0 && device.status !== "planted") endRound(defense, "A equipe atacante foi eliminada antes do plantio");
}

function removePlayer(player: Player): void {
  if (players.get(player.id) !== player) return;
  players.delete(player.id);
  console.log("[LEAVE] " + player.name + " disconnected");
  broadcastEvent({ type: "player-left", playerId: player.id, name: player.name });
  if (device.status === "carried" && device.carrierId === player.id) dropDevice(player);
  if (player.alive) dropPrimaryWeapon(player);
  if (hostId === player.id) hostId = players.keys().next().value || null;
  if (players.size === 0) {
    phase = "WAITING";
    round = 0;
    secondsLeft = 0;
    phaseEndsAt = 0;
    deviceDetonatesAt = 0;
    matchScore = { ALPHA: 0, BRAVO: 0 };
    attackingTeam = "ALPHA";
    roundHistory = [];
    matchWinner = null;
    device = { status: "none", carrierId: null, x: null, y: null, z: null, site: null, secondsLeft: 0, action: null };
    message = "Aguardando jogadores";
  } else {
    message = player.name + " saiu do servidor";
    checkElimination();
  }
  broadcastState();
}

function directionFor(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

function nextRandom(player: Player): number {
  let value = player.rngState >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  player.rngState = value >>> 0 || 0x6d2b79f5;
  return player.rngState / 0x1_0000_0000;
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

function addMoney(player: Player, amount: number): void {
  player.money = Math.min(COMPETITIVE_RULES.maximumMoney, Math.max(0, player.money + amount));
}

function dropDevice(player: Player): void {
  if (device.status !== "carried" || device.carrierId !== player.id) return;
  device = { status: "dropped", carrierId: null, x: player.x, y: player.y, z: player.z, site: null, secondsLeft: 0, action: null };
  player.hasDevice = false;
  if (objectiveAction?.type === "PLANT" && objectiveAction.playerId === player.id) objectiveAction = null;
  broadcastEvent({ type: "device", action: "dropped", playerId: player.id, site: null });
}

function dropPrimaryWeapon(player: Player): void {
  if (!player.ownedWeapons.has("AR12")) return;
  const ammo = player.ammo.AR12;
  droppedWeapons.push({ id: randomUUID(), weapon: "AR12", x: player.x, y: player.y, z: player.z, magazine: ammo.magazine, reserve: ammo.reserve });
  player.ownedWeapons.delete("AR12");
  player.ammo.AR12 = { magazine: 0, reserve: 0 };
  if (player.weapon === "AR12") {
    player.weapon = "V9";
    broadcastEvent({ type: "weapon-switch", playerId: player.id, weapon: "V9" });
  }
}

function updateDroppedWeaponPickups(): void {
  if (phase !== "ROUND_ACTIVE" && phase !== "DEVICE_PLANTED") return;
  const picker = [...players.values()].find((p) => p.alive && p.input.use && droppedWeapons.some((weapon) => Math.hypot(p.x - weapon.x, p.z - weapon.z) <= 1.55));
  if (!picker) return;
  const index = droppedWeapons.findIndex((weapon) => Math.hypot(picker.x - weapon.x, picker.z - weapon.z) <= 1.55);
  if (index < 0) return;
  const weapon = droppedWeapons.splice(index, 1)[0];
  picker.ownedWeapons.add(weapon.weapon);
  picker.ammo[weapon.weapon] = {
    magazine: Math.max(picker.ammo[weapon.weapon].magazine, weapon.magazine),
    reserve: Math.max(picker.ammo[weapon.weapon].reserve, weapon.reserve),
  };
  picker.weapon = weapon.weapon;
  picker.lastAction = Date.now();
  broadcastEvent({ type: "weapon-pickup", playerId: picker.id, weapon: weapon.weapon });
  broadcastEvent({ type: "weapon-switch", playerId: picker.id, weapon: weapon.weapon });
}

function inBuyZone(player: Player): boolean {
  for (let index = 0; index < 5; index += 1) {
    const spawn = spawnPosition(player.team, index);
    if (Math.hypot(player.x - spawn.x, player.z - spawn.z) <= COMPETITIVE_RULES.buyRadius) return true;
  }
  return false;
}

function buyItem(player: Player, item: BuyItemId): void {
  const validItems: BuyItemId[] = ["AR12", "VEST", "HELMET", "DEFUSE_KIT"];
  if (!validItems.includes(item) || phase !== "FREEZE_TIME" || !player.alive || !inBuyZone(player)) {
    send(player.socket, { type: "error", message: "Compra disponível somente durante a fase de compra, na sua base." });
    return;
  }
  if (item === "DEFUSE_KIT" && player.team !== defendingTeam()) {
    send(player.socket, { type: "error", message: "O kit de desarme é exclusivo dos defensores." });
    return;
  }
  if (item === "AR12" && player.ownedWeapons.has("AR12")) {
    send(player.socket, { type: "error", message: "Você já possui o fuzil AR-12." });
    return;
  }
  if (item === "VEST" && player.armor >= 100) {
    send(player.socket, { type: "error", message: "Seu colete já está completo." });
    return;
  }
  if (item === "HELMET" && player.helmet) {
    send(player.socket, { type: "error", message: "Você já está usando capacete." });
    return;
  }
  if (item === "DEFUSE_KIT" && player.defuseKit) {
    send(player.socket, { type: "error", message: "Você já possui um kit de desarme." });
    return;
  }
  const cost = BUY_PRICES[item];
  if (player.money < cost) {
    send(player.socket, { type: "error", message: "Dinheiro insuficiente para esta compra." });
    return;
  }
  player.money -= cost;
  if (item === "AR12") {
    player.ownedWeapons.add("AR12");
    player.ammo.AR12 = { magazine: 30, reserve: 90 };
    player.weapon = "AR12";
    broadcastEvent({ type: "weapon-switch", playerId: player.id, weapon: "AR12" });
  } else if (item === "VEST") player.armor = 100;
  else if (item === "HELMET") player.helmet = true;
  else player.defuseKit = true;
  broadcastEvent({ type: "purchase", playerId: player.id, item, cost, money: player.money });
}

function nearestSite(player: Player): (typeof SITES)[number] | null {
  let best: (typeof SITES)[number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const site of SITES) {
    const distance = Math.hypot(player.x - site.x, player.z - site.z);
    if (distance <= site.radius && distance < bestDistance) { best = site; bestDistance = distance; }
  }
  return best;
}

function cancelObjectiveAction(): void {
  if (!objectiveAction) return;
  broadcastEvent({
    type: "device",
    action: objectiveAction.type === "PLANT" ? "plant-cancel" : "defuse-cancel",
    playerId: objectiveAction.playerId,
    site: objectiveAction.site,
  });
  objectiveAction = null;
}

function updateObjectives(now: number): void {
  updateDroppedWeaponPickups();
  if (device.status === "carried" && device.carrierId) {
    const carrier = players.get(device.carrierId);
    if (carrier && carrier.alive) carrier.hasDevice = true;
  }

  if (phase === "ROUND_ACTIVE" && device.status === "dropped" && device.x !== null && device.z !== null) {
    const picker = [...players.values()].find((p) => p.alive && p.team === attackingTeam && p.input.use && Math.hypot(p.x - device.x!, p.z - device.z!) <= COMPETITIVE_RULES.devicePickupRadius);
    if (picker) {
      device = { status: "carried", carrierId: picker.id, x: null, y: null, z: null, site: null, secondsLeft: 0, action: null };
      picker.hasDevice = true;
      broadcastEvent({ type: "device", action: "picked-up", playerId: picker.id, site: null });
    }
  }

  let candidate: Player | undefined;
  let siteId: SiteId | null = null;
  let type: "PLANT" | "DEFUSE" | null = null;
  let required = 0;
  if (phase === "ROUND_ACTIVE" && device.status === "carried" && device.carrierId) {
    const carrier = players.get(device.carrierId);
    const site = carrier?.team === attackingTeam && carrier.alive && carrier.input.use ? nearestSite(carrier) : null;
    if (carrier && site) { candidate = carrier; siteId = site.id; type = "PLANT"; required = COMPETITIVE_RULES.plantSeconds; }
  } else if (phase === "DEVICE_PLANTED" && device.status === "planted" && device.x !== null && device.z !== null) {
    candidate = [...players.values()].find((p) => p.alive && p.team === defendingTeam() && p.input.use && Math.hypot(p.x - device.x!, p.z - device.z!) <= COMPETITIVE_RULES.defuseRadius);
    if (candidate) { type = "DEFUSE"; siteId = device.site; required = candidate.defuseKit ? COMPETITIVE_RULES.kitDefuseSeconds : COMPETITIVE_RULES.defuseSeconds; }
  }

  if (!candidate || !type) {
    cancelObjectiveAction();
  } else if (!objectiveAction || objectiveAction.playerId !== candidate.id || objectiveAction.type !== type || objectiveAction.site !== siteId) {
    cancelObjectiveAction();
    objectiveAction = { type, playerId: candidate.id, startedAt: now, required, site: siteId, x: candidate.x, z: candidate.z, health: candidate.health, lastAction: candidate.lastAction };
    broadcastEvent({ type: "device", action: type === "PLANT" ? "plant-start" : "defuse-start", playerId: candidate.id, site: siteId });
  } else {
    const moved = Math.hypot(candidate.x - objectiveAction.x, candidate.z - objectiveAction.z) > 0.22;
    if (!candidate.alive || candidate.health !== objectiveAction.health || candidate.lastAction !== objectiveAction.lastAction || moved || !candidate.input.use) {
      cancelObjectiveAction();
    } else if (now - objectiveAction.startedAt >= objectiveAction.required * 1000) {
      const completed = objectiveAction;
      objectiveAction = null;
      if (completed.type === "PLANT" && phase === "ROUND_ACTIVE" && device.status === "carried" && device.carrierId === candidate.id) {
        const site = SITES.find((entry) => entry.id === completed.site)!;
        device = { status: "planted", carrierId: null, x: site.x, y: 0, z: site.z, site: site.id, secondsLeft: COMPETITIVE_RULES.deviceSeconds, action: null };
        candidate.hasDevice = false;
        candidate.plants += 1;
        candidate.roundImpact += 2;
        addMoney(candidate, COMPETITIVE_RULES.plantReward);
        deviceDetonatesAt = now + COMPETITIVE_RULES.deviceSeconds * 1000;
        phaseEndsAt = 0;
        phase = "DEVICE_PLANTED";
        message = "Dispositivo plantado no site " + site.id;
        broadcastEvent({ type: "device", action: "planted", playerId: candidate.id, site: site.id });
        broadcastEvent({ type: "phase-change", phase, seconds: COMPETITIVE_RULES.deviceSeconds, message });
      } else if (completed.type === "DEFUSE" && phase === "DEVICE_PLANTED") {
        candidate.defuses += 1;
        candidate.roundImpact += 4;
        addMoney(candidate, COMPETITIVE_RULES.defuseReward);
        broadcastEvent({ type: "device", action: "defused", playerId: candidate.id, site: device.site });
        endRound(defendingTeam(), "O dispositivo foi desarmado");
      }
    }
  }

  if (phase === "DEVICE_PLANTED" && now >= deviceDetonatesAt) {
    broadcastEvent({ type: "device", action: "exploded", playerId: null, site: device.site });
    endRound(attackingTeam, "O dispositivo explodiu");
  }
}

function traceShot(shooter: Player, now: number): void {
  if ((phase !== "ROUND_ACTIVE" && phase !== "DEVICE_PLANTED") || !shooter.alive) return;
  if (now - shooter.lastShot < SHOT_COOLDOWN[shooter.weapon] || now < shooter.reloadAt) return;
  const ammo = shooter.ammo[shooter.weapon];
  if (ammo.magazine <= 0) {
    send(shooter.socket, { type: "error", message: "Carregador vazio — pressione R para recarregar." });
    return;
  }
  if (now - shooter.lastShot > 520) shooter.burstShots = 0;
  shooter.burstShots = Math.min(10, shooter.burstShots + 1);
  shooter.lastShot = now;
  shooter.lastAction = now;
  ammo.magazine -= 1;
  const accuracy = calculateWeaponAccuracy({
    horizontalSpeed: Math.hypot(shooter.velocityX, shooter.velocityZ),
    grounded: shooter.grounded,
    crouching: shooter.input.crouch,
    weapon: shooter.weapon,
    burstShots: shooter.burstShots,
  });
  const radius = Math.sqrt(nextRandom(shooter)) * accuracy.finalSpread;
  const angle = nextRandom(shooter) * Math.PI * 2;
  const direction = directionFor(
    shooter.yaw + Math.cos(angle) * radius,
    Math.max(-1.45, Math.min(1.45, shooter.pitch + Math.sin(angle) * radius)),
  );
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
    spread: accuracy.finalSpread,
    movementPenalty: accuracy.movementPenalty,
  });

  if (!target) return;
  let damage = DAMAGE[shooter.weapon][headshot ? "head" : "body"];
  if (headshot && target.helmet) {
    damage = Math.round(damage * 0.58);
    target.helmet = false;
  } else if (!headshot && target.armor > 0) {
    const absorbed = Math.min(target.armor, Math.ceil(damage * 0.62));
    target.armor -= absorbed;
    damage -= absorbed;
  }
  target.health = Math.max(0, target.health - damage);
  target.damageAt = now;
  const contribution = target.damageBy.get(shooter.id) || { amount: 0, at: now };
  contribution.amount += damage;
  contribution.at = now;
  target.damageBy.set(shooter.id, contribution);
  shooter.damage += damage;
  shooter.roundImpact += damage / 100;
  if (headshot) shooter.headshots += 1;
  broadcastEvent({ type: "hit", attackerId: shooter.id, targetId: target.id, damage, headshot });
  if (target.health <= 0) {
    target.alive = false;
    target.deaths += 1;
    shooter.kills += 1;
    shooter.roundImpact += 3 + (headshot ? 1 : 0);
    addMoney(shooter, COMPETITIVE_RULES.killReward);
    const assistIds: string[] = [];
    for (const [contributorId, entry] of target.damageBy) {
      if (contributorId === shooter.id || now - entry.at > 10_000 || entry.amount < 30) continue;
      const assister = players.get(contributorId);
      if (!assister || assister.team !== shooter.team) continue;
      assister.assists += 1;
      assister.roundImpact += 1;
      addMoney(assister, COMPETITIVE_RULES.assistReward);
      assistIds.push(contributorId);
    }
    if (device.status === "carried" && device.carrierId === target.id) dropDevice(target);
    dropPrimaryWeapon(target);
    broadcastEvent({ type: "kill", killerId: shooter.id, victimId: target.id, weapon: shooter.weapon, headshot, assistIds });
    checkElimination();
  }
}

function processMessage(player: Player, messageValue: ClientMessage): void {
  if (players.get(player.id) !== player) return;
  switch (messageValue.type) {
    case "input": {
      if (!messageValue.input || !player.alive || !["WARMUP", "FREEZE_TIME", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(phase)) return;
      const input = messageValue.input;
      const canMove = phase === "WARMUP" || phase === "ROUND_ACTIVE" || phase === "DEVICE_PLANTED";
      player.input = {
        forward: canMove && !!input.forward,
        backward: canMove && !!input.backward,
        left: canMove && !!input.left,
        right: canMove && !!input.right,
        walk: canMove && !!input.walk,
        crouch: canMove && !!input.crouch,
        jump: canMove && !!input.jump,
        use: !!input.use,
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
      if (!["FREEZE_TIME", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(phase) || !player.alive || player.reloadAt > now || ammo.reserve <= 0 || ammo.magazine >= MAGAZINE_SIZE[player.weapon]) return;
      player.reloadAt = now + RELOAD_MS[player.weapon];
      player.lastAction = now;
      broadcastEvent({ type: "reload", playerId: player.id, weapon: player.weapon });
      return;
    }
    case "weapon":
      if ((messageValue.weapon === "AR12" || messageValue.weapon === "V9") && player.ownedWeapons.has(messageValue.weapon) && ["WARMUP", "FREEZE_TIME", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(phase) && player.alive && Date.now() - player.lastAction > 180) {
        player.weapon = messageValue.weapon;
        player.burstShots = 0;
        player.lastAction = Date.now();
        broadcastEvent({ type: "weapon-switch", playerId: player.id, weapon: player.weapon });
      }
      return;
    case "team":
      if (phase !== "WAITING" || (messageValue.team !== "ALPHA" && messageValue.team !== "BRAVO")) return;
      if (messageValue.team !== player.team && teamCounts()[messageValue.team] >= teamCounts()[player.team] + 1) {
        send(player.socket, { type: "error", message: "A diferença entre as equipes pode ser de, no máximo, uma pessoa." });
        return;
      }
      player.team = messageValue.team;
      player.ready = false;
      broadcastState();
      return;
    case "ready":
      if (phase === "WAITING" || phase === "MATCH_END") {
        player.ready = !!messageValue.ready;
        broadcastState();
      }
      return;
    case "buy":
      buyItem(player, messageValue.item);
      return;
    case "drop-device":
      if (phase === "ROUND_ACTIVE" && player.team === attackingTeam && device.status === "carried" && device.carrierId === player.id) dropDevice(player);
      return;
    case "start":
      startMatch(player.id);
      return;
    case "leave":
      removePlayer(player);
      player.socket.close(1000, "voltou à sala");
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
    if ((phase === "WARMUP" || phase === "ROUND_ACTIVE" || phase === "DEVICE_PLANTED") && player.alive) {
      const moved = movePlayer(
        { x: player.x, y: player.y, z: player.z },
        player.velocityX,
        player.velocityZ,
        player.velocityY,
        player.grounded,
        player.jumpBufferSeconds,
        player.input,
        TICK_MS / 1000,
        player.weapon,
      );
      player.x = moved.position.x;
      player.y = moved.position.y;
      player.z = moved.position.z;
      player.velocityX = moved.velocityX;
      player.velocityZ = moved.velocityZ;
      player.velocityY = moved.velocityY;
      player.grounded = moved.grounded;
      player.jumpBufferSeconds = moved.jumpBufferSeconds;
    }
  }
  updateObjectives(now);
  secondsLeft = phaseSeconds(now);
  if (phase === "WARMUP" && phaseEndsAt > 0 && now >= phaseEndsAt) startRound();
  else if (phase === "FREEZE_TIME" && phaseEndsAt > 0 && now >= phaseEndsAt) setPhase("ROUND_ACTIVE", COMPETITIVE_RULES.roundSeconds, "Rodada ao vivo");
  else if (phase === "ROUND_ACTIVE" && phaseEndsAt > 0 && now >= phaseEndsAt) endRound(defendingTeam(), "O tempo acabou sem plantio");
  else if (phase === "ROUND_END" && phaseEndsAt > 0 && now >= phaseEndsAt) {
    if (matchWinner) {
      setPhase("MATCH_END", 0, teamLabel(matchWinner) + " venceu a partida");
      broadcastEvent({ type: "match-end", winner: matchWinner });
    } else if (round === COMPETITIVE_RULES.halftimeAfterRound) {
      attackingTeam = attackingTeam === "ALPHA" ? "BRAVO" : "ALPHA";
      setPhase("HALFTIME", COMPETITIVE_RULES.halftimeSeconds, "Intervalo — os lados foram trocados");
      broadcastEvent({ type: "halftime", round, attackingTeam });
    } else startRound();
  } else if (phase === "HALFTIME" && phaseEndsAt > 0 && now >= phaseEndsAt) startRound();
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
    response.end(JSON.stringify({ ok: true, phase, round, score: matchScore, players: players.size, protocolVersion: PROTOCOL_VERSION }));
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
      send(socket, { type: "error", message: "Mensagem de rede inválida." });
      return;
    }
    if (!player) {
      if (payload.type !== "join") {
        send(socket, { type: "error", message: "Envie uma solicitação para entrar no servidor." });
        return;
      }
      if (payload.protocolVersion !== PROTOCOL_VERSION) {
        send(socket, { type: "error", message: "A versão do jogo mudou. Atualize a página para entrar." });
        socket.close(1008, "version mismatch");
        return;
      }
      if (players.size >= MAX_PLAYERS) {
        send(socket, { type: "error", message: "O servidor está cheio." });
        socket.close(1008, "server full");
        return;
      }
      const id = randomUUID();
      const requestedHost = payload.host && hostId === null;
      if (hostId === null || !players.has(hostId)) hostId = id;
      const team = chooseTeam();
      const spawnIndex = teamCounts()[team];
      const spawn = spawnPosition(team, spawnIndex);
      player = {
        id,
        name: safeName(payload.name),
        team,
        socket,
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        velocityX: 0,
        velocityZ: 0,
        velocityY: 0,
        grounded: true,
        jumpBufferSeconds: 0,
        yaw: team === "ALPHA" ? Math.PI : 0,
        pitch: 0,
        input: { ...EMPTY_INPUT },
        health: 100,
        alive: phase === "WAITING" || phase === "WARMUP",
        kills: 0,
        deaths: 0,
        assists: 0,
        damage: 0,
        headshots: 0,
        plants: 0,
        defuses: 0,
        mvps: 0,
        roundImpact: 0,
        damageBy: new Map(),
        damageAt: 0,
        money: COMPETITIVE_RULES.initialMoney,
        armor: 0,
        helmet: false,
        defuseKit: false,
        hasDevice: false,
        ready: false,
        weapon: "V9",
        ownedWeapons: new Set(["V9"]),
        ammo: { AR12: { magazine: 0, reserve: 0 }, V9: { magazine: 12, reserve: 36 } },
        reloadAt: 0,
        lastShot: 0,
        burstShots: 0,
        rngState: Math.floor(Math.random() * 0xffff_ffff) || 0x6d2b79f5,
        lastAction: 0,
      };
      if (phase === "WAITING" || phase === "WARMUP") resetPlayerForRound(player, spawnIndex);
      if (requestedHost && players.size === 0) hostId = id;
      players.set(id, player);
      send(socket, { type: "welcome", playerId: id, hostId, roomId: "LOCAL-01", protocolVersion: PROTOCOL_VERSION });
      broadcastEvent({ type: "player-joined", playerId: id, name: player.name, team });
      message = player.name + " entrou na equipe " + teamLabel(team);
      broadcastState();
      console.log("[JOIN] " + player.name + " connected id=" + id.slice(0, 8) + " team=" + team);
      return;
    }
    processMessage(player, payload);
  });

  socket.on("close", () => {
    if (!player) return;
    removePlayer(player);
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
