export const PROTOCOL_VERSION = "SP-1";
export const SERVER_NAME = "STRIKEPOINT LOCAL";
export const MAX_PLAYERS = 10;
export const SERVER_TICK_RATE = 20;
export const ROUND_LENGTH_SECONDS = 90;
export const ROUNDS_TO_WIN = 8;
export const MAP_NAME = "IRON YARD";

export type Team = "ALPHA" | "BRAVO";
export type Phase = "WAITING" | "ROUND_ACTIVE" | "ROUND_END" | "MATCH_END";
export type WeaponId = "AR12" | "V9";

export interface PlayerInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  yaw: number;
  pitch: number;
}

export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
}

export interface WeaponAmmo {
  magazine: number;
  reserve: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  team: Team;
  x: number;
  y: number;
  z: number;
  yaw: number;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
  weapon: WeaponId;
  magazine: number;
  reserve: number;
  crouching: boolean;
  host: boolean;
}

export interface GameState {
  phase: Phase;
  round: number;
  secondsLeft: number;
  score: Record<Team, number>;
  hostId: string | null;
  roomId: string;
  serverName: string;
  map: string;
  maxPlayers: number;
  players: PublicPlayer[];
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
  | { type: "start" }
  | { type: "leave" }
  | { type: "ping"; sentAt: number };

export type ServerEvent =
  | { type: "player-joined"; playerId: string; name: string; team: Team }
  | { type: "player-left"; playerId: string; name: string }
  | { type: "shot"; playerId: string; weapon: WeaponId; start: PlayerPosition; end: PlayerPosition; hitPlayerId: string | null; headshot: boolean }
  | { type: "hit"; attackerId: string; targetId: string; damage: number; headshot: boolean }
  | { type: "kill"; killerId: string; victimId: string; weapon: WeaponId }
  | { type: "round-end"; winner: Team | null; reason: string }
  | { type: "round-start"; round: number }
  | { type: "match-end"; winner: Team }
  | { type: "reload"; playerId: string; weapon: WeaponId }
  | { type: "weapon-switch"; playerId: string; weapon: WeaponId };

export type ServerMessage =
  | { type: "welcome"; playerId: string; hostId: string | null; roomId: string; protocolVersion: string }
  | { type: "state"; state: GameState; serverTime: number }
  | { type: "event"; event: ServerEvent }
  | { type: "error"; message: string }
  | { type: "pong"; sentAt: number; serverTime: number };

export const EMPTY_INPUT: PlayerInput = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  sprint: false,
  crouch: false,
  jump: false,
  yaw: 0,
  pitch: 0,
};
