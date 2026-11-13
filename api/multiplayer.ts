import type { Server as HttpServer } from "node:http";
import type { ServerType } from "@hono/node-server";
import { randomInt, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  MAX_ROOM_PLAYERS,
  ROOM_CODE_LENGTH,
  type ClientMessage,
  type RoomPlayer,
  type ServerMessage,
  type WorldSnapshot,
} from "@contracts/multiplayer";
import { log } from "./lib/logger";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const vec3 = z.object({ x: z.number().finite().min(-200).max(200), y: z.number().finite().min(-200).max(200), z: z.number().finite().min(-200).max(200) });
const weapon = z.enum(["pistol", "rifle", "lmg"]);
const enemyKind = z.enum(["grunt", "runner", "heavy"]);
const playerState = z.object({
  id: z.string(), x: z.number().finite().min(-100).max(100), y: z.number().finite().min(-20).max(100), z: z.number().finite().min(-100).max(100),
  yaw: z.number().finite().min(-10000).max(10000), pitch: z.number().finite().min(-2).max(2), weapon,
  hp: z.number().finite().min(0).max(100), dead: z.boolean(),
});
const worldSnapshot = z.object({
  wave: z.number().int().min(0).max(5), toSpawn: z.number().int().min(0).max(100), between: z.boolean(), breakTimer: z.number().finite().min(-10).max(20),
  kills: z.number().int().min(0).max(100000), score: z.number().int().min(0).max(100000000),
  enemies: z.array(z.object({ id: z.number().int().positive(), kind: enemyKind, x: z.number().finite().min(-100).max(100), y: z.number().finite().min(-20).max(100), z: z.number().finite().min(-100).max(100), yaw: z.number().finite(), hp: z.number().finite().min(0).max(10000), maxHp: z.number().finite().positive().max(10000) })).max(32),
  drops: z.array(z.object({ id: z.number().int().positive(), kind: z.enum(["ammo", "weapon"]), weapon, x: z.number().finite().min(-100).max(100), z: z.number().finite().min(-100).max(100) })).max(24),
});
const createSchema = z.object({ type: z.literal("create"), name: z.string().trim().min(1).max(16) });
const joinSchema = z.object({ type: z.literal("join"), code: z.string().trim().toUpperCase().length(ROOM_CODE_LENGTH), name: z.string().trim().min(1).max(16) });
const numberSchema = z.number().finite().min(0).max(10000);

interface Client { id: string; name: string; socket: WebSocket; room?: Room; lastStateAt: number; lastWorldAt: number }
interface Room { code: string; hostId: string; started: boolean; clients: Map<string, Client>; lastWorld?: WorldSnapshot }

const rooms = new Map<string, Room>();
const clients = new Set<WebSocket>();

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function broadcast(room: Room, message: ServerMessage, exceptId?: string): void {
  const data = JSON.stringify(message);
  for (const client of room.clients.values()) {
    if (client.id !== exceptId && client.socket.readyState === WebSocket.OPEN) client.socket.send(data);
  }
}
function players(room: Room): RoomPlayer[] {
  return [...room.clients.values()].map(({ id, name }) => ({ id, name }));
}
function roomUpdate(room: Room): void {
  broadcast(room, { type: "players", hostId: room.hostId, started: room.started, players: players(room) });
}
function createCode(): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to allocate room code");
}
function leave(client: Client, socket: WebSocket): void {
  clients.delete(socket);
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  client.room = undefined;
  if (room.clients.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === client.id) {
    broadcast(room, { type: "roomClosed", reason: "Создатель комнаты отключился. Создайте новую комнату." });
    for (const other of room.clients.values()) { other.room = undefined; other.socket.close(1000, "Host left"); }
    rooms.delete(room.code);
    return;
  }
  roomUpdate(room);
}

