import "./style.css";
import { GameClient } from "./game/GameClient";
import { t } from "./i18n";
import { PROTOCOL_VERSION, type GameState, type PublicPlayer, type ServerMessage, type Team } from "../../shared/src/protocol";

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error("Required UI element is missing: " + selector);
  return element;
};

const canvas = $("#game-canvas") as HTMLCanvasElement;
const menu = $("#menu-overlay");
const hud = $("#hud");
const lobby = $("#lobby-panel");
const toast = $("#toast");
const scoreboard = $("#scoreboard");
const pauseOverlay = $("#pause-overlay");
const pauseHome = $("#pause-home");
const settingsPanel = $("#settings-panel");
const connectionLabel = $("#connection-label");
const serverStatus = $("#server-status");
const pingValue = $("#ping-value");
const pingHud = $("#ping-hud");
const movementPanel = $("#movement-debug");
const performancePanel = $("#performance-panel");
const playerNameInput = $("#player-name") as HTMLInputElement;
const serverAddressInput = $("#server-address") as HTMLInputElement;
let socket: WebSocket | null = null;
let currentState: GameState | null = null;
let localPlayerId = "";
let pendingHost = false;
let pingMs = 0;
let pingTimer = 0;
let toastTimer = 0;
let centerTimer = 0;

serverAddressInput.value = window.location.port === "5173"
  ? window.location.hostname + ":3000"
  : window.location.host;
playerNameInput.value = localStorage.getItem("strikepoint_callsign") || "RAVEN";
const game = new GameClient(canvas);
const sensitivityInput = $("#mouse-sensitivity") as HTMLInputElement;
const sensitivityValue = $("#sensitivity-value") as HTMLOutputElement;
const invertYInput = $("#invert-y") as HTMLInputElement;
const graphicsQualityInput = $("#graphics-quality") as HTMLSelectElement;
const fovInput = $("#field-of-view") as HTMLInputElement;
const fovValue = $("#fov-value") as HTMLOutputElement;
const dynamicCrosshairInput = $("#dynamic-crosshair") as HTMLInputElement;
const movementDebugInput = $("#movement-debug-toggle") as HTMLInputElement;
const performanceInput = $("#performance-toggle") as HTMLInputElement;

const savedSensitivity = Number(localStorage.getItem("strikepoint_sensitivity_scale") || "1");
sensitivityInput.value = String(Math.min(5, Math.max(0.1, Number.isFinite(savedSensitivity) ? savedSensitivity : 1)));
invertYInput.checked = localStorage.getItem("strikepoint_invert_y") === "true";
const savedQuality = localStorage.getItem("strikepoint_graphics_quality");
graphicsQualityInput.value = savedQuality === "LOW" || savedQuality === "HIGH" ? savedQuality : "BALANCED";
const savedFov = Number(localStorage.getItem("strikepoint_fov") || "90");
fovInput.value = String(Math.min(110, Math.max(70, Number.isFinite(savedFov) ? savedFov : 90)));
dynamicCrosshairInput.checked = localStorage.getItem("strikepoint_dynamic_crosshair") !== "false";
movementDebugInput.checked = localStorage.getItem("strikepoint_movement_debug") === "true";
performanceInput.checked = localStorage.getItem("strikepoint_performance_panel") === "true";

function applyMouseSettings(): void {
  const sensitivity = Number(sensitivityInput.value);
  sensitivityValue.value = sensitivity.toFixed(1);
  localStorage.setItem("strikepoint_sensitivity_scale", String(sensitivity));
  localStorage.setItem("strikepoint_invert_y", String(invertYInput.checked));
  game.setMouseSettings(sensitivity, invertYInput.checked);
}

applyMouseSettings();
game.setGraphicsQuality(graphicsQualityInput.value as "LOW" | "BALANCED" | "HIGH");
function applyFov(): void {
  const value = Number(fovInput.value);
  fovValue.value = value + "°";
  localStorage.setItem("strikepoint_fov", String(value));
  game.setFieldOfView(value);
}

