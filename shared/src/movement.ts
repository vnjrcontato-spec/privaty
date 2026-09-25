import type { PlayerInput, PlayerPosition } from "./protocol.js";

export const MAP_HALF_SIZE = 25;
export const PLAYER_RADIUS = 0.48;
export const COLLIDERS = [
  { minX: -5.8, maxX: -1.8, minZ: -3.4, maxZ: 3.4 },
  { minX: 2.0, maxX: 6.2, minZ: 4.7, maxZ: 8.7 },
  { minX: -14.0, maxX: -10.0, minZ: 8.0, maxZ: 11.6 },
  { minX: 10.0, maxX: 15.0, minZ: -9.0, maxZ: -6.0 },
  { minX: -11.0, maxX: -6.0, minZ: -15.0, maxZ: -12.0 },
  { minX: 11.0, maxX: 15.0, minZ: 12.0, maxZ: 15.0 },
];

export interface MovementResult {
  position: PlayerPosition;
  velocityY: number;
  grounded: boolean;
}

function collides(x: number, z: number): boolean {
  for (const block of COLLIDERS) {
    const closestX = Math.max(block.minX, Math.min(x, block.maxX));
    const closestZ = Math.max(block.minZ, Math.min(z, block.maxZ));
    const dx = x - closestX;
    const dz = z - closestZ;
    if (dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

export function movePlayer(
  position: PlayerPosition,
  velocityY: number,
  grounded: boolean,
  input: PlayerInput,
  deltaSeconds: number,
): MovementResult {
  const dt = Math.min(deltaSeconds, 0.08);
  const forwardAxis = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
  const strafeAxis = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const magnitude = Math.hypot(forwardAxis, strafeAxis) || 1;
  const speed = input.crouch ? 2.1 : input.sprint ? 5.2 : 3.45;
  const forwardX = Math.sin(input.yaw);
  const forwardZ = -Math.cos(input.yaw);
  const rightX = Math.cos(input.yaw);
  const rightZ = Math.sin(input.yaw);
  const velocityX = ((forwardX * forwardAxis + rightX * strafeAxis) / magnitude) * speed;
  const velocityZ = ((forwardZ * forwardAxis + rightZ * strafeAxis) / magnitude) * speed;

  const next = { x: position.x, y: position.y, z: position.z };
  const tryX = Math.max(-MAP_HALF_SIZE + 1, Math.min(MAP_HALF_SIZE - 1, next.x + velocityX * dt));
  if (!collides(tryX, next.z)) next.x = tryX;
  const tryZ = Math.max(-MAP_HALF_SIZE + 1, Math.min(MAP_HALF_SIZE - 1, next.z + velocityZ * dt));
  if (!collides(next.x, tryZ)) next.z = tryZ;

  if (input.jump && grounded) {
    velocityY = 5.4;
    grounded = false;
  }
  if (!grounded) {
    velocityY -= 15.5 * dt;
    next.y += velocityY * dt;
    if (next.y <= 0) {
      next.y = 0;
      velocityY = 0;
      grounded = true;
    }
  }
  return { position: next, velocityY, grounded };
}

export function spawnPosition(team: "ALPHA" | "BRAVO", index: number): PlayerPosition {
  const offsetX = ((index % 3) - 1) * 1.6;
  const offsetZ = Math.floor(index / 3) * 1.5;
  return team === "ALPHA"
    ? { x: offsetX, y: 0, z: -16 + offsetZ }
    : { x: offsetX, y: 0, z: 16 - offsetZ };
}
