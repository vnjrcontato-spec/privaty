import type { WeaponId } from "./protocol.js";

export interface AccuracyInput {
  horizontalSpeed: number;
  grounded: boolean;
  crouching: boolean;
  weapon: WeaponId;
  burstShots: number;
}

export interface WeaponAccuracy {
  movementPenalty: number;
  baseSpread: number;
  finalSpread: number;
  airPenalty: number;
  burstPenalty: number;
}

interface WeaponAccuracyProfile {
  moveStartSpeed: number;
  fullMoveSpeed: number;
  movementSpread: number;
  airSpread: number;
  burstStep: number;
  burstMax: number;
  crouchMovementScale: number;
  crouchBaseScale: number;
}

const PROFILES: Record<WeaponId, WeaponAccuracyProfile> = {
  AR12: {
    moveStartSpeed: 0.72,
    fullMoveSpeed: 4.13,
    movementSpread: 0.036,
    airSpread: 0.045,
    burstStep: 0.0026,
    burstMax: 0.018,
    crouchMovementScale: 0.68,
    crouchBaseScale: 0.78,
  },
  V9: {
    moveStartSpeed: 0.62,
    fullMoveSpeed: 4.64,
    movementSpread: 0.026,
    airSpread: 0.034,
    burstStep: 0.0031,
    burstMax: 0.014,
    crouchMovementScale: 0.72,
    crouchBaseScale: 0.8,
  },
};

export function calculateWeaponAccuracy(input: AccuracyInput): WeaponAccuracy {
  const profile = PROFILES[input.weapon];
  const range = Math.max(0.001, profile.fullMoveSpeed - profile.moveStartSpeed);
  const progress = Math.max(0, Math.min(1, (input.horizontalSpeed - profile.moveStartSpeed) / range));
  const movementPenalty = progress * progress * (input.crouching ? profile.crouchMovementScale : 1);
  const baseSpread = (input.weapon === "AR12" ? 0.0018 : 0.0026) * (input.crouching ? profile.crouchBaseScale : 1);
  const movementSpread = profile.movementSpread * movementPenalty;
  const airPenalty = input.grounded ? 0 : profile.airSpread;
  const burstPenalty = Math.min(profile.burstMax, Math.max(0, input.burstShots - 1) * profile.burstStep);
  return {
    movementPenalty,
    baseSpread,
    finalSpread: baseSpread + movementSpread + airPenalty + burstPenalty,
    airPenalty,
    burstPenalty,
  };
}