function applyHudSettings(): void {
  localStorage.setItem("strikepoint_dynamic_crosshair", String(dynamicCrosshairInput.checked));
  localStorage.setItem("strikepoint_movement_debug", String(movementDebugInput.checked));
  localStorage.setItem("strikepoint_performance_panel", String(performanceInput.checked));
  game.setHudSettings(dynamicCrosshairInput.checked, movementDebugInput.checked, performanceInput.checked);
  movementPanel.classList.toggle("is-hidden", !movementDebugInput.checked);
  performancePanel.classList.toggle("is-hidden", !performanceInput.checked);
}

applyFov();
applyHudSettings();

game.setCallbacks({
  scoreboard: (visible) => scoreboard.classList.toggle("is-hidden", !visible),
  toast: (text) => showToast(text),
  pause: (paused) => {
    pauseOverlay.classList.toggle("is-hidden", !paused);
    pauseOverlay.setAttribute("aria-hidden", String(!paused));
    if (paused) {
      pauseHome.classList.remove("is-hidden");
      settingsPanel.classList.add("is-hidden");
      window.setTimeout(() => $("#resume-button").focus(), 0);
    }
  },
  telemetry: (movement, performance) => {
    movementPanel.textContent = movement || "";
    performancePanel.textContent = performance ? `${performance}\nLATÊNCIA ${pingMs} ms` : "";
  },
});

