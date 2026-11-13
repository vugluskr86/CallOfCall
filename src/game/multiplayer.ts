import type { ClientMessage, RoomPlayer, ServerMessage } from "@contracts/multiplayer";

type Handlers = {
  [K in ServerMessage["type"]]?: (message: Extract<ServerMessage, { type: K }>) => void;
};

export class MultiplayerClient {
  private socket: WebSocket | null = null;
  private pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
  readonly handlers: Handlers = {};
  players: RoomPlayer[] = [];
  id = "";
  hostId = "";
  code = "";
  active = false;
  started = false;

  get isHost(): boolean { return this.active && this.id === this.hostId; }
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  async create(name: string): Promise<void> { return this.connect({ type: "create", name }); }
  async join(code: string, name: string): Promise<void> { return this.connect({ type: "join", code: code.trim().toUpperCase(), name }); }

  private connect(message: ClientMessage): Promise<void> {
    this.leave();
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      return Promise.reject(new Error("Для сетевой игры нужен HTTPS или localhost"));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      this.socket = socket;
      const timeout = window.setTimeout(() => {
        if (!this.pending) return;
        this.pending = null; socket.close(); reject(new Error("Сервер не отвечает. Попробуйте ещё раз."));
      }, 8000);
      socket.onopen = () => socket.send(JSON.stringify(message));
      socket.onmessage = (event) => {
        let data: ServerMessage;
        try { data = JSON.parse(String(event.data)) as ServerMessage; } catch { return; }
        if (data.type === "welcome") {
          window.clearTimeout(timeout);
          this.active = true; this.id = data.id; this.hostId = data.hostId; this.code = data.code;
          this.started = data.started; this.players = data.players;
          this.pending?.resolve(); this.pending = null;
        } else if (data.type === "players") {
          this.hostId = data.hostId; this.started = data.started; this.players = data.players;
        } else if (data.type === "start") this.started = true;
        if (data.type === "error" && this.pending) {
          window.clearTimeout(timeout); const rejectPending = this.pending.reject; this.pending = null;
          rejectPending(new Error(data.message)); socket.close();
        }
        this.handlers[data.type]?.(data as never);
      };
      socket.onerror = () => {
        if (this.pending) {
          window.clearTimeout(timeout); this.pending.reject(new Error("Не удалось подключиться к серверу")); this.pending = null;
        }
      };
      socket.onclose = () => {
        window.clearTimeout(timeout);
        if (this.pending) { this.pending.reject(new Error("Соединение закрыто")); this.pending = null; }
        const wasActive = this.active;
        this.active = false; this.started = false; this.players = [];
        if (wasActive) this.handlers.roomClosed?.({ type: "roomClosed", reason: "Соединение с сервером потеряно" });
      };
    });
  }

  send(message: ClientMessage): void {
    if (this.connected) this.socket?.send(JSON.stringify(message));
  }

  leave(): void {
    const socket = this.socket;
    this.socket = null; this.active = false; this.started = false;
    this.id = ""; this.hostId = ""; this.code = ""; this.players = [];
    if (socket) {
      socket.onclose = null; socket.onmessage = null; socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
  }
}
