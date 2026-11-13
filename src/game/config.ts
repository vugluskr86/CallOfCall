export const INPUT_CONFIG = {
  MOUSE_SENS_X: 0.0022,
  MOUSE_SENS_Y: 0.0022,
  INVERT_X: false,
  INVERT_Y: false,
} as const;

export const GAME = {
  WORLD: 36,
  FIXED_DT: 1 / 60,
  MAX_WAVE: 5,
  MAX_ACTIVE_ENEMIES: 16,
  MAX_BULLETS: 72,
  MAX_DROPS: 32,
  MAX_PARTICLES: 260,
  GRAVITY: 22,
  PLAYER_RADIUS: 0.35,
  PLAYER_HALF: 0.5,
  EYE_OFFSET: 0.45,
} as const;

export type WeaponId = "pistol" | "rifle" | "lmg";

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  short: string;
  damage: number;
  mag: number;
  startReserve: number;
  maxReserve: number;
  interval: number;
  reload: number;
  spread: number;
  recoil: number;
  auto: boolean;
  moveScale: number;
  color: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  pistol: {
    id: "pistol", name: "ПИСТОЛЕТ P-12", short: "P-12", damage: 38, mag: 12,
    startReserve: 72, maxReserve: 144, interval: 0.24, reload: 1.05,
    spread: 0.002, recoil: 0.026, auto: false, moveScale: 1, color: 0x58d8e8,
  },
  rifle: {
    id: "rifle", name: "АВТОМАТ AR-30", short: "AR-30", damage: 24, mag: 30,
    startReserve: 120, maxReserve: 240, interval: 0.095, reload: 1.55,
    spread: 0.006, recoil: 0.017, auto: true, moveScale: 0.96, color: 0xffc857,
  },
  lmg: {
    id: "lmg", name: "ПУЛЕМЁТ M-60", short: "M-60", damage: 20, mag: 60,
    startReserve: 180, maxReserve: 360, interval: 0.072, reload: 2.65,
    spread: 0.012, recoil: 0.013, auto: true, moveScale: 0.86, color: 0xff785a,
  },
};

export type EnemyKind = "grunt" | "runner" | "heavy";

export const ENEMIES = {
  grunt: { hp: 82, speed: 2.35, range: 9.5, fireRate: 1.3, damage: 8, bulletSpeed: 30, score: 100 },
  runner: { hp: 58, speed: 3.35, range: 6.8, fireRate: 0.9, damage: 6, bulletSpeed: 32, score: 140 },
  heavy: { hp: 190, speed: 1.55, range: 11.5, fireRate: 1.75, damage: 13, bulletSpeed: 27, score: 240 },
} as const;

export const QUALITY = {
  PARTICLES_HIGH: 260,
  PARTICLES_LOW: 100,
  DEGRADE_FPS: 45,
} as const;
