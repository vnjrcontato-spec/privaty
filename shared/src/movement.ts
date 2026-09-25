import type { PlayerInput, PlayerPosition, WeaponId } from "./protocol.js";

export const MAP_HALF_SIZE = 25;
export const PLAYER_RADIUS = 0.48;
export const BASE_RUN_SPEED = 4.3;
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
  velocityX: number;
  velocityZ: number;
  velocityY: number;
  grounded: boolean;
  jumpBufferSeconds: number;
  maxSpeed: number;
}

const WEAPON_SPEED: Record<WeaponId, number> = { AR12: 0.96, V9: 1.08 };

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

function approach(x: number, z: number, targetX: number, targetZ: number, amount: number): [number, number] {
  const dx = targetX - x;
  const dz = targetZ - z;
  const distance = Math.hypot(dx, dz);
  if (distance <= amount || distance === 0) return [targetX, targetZ];
  const scale = amount / distance;
  return [x + dx * scale, z + dz * scale];
}

export function movePlayer(
  position: PlayerPosition,
  velocityX: number,
  velocityZ: number,
  velocityY: number,
  grounded: boolean,
  jumpBufferSeconds: number,
  input: PlayerInput,
  deltaSeconds: number,
  weapon: WeaponId,
): MovementResult {
  const dt = Math.min(Math.max(deltaSeconds, 0), 0.05);
  const forwardAxis = Number(input.forward) - Number(input.backward);
  const strafeAxis = Number(input.right) - Number(input.left);
  const magnitude = Math.hypot(forwardAxis, strafeAxis);
  const hasDirection = magnitude > 0;
  const speedMode = input.crouch ? 1.65 : input.walk ? 2.25 : BASE_RUN_SPEED;
  const maxSpeed = speedMode * WEAPON_SPEED[weapon];
  const forwardX = Math.sin(input.yaw);
  const forwardZ = -Math.cos(input.yaw);
  const rightX = Math.cos(input.yaw);
  const rightZ = Math.sin(input.yaw);
  const desiredX = hasDirection ? ((forwardX * forwardAxis + rightX * strafeAxis) / magnitude) * maxSpeed : 0;
  const desiredZ = hasDirection ? ((forwardZ * forwardAxis + rightZ * strafeAxis) / magnitude) * maxSpeed : 0;

  if (hasDirection) {
    const reversing = velocityX * desiredX + velocityZ * desiredZ < 0;
    const acceleration = grounded ? (reversing ? 48 : 31) : 6;
    [velocityX, velocityZ] = approach(velocityX, velocityZ, desiredX, desiredZ, acceleration * dt);
    const speed = Math.hypot(velocityX, velocityZ);
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      velocityX *= scale;
      velocityZ *= scale;
    }
  } else if (grounded) {
    const friction = Math.max(0, 1 - 17 * dt);
    velocityX *= friction;
    velocityZ *= friction;
    if (Math.hypot(velocityX, velocityZ) < 0.035) {
      velocityX = 0;
      velocityZ = 0;
    }
  } else {
    const airDrag = Math.max(0, 1 - 0.22 * dt);
    velocityX *= airDrag;
    velocityZ *= airDrag;
  }

  const next = { x: position.x, y: position.y, z: position.z };
  const tryX = Math.max(-MAP_HALF_SIZE + 1, Math.min(MAP_HALF_SIZE - 1, next.x + velocityX * dt));
  if (!collides(tryX, next.z)) next.x = tryX;
  else velocityX = 0;
  const tryZ = Math.max(-MAP_HALF_SIZE + 1, Math.min(MAP_HALF_SIZE - 1, next.z + velocityZ * dt));
  if (!collides(next.x, tryZ)) next.z = tryZ;
  else velocityZ = 0;

  jumpBufferSeconds = input.jump ? 0.12 : Math.max(0, jumpBufferSeconds - dt);
  if (jumpBufferSeconds > 0 && grounded) {
    velocityY = 5.35;
    grounded = false;
    jumpBufferSeconds = 0;
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
  return { position: next, velocityX, velocityZ, velocityY, grounded, jumpBufferSeconds, maxSpeed };
}

export function spawnPosition(team: "ALPHA" | "BRAVO", index: number): PlayerPosition {
  const offsetX = ((index % 3) - 1) * 1.6;
  const offsetZ = Math.floor(index / 3) * 1.5;
  return team === "ALPHA"
    ? { x: offsetX, y: 0, z: -16 + offsetZ }
    : { x: offsetX, y: 0, z: 16 - offsetZ };
}
