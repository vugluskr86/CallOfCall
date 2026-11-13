import type { EnemyKind, WeaponId } from "../src/game/config";

export const MAX_ROOM_PLAYERS = 4;
export const ROOM_CODE_LENGTH = 5;

export interface Vec3Data { x: number; y: number; z: number }
export interface RoomPlayer { id: string; name: string }
export interface PlayerState {
  id: string;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  weapon: WeaponId;
  hp: number;
  dead: boolean;
}
export interface EnemyState {
  id: number; kind: EnemyKind;
  x: number; y: number; z: number; yaw: number;
  hp: number; maxHp: number;
}
export interface DropState {
  id: number; kind: "ammo" | "weapon"; weapon: WeaponId;
  x: number; z: number;
}
export interface WorldSnapshot {
  wave: number; toSpawn: number; between: boolean; breakTimer: number;
  kills: number; score: number;
  enemies: EnemyState[];
  drops: DropState[];
}

export type ClientMessage =
  | { type: "create"; name: string }
  | { type: "join"; code: string; name: string }
  | { type: "start" }
  | { type: "state"; state: PlayerState }
  | { type: "world"; snapshot: WorldSnapshot }
  | { type: "hit"; enemyId: number; damage: number; headshot: boolean }
  | { type: "pickup"; dropId: number }
  | { type: "pickupGrant"; targetId: string; weapon: WeaponId; kind: "ammo" | "weapon" }
  | { type: "damage"; targetId: string; amount: number }
  | { type: "enemyShot"; origin: Vec3Data; direction: Vec3Data; speed: number; damage: number }
  | { type: "playerShot"; origin: Vec3Data; weapon: WeaponId }
  | { type: "barrel"; index: number }
  | { type: "end"; victory: boolean };

export type ServerMessage =
  | { type: "welcome"; id: string; code: string; hostId: string; started: boolean; players: RoomPlayer[] }
  | { type: "players"; hostId: string; started: boolean; players: RoomPlayer[] }
  | { type: "start" }
  | { type: "state"; state: PlayerState }
  | { type: "world"; snapshot: WorldSnapshot }
  | { type: "hit"; enemyId: number; damage: number; headshot: boolean }
  | { type: "pickupRequest"; dropId: number; playerId: string }
  | { type: "pickup"; weapon: WeaponId; kind: "ammo" | "weapon" }
  | { type: "damage"; amount: number }
  | { type: "enemyShot"; origin: Vec3Data; direction: Vec3Data; speed: number; damage: number }
  | { type: "playerShot"; id: string; origin: Vec3Data; weapon: WeaponId }
  | { type: "barrel"; index: number }
  | { type: "end"; victory: boolean }
  | { type: "error"; message: string }
  | { type: "roomClosed"; reason: string };