function handleMessage(client: Client, raw: string): void {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return; }
  const parsed = z.object({ type: z.string() }).safeParse(data);
  if (!parsed.success) return;
  const message = data as ClientMessage;
  const room = client.room;
  const hostOnly = (): boolean => Boolean(room && room.hostId === client.id);

  if (message.type === "create") {
    if (room) return;
    const valid = createSchema.safeParse(data);
    if (!valid.success) { send(client.socket, { type: "error", message: "Введите имя от 1 до 16 символов" }); return; }
    client.name = valid.data.name;
    const code = createCode();
    const created: Room = { code, hostId: client.id, started: false, clients: new Map([[client.id, client]]) };
    rooms.set(code, created); client.room = created;
    send(client.socket, { type: "welcome", id: client.id, code, hostId: client.id, started: false, players: players(created) });
    roomUpdate(created);
    return;
  }
  if (message.type === "join") {
    if (room) return;
    const valid = joinSchema.safeParse(data);
    if (!valid.success) { send(client.socket, { type: "error", message: "Проверьте имя и код комнаты" }); return; }
    const joined = rooms.get(valid.data.code);
    if (!joined) { send(client.socket, { type: "error", message: "Комната не найдена" }); return; }
    if (joined.clients.size >= MAX_ROOM_PLAYERS) { send(client.socket, { type: "error", message: "В комнате уже 4 игрока" }); return; }
    client.name = valid.data.name; client.room = joined; joined.clients.set(client.id, client);
    send(client.socket, { type: "welcome", id: client.id, code: joined.code, hostId: joined.hostId, started: joined.started, players: players(joined) });
    if (joined.started && joined.lastWorld) send(client.socket, { type: "world", snapshot: joined.lastWorld });
    roomUpdate(joined);
    return;
  }
  if (!room) return;

  switch (message.type) {
    case "start": {
      if (!hostOnly()) return;
      room.started = true; room.lastWorld = undefined;
      broadcast(room, { type: "start" }); roomUpdate(room);
      break;
    }
    case "state": {
      const valid = playerState.safeParse(message.state);
      if (!valid.success || valid.data.id !== client.id) return;
      const now = Date.now(); if (now - client.lastStateAt < 25) return; client.lastStateAt = now;
      broadcast(room, { type: "state", state: valid.data }, client.id);
      break;
    }
    case "world": {
      if (!hostOnly()) return;
      const valid = worldSnapshot.safeParse(message.snapshot); if (!valid.success) return;
      const now = Date.now(); if (now - client.lastWorldAt < 45) return; client.lastWorldAt = now;
      room.lastWorld = valid.data;
      broadcast(room, { type: "world", snapshot: valid.data }, client.id);
      break;
    }
    case "hit": {
      if (!Number.isInteger(message.enemyId) || !numberSchema.safeParse(message.damage).success) return;
      const host = room.clients.get(room.hostId); if (host) send(host.socket, { type: "hit", enemyId: message.enemyId, damage: Math.min(message.damage, 100), headshot: Boolean(message.headshot) });
      break;
    }
    case "pickup": {
      if (!Number.isInteger(message.dropId)) return;
      const host = room.clients.get(room.hostId); if (host) send(host.socket, { type: "pickupRequest", dropId: message.dropId, playerId: client.id });
      break;
    }
    case "pickupGrant": {
      if (!hostOnly() || !weapon.safeParse(message.weapon).success || !["ammo", "weapon"].includes(message.kind)) return;
      const target = room.clients.get(message.targetId);
      if (target) send(target.socket, { type: "pickup", weapon: message.weapon, kind: message.kind });
      break;
    }
    case "damage": {
      if (!hostOnly() || !numberSchema.safeParse(message.amount).success) return;
      const target = room.clients.get(message.targetId); if (target) send(target.socket, { type: "damage", amount: Math.min(message.amount, 100) });
      break;
    }
    case "enemyShot": {
      if (!hostOnly() || !vec3.safeParse(message.origin).success || !vec3.safeParse(message.direction).success) return;
      if (!numberSchema.safeParse(message.speed).success || !numberSchema.safeParse(message.damage).success) return;
      broadcast(room, { type: "enemyShot", origin: message.origin, direction: message.direction, speed: Math.min(message.speed, 100), damage: Math.min(message.damage, 100) }, client.id);
      break;
    }
    case "playerShot": {
      if (!vec3.safeParse(message.origin).success || !weapon.safeParse(message.weapon).success) return;
      broadcast(room, { type: "playerShot", id: client.id, origin: message.origin, weapon: message.weapon }, client.id);
      break;
    }
    case "barrel": {
      if (!Number.isInteger(message.index) || message.index < 0 || message.index > 20) return;
      if (hostOnly()) broadcast(room, { type: "barrel", index: message.index }, client.id);
      else { const host = room.clients.get(room.hostId); if (host) send(host.socket, { type: "barrel", index: message.index }); }
      break;
    }
    case "end": {
      if (!hostOnly()) return;
      broadcast(room, { type: "end", victory: Boolean(message.victory) }, client.id);
      break;
    }
  }
}

export function createMultiplayerWebSocketServer(options?: { port?: number; noServer?: boolean }): WebSocketServer {
  const wss = new WebSocketServer({ ...options, maxPayload: 64 * 1024 });
  wss.on("connection", (socket) => {
    const client: Client = { id: randomUUID(), name: "Боец", socket, lastStateAt: 0, lastWorldAt: 0 };
    clients.add(socket);
    socket.on("message", (data) => {
      if (typeof data.toString() !== "string") return;
      try { handleMessage(client, data.toString()); } catch (error) { log.error("multiplayer message error", { error: error instanceof Error ? error.message : String(error) }); }
    });
    socket.on("close", () => leave(client, socket));
    socket.on("error", () => leave(client, socket));
  });
  const heartbeat = setInterval(() => {
    for (const socket of clients) if (socket.readyState === WebSocket.CLOSED) clients.delete(socket);
  }, 30000);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}

export function attachMultiplayer(server: ServerType): void {
  const httpServer = server as unknown as HttpServer;
  const wss = createMultiplayerWebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
}

export function startStandaloneMultiplayer(port: number): void {
  const wss = createMultiplayerWebSocketServer({ port });
  wss.on("listening", () => log.info(`Multiplayer WebSocket listening on port ${port}`));
  wss.on("error", (error) => log.error("multiplayer websocket error", { error: error.message }));
}