function showToast(text: string): void {
  toast.textContent = text;
  toast.classList.remove("is-hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("is-hidden"), 1850);
}

function setCenterMessage(text: string, className = ""): void {
  const element = $("#center-message");
  element.textContent = text;
  element.className = "center-message";
  if (className) element.classList.add(className);
  window.clearTimeout(centerTimer);
  if (text) centerTimer = window.setTimeout(() => { element.textContent = ""; }, 2300);
}

function send(payload: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function getWebSocketUrl(addressValue: string): string {
  let address = addressValue.trim();
  if (!address) throw new Error(t("toast.enterAddress"));
  address = address.replace(/^ws:\/\//i, "").replace(/^wss:\/\//i, "").replace(/^https?:\/\//i, "");
  const parts = address.split("/");
  let hostPort = parts[0].trim();
  if (!hostPort) throw new Error(t("toast.validAddress"));
  if (!hostPort.includes(":")) {
    const sameOrigin = hostPort === window.location.hostname || hostPort === window.location.host;
    const port = sameOrigin ? window.location.port : "3000";
    if (port) hostPort += ":" + port;
  }
  const secure = window.location.protocol === "https:";
  return (secure ? "wss://" : "ws://") + hostPort + "/game";
}

function connect(asHost: boolean): void {
  if (socket?.readyState === WebSocket.OPEN) {
    if (asHost) showToast(t("toast.alreadyConnected"));
    else showToast(t("toast.alreadyOnServer"));
    return;
  }
  if (socket?.readyState === WebSocket.CONNECTING) return;
  let url: string;
  try {
    url = getWebSocketUrl(serverAddressInput.value);
  } catch (error) {
    showToast(error instanceof Error ? error.message : t("toast.invalidAddress"));
    return;
  }
  pendingHost = asHost;
  localStorage.setItem("strikepoint_callsign", playerNameInput.value.trim());
  connectionLabel.textContent = t("status.connecting");
  serverStatus.textContent = t("status.connectingServer");
  $("#join-button").setAttribute("aria-busy", "true");
  $("#host-button").setAttribute("aria-busy", "true");
  try {
    socket = new WebSocket(url);
  } catch {
    connectionLabel.textContent = t("status.offline");
    serverStatus.textContent = t("status.couldNotOpen");
    showToast(t("toast.invalidAddress"));
    return;
  }
  socket.addEventListener("open", () => {
    if (!socket) return;
    connectionLabel.textContent = t("status.connected");
    serverStatus.textContent = t("status.requestingSlot");
    send({
      type: "join",
      name: playerNameInput.value.trim() || "JOGADOR",
      host: pendingHost,
      protocolVersion: PROTOCOL_VERSION,
    });
    game.setSender(send);
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => send({ type: "ping", sentAt: performance.now() }), 2000);
  });
  socket.addEventListener("message", (messageEvent) => {
    let payload: ServerMessage;
    try {
      payload = JSON.parse(String(messageEvent.data)) as ServerMessage;
    } catch {
      showToast(t("toast.unreadable"));
      return;
    }
    handleMessage(payload);
  });
  socket.addEventListener("error", () => {
    serverStatus.textContent = t("status.connectionFailed");
    connectionLabel.textContent = t("status.connectionError");
    showToast(t("toast.serverUnreachable"));
  });
  socket.addEventListener("close", (event) => {
    window.clearInterval(pingTimer);
    $("#join-button").removeAttribute("aria-busy");
    $("#host-button").removeAttribute("aria-busy");
    connectionLabel.textContent = t("status.offline");
    serverStatus.textContent = event.code === 1000 && event.reason ? event.reason : t("status.disconnected");
    game.clearConnection();
    currentState = null;
    localPlayerId = "";
    updateView();
    if (event.code !== 1000) showToast(t("toast.connectionClosed", { reason: t("toast.tryAgain") }));
  });
}

function handleMessage(message: ServerMessage): void {
  if (message.type === "welcome") {
    localPlayerId = message.playerId;
    game.setIdentity(localPlayerId, playerNameInput.value.trim() || "JOGADOR");
    serverStatus.textContent = t("status.waitingRoom", { room: message.roomId });
    showToast(t("toast.connected", { room: message.roomId }));
    return;
  }
  if (message.type === "state") {
    currentState = message.state;
    game.setState(message.state);
    updateView();
    return;
  }
  if (message.type === "event") {
    game.handleEvent(message.event);
    handleGameEvent(message.event, currentState);
    return;
  }
  if (message.type === "error") {
    showToast(message.message);
    serverStatus.textContent = message.message;
    return;
  }
  if (message.type === "pong") {
    pingMs = Math.max(0, Math.round(performance.now() - message.sentAt));
    pingValue.textContent = pingMs + " ms";
    pingHud.textContent = pingMs + " MS";
  }
}

function playerName(id: string, state: GameState | null): string {
  return state?.players.find((player) => player.id === id)?.name || "DESCONHECIDO";
}

function teamLabel(team: Team): string {
  return team === "ALPHA" ? t("team.alpha") : t("team.bravo");
}

function phaseLabel(phase: GameState["phase"]): string {
  const keys: Record<GameState["phase"], string> = {
    WAITING: "phase.waiting",
    ROUND_ACTIVE: "phase.roundActive",
    ROUND_END: "phase.roundEnd",
    MATCH_END: "phase.matchEnd",
  };
  return t(keys[phase]);
}

function appendKill(killer: string, victim: string, weapon: string): void {
  const feed = $("#killfeed");
  const row = document.createElement("div");
  row.className = "kill-entry";
  const killerEl = document.createElement("b");
  killerEl.textContent = killer;
  const weaponEl = document.createElement("i");
  weaponEl.textContent = weapon === "AR12" ? "▰" : "◆";
  const victimEl = document.createElement("b");
  victimEl.textContent = victim;
  row.append(killerEl, weaponEl, victimEl);
  feed.prepend(row);
  while (feed.children.length > 5) feed.lastElementChild?.remove();
  window.setTimeout(() => row.remove(), 5200);
}

function handleGameEvent(event: import("../../shared/src/protocol").ServerEvent, state: GameState | null): void {
  if (event.type === "player-joined") showToast(t("toast.playerJoined", { player: event.name, team: teamLabel(event.team) }));
  if (event.type === "player-left") showToast(t("toast.playerLeft", { player: event.name }));
  if (event.type === "kill") {
    const killer = playerName(event.killerId, state);
    const victim = playerName(event.victimId, state);
    appendKill(killer, victim, event.weapon);
    if (event.killerId === localPlayerId) showToast(t("toast.eliminated", { player: victim }));
    if (event.victimId === localPlayerId) showToast(t("toast.eliminatedBy", { player: killer }));
  }
  if (event.type === "round-end") {
    setCenterMessage(event.winner ? t("round.teamWins", { team: teamLabel(event.winner) }) : t("round.draw"), "big");
  }
  if (event.type === "round-start") {
    setCenterMessage(t("round.number", { round: String(event.round).padStart(2, "0") }), "big");
  }
  if (event.type === "match-end") {
    setCenterMessage(t("match.teamWins", { team: teamLabel(event.winner) }), "big");
    serverStatus.textContent = t("match.restartHelp", { team: teamLabel(event.winner) });
  }
}

function createPlayerRow(player: PublicPlayer): HTMLElement {
  const row = document.createElement("div");
  row.className = "player-row";
  const name = document.createElement("span");
  name.className = "player-row-name";
  name.textContent = player.name + (player.host ? "  ★" : "");
  if (player.id === localPlayerId) name.classList.add("you");
  const stat = document.createElement("span");
  stat.className = "player-row-stat";
  stat.textContent = player.alive ? t("player.ready") : t("player.out");
  row.append(name, stat);
  return row;
}

function updatePlayerColumns(state: GameState): void {
  const alpha = state.players.filter((player) => player.team === "ALPHA");
  const bravo = state.players.filter((player) => player.team === "BRAVO");
  $("#alpha-count").textContent = alpha.length + "/5";
  $("#bravo-count").textContent = bravo.length + "/5";
  const alphaList = $("#alpha-players");
  const bravoList = $("#bravo-players");
  alphaList.replaceChildren(...alpha.map(createPlayerRow));
  bravoList.replaceChildren(...bravo.map(createPlayerRow));
  const local = state.players.find((player) => player.id === localPlayerId);
  const alphaButton = $("#alpha-team") as HTMLButtonElement;
  const bravoButton = $("#bravo-team") as HTMLButtonElement;
  alphaButton.disabled = !local || local.team === "ALPHA" || state.phase !== "WAITING";
  bravoButton.disabled = !local || local.team === "BRAVO" || state.phase !== "WAITING";
  alphaButton.textContent = local?.team === "ALPHA" ? t("lobby.yourTeam") : t("lobby.joinAlpha");
  bravoButton.textContent = local?.team === "BRAVO" ? t("lobby.yourTeam") : t("lobby.joinBravo");
}

function updateScoreboard(state: GameState): void {
  const rows = $("#scoreboard-rows");
  rows.replaceChildren();
  const sorted = [...state.players].sort((a, b) => {
    if (a.team !== b.team) return a.team.localeCompare(b.team);
    return b.kills - a.kills;
  });
  for (const player of sorted) {
    const row = document.createElement("div");
    row.className = "scoreboard-row " + player.team.toLowerCase() + (player.id === localPlayerId ? " self" : "");
    const name = document.createElement("span");
    name.textContent = player.name;
    const team = document.createElement("span");
    team.textContent = teamLabel(player.team);
    const kills = document.createElement("span");
    kills.textContent = String(player.kills);
    const deaths = document.createElement("span");
    deaths.textContent = String(player.deaths);
    const hp = document.createElement("span");
    hp.textContent = player.alive ? String(player.health) : t("player.out");
    row.append(name, team, kills, deaths, hp);
    rows.append(row);
  }
}

function updateView(): void {
  const connectCard = document.querySelector<HTMLElement>(".connect-card");
  if (!currentState) {
    menu.classList.remove("is-hidden");
    lobby.classList.add("is-hidden");
    hud.classList.add("is-hidden");
    pauseOverlay.classList.add("is-hidden");
    connectCard?.classList.remove("is-hidden");
    return;
  }
  connectCard?.classList.add("is-hidden");
  const state = currentState;
  const local = state.players.find((player) => player.id === localPlayerId);
  updatePlayerColumns(state);
  updateScoreboard(state);
  $("#lobby-phase").textContent = phaseLabel(state.phase);
  $("#lobby-help").textContent = state.hostId === localPlayerId
    ? state.players.length < 2
      ? t("lobby.hostHelp")
      : state.phase === "MATCH_END"
        ? t("lobby.matchComplete")
        : t("lobby.hostReady")
    : t("lobby.guestHelp");
  $("#start-button span").textContent = state.phase === "MATCH_END" ? t("lobby.restart") : t("lobby.start");
  const start = $("#start-button") as HTMLButtonElement;
  start.disabled = state.hostId !== localPlayerId || state.players.length < 2 || (state.phase !== "WAITING" && state.phase !== "MATCH_END");
  const playing = state.phase === "ROUND_ACTIVE" || state.phase === "ROUND_END";
  menu.classList.toggle("is-hidden", playing);
  lobby.classList.toggle("is-hidden", state.phase !== "WAITING" && state.phase !== "MATCH_END");
  hud.classList.toggle("is-hidden", !playing);
  if (playing) {
    $("#score-alpha").textContent = String(state.score.ALPHA);
    $("#score-bravo").textContent = String(state.score.BRAVO);
    $("#round-label").textContent = t("hud.round", { round: String(state.round).padStart(2, "0") });
    const minutes = Math.floor(state.secondsLeft / 60);
    const seconds = state.secondsLeft % 60;
    $("#round-timer").textContent = String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    $("#map-label").textContent = state.map;
    $("#health-value").textContent = local ? String(local.health) : "0";
    $("#health-bar-fill").setAttribute("style", "width:" + (local?.health || 0) + "%");
    $("#ammo-value").innerHTML = (local?.magazine ?? 0) + " <small>/ " + (local?.reserve ?? 0) + "</small>";
    $("#team-chip-label").textContent = local ? teamLabel(local.team) : t("hud.spectator");
    $("#team-chip-dot").className = local?.team === "BRAVO" ? "blue" : "gold";
    $("#ping-hud").textContent = pingMs + " MS";
    if (state.phase === "ROUND_END") setCenterMessage(state.message, "big");
    if (!local?.alive && state.phase === "ROUND_ACTIVE") setCenterMessage(t("round.eliminated"), "small");
    else if (local?.alive && state.phase === "ROUND_ACTIVE") {
      const msg = $("#center-message");
      if (msg.textContent === t("round.eliminated")) msg.textContent = "";
    }
  } else if (state.phase === "MATCH_END") {
    menu.classList.remove("is-hidden");
    hud.classList.add("is-hidden");
  }
  serverStatus.textContent = t("status.serverPlayers", { server: state.serverName, players: state.players.length, max: state.maxPlayers });
}

$("#join-button").addEventListener("click", () => connect(false));
$("#host-button").addEventListener("click", () => connect(true));
$("#start-button").addEventListener("click", () => {
  send({ type: "start" });
  window.setTimeout(() => game.captureMouse(), 90);
});
$("#alpha-team").addEventListener("click", () => send({ type: "team", team: "ALPHA" as Team }));
$("#bravo-team").addEventListener("click", () => send({ type: "team", team: "BRAVO" as Team }));
canvas.addEventListener("click", () => game.captureMouse());
window.addEventListener("beforeunload", () => socket?.close(1000, "page closing"));

$("#resume-button").addEventListener("click", () => game.resume());
$("#settings-button").addEventListener("click", () => {
  pauseHome.classList.add("is-hidden");
  settingsPanel.classList.remove("is-hidden");
  $("#settings-back-button").focus();
});
$("#settings-back-button").addEventListener("click", () => {
  settingsPanel.classList.add("is-hidden");
  pauseHome.classList.remove("is-hidden");
  $("#settings-button").focus();
});
$("#return-lobby-button").addEventListener("click", () => {
  if (!window.confirm(t("toast.returnLobbyConfirm"))) return;
  game.setPaused(false);
  send({ type: "leave" });
  showToast(t("toast.returnLobbyByPlayer"));
});
$("#disconnect-button").addEventListener("click", () => {
  game.setPaused(false);
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Desconectado pelo jogador");
});
sensitivityInput.addEventListener("input", applyMouseSettings);
invertYInput.addEventListener("change", applyMouseSettings);
fovInput.addEventListener("input", applyFov);
dynamicCrosshairInput.addEventListener("change", applyHudSettings);
movementDebugInput.addEventListener("change", applyHudSettings);
performanceInput.addEventListener("change", applyHudSettings);
graphicsQualityInput.addEventListener("change", () => {
  const quality = graphicsQualityInput.value as "LOW" | "BALANCED" | "HIGH";
  localStorage.setItem("strikepoint_graphics_quality", quality);
  game.setGraphicsQuality(quality);
});

serverAddressInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connect(false);
});
playerNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connect(false);
});
