export const PROTOCOL_VERSION = "SP-3";
export const SERVER_NAME = "STRIKEPOINT BRASIL";
export const MAX_PLAYERS = 10;
export const SERVER_TICK_RATE = 20;
export const MAP_NAME = "IRON YARD";

export type Team = "ALPHA" | "BRAVO";
export type Phase = "WAITING" | "WARMUP" | "FREEZE_TIME" | "ROUND_ACTIVE" | "DEVICE_PLANTED" | "ROUND_END" | "HALFTIME" | "MATCH_END";
export type WeaponId = "AR12" | "V9";
export type SiteId = "A" | "B";
export type BuyItemId = "AR12" | "VEST" | "HELMET" | "DEFUSE_KIT";

export interface PlayerInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  walk: boolean;
  crouch: boolean;
  jump: boolean;
  use: boolean;
  yaw: number;
  pitch: number;
}

export interface PlayerPosition { x: number; y: number; z: number }
export interface WeaponAmmo { magazine: number; reserve: number }
export interface SiteInfo { id: SiteId; x: number; z: number; radius: number }
export interface DroppedWeapon extends PlayerPosition { id: string; weapon: WeaponId; magazine: number; reserve: number }
export interface DeviceInfo {
  status: "none" | "carried" | "dropped" | "planted";
  carrierId: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  site: SiteId | null;
  secondsLeft: number;
  action: null | { type: "PLANT" | "DEFUSE"; playerId: string | null; progress: number; required: number; site: SiteId | null };
}
export interface RoundRecord { round: number; winner: Team | null; reason: string; mvpId: string | null }

export interface PublicPlayer extends PlayerPosition {
  id: string;
  name: string;
  team: Team;
  velocityX: number;
  velocityZ: number;
  velocityY: number;
  grounded: boolean;
  yaw: number;
  pitch: number;
  visibleToViewer: boolean;
  health: number | null;
  alive: boolean;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  headshots: number;
  plants: number;
  defuses: number;
  mvps: number;
  money: number;
  armor: number;
  helmet: boolean;
  defuseKit: boolean;
  hasDevice: boolean;
  ready: boolean;
  weapon: WeaponId | null;
  ownedWeapons: WeaponId[];
  magazine: number | null;
  reserve: number | null;
  crouching: boolean;
  host: boolean;
}

export interface GameState {
  phase: Phase;
  round: number;
  secondsLeft: number;
  score: Record<Team, number>;
  attackingTeam: Team;
  hostId: string | null;
  roomId: string;
  serverName: string;
  map: string;
  maxPlayers: number;
  players: PublicPlayer[];
  droppedWeapons: DroppedWeapon[];
  device: DeviceInfo;
  sites: SiteInfo[];
  roundHistory: RoundRecord[];
  roundMvpId: string | null;
  matchWinner: Team | null;
  message: string;
  protocolVersion: string;
}

export type ClientMessage =
  | { type: "join"; name: string; host: boolean; protocolVersion: string }
  | { type: "input"; input: PlayerInput }
  | { type: "shoot" }
  | { type: "reload" }
  | { type: "weapon"; weapon: WeaponId }
  | { type: "team"; team: Team }
  | { type: "ready"; ready: boolean }
  | { type: "buy"; item: BuyItemId }
  | { type: "drop-device" }
  | { type: "start" }
  | { type: "leave" }
  | { type: "ping"; sentAt: number };

export type ServerEvent =
  | { type: "player-joined"; playerId: string; name: string; team: Team }
  | { type: "player-left"; playerId: string; name: string }
  | { type: "shot"; playerId: string; weapon: WeaponId; start: PlayerPosition; end: PlayerPosition; hitPlayerId: string | null; headshot: boolean; spread: number; movementPenalty: number }
  | { type: "hit"; attackerId: string; targetId: string; damage: number; headshot: boolean }
  | { type: "kill"; killerId: string; victimId: string; weapon: WeaponId; headshot: boolean; assistIds: string[] }
  | { type: "round-end"; winner: Team | null; reason: string }
  | { type: "round-start"; round: number }
  | { type: "match-end"; winner: Team }
  | { type: "reload"; playerId: string; weapon: WeaponId }
  | { type: "weapon-switch"; playerId: string; weapon: WeaponId }
  | { type: "weapon-pickup"; playerId: string; weapon: WeaponId }
  | { type: "phase-change"; phase: Phase; seconds: number; message: string }
  | { type: "purchase"; playerId: string; item: BuyItemId; cost: number; money: number }
  | { type: "device"; action: "dropped" | "picked-up" | "plant-start" | "plant-cancel" | "planted" | "defuse-start" | "defuse-cancel" | "defused" | "exploded"; playerId: string | null; site: SiteId | null }
  | { type: "halftime"; round: number; attackingTeam: Team }
  | { type: "round-mvp"; playerId: string | null; impact: number };

export type ServerMessage =
  | { type: "welcome"; playerId: string; hostId: string | null; roomId: string; protocolVersion: string }
  | { type: "state"; state: GameState; serverTime: number }
  | { type: "event"; event: ServerEvent }
  | { type: "error"; message: string }
  | { type: "pong"; sentAt: number; serverTime: number };

export const EMPTY_INPUT: PlayerInput = {
  forward: false, backward: false, left: false, right: false,
  walk: false, crouch: false, jump: false, use: false, yaw: 0, pitch: 0,
};
