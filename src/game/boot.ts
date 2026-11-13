import RAPIER from "@dimforge/rapier3d-compat";
import { ArenaGame } from "./arena";
import type { EnemyKind, WeaponId } from "./config";

declare global {
  interface Window {
    __gameProbe?: () => { x: number; y: number; z: number };
    __GAME_READY__?: boolean;
    __gameDebug?: {
      start: () => void;
      snapshot: () => Record<string, unknown>;
      giveWeapons: () => void;
      spawnEnemy: (kind?: EnemyKind) => number;
      readyEnemies: () => void;
      spawnDrop: (weapon?: WeaponId, kind?: "ammo" | "weapon") => void;
      killAll: () => void;
      damagePlayer: (amount: number) => void;
      teleport: (x: number, z: number) => void;
      shootAt: (enemyId: number) => void;
      win: () => void;
    };
  }
}

let session: ArenaGame | null = null;
let bootId = 0;

export async function startGame(canvas: HTMLCanvasElement): Promise<void> {
  stopGame();
  const id = ++bootId;
  await RAPIER.init();
  if (id !== bootId) return;
  session = new ArenaGame(canvas);
}

export function stopGame(): void {
  bootId++;
  session?.dispose();
  session = null;
}
