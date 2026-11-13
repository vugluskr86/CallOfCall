import * as THREE from "three";
import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody, type World } from "@dimforge/rapier3d-compat";
import { GameLoop } from "./engine";
import { Input } from "./input";
import { AudioSystem } from "./audio";
import { storage } from "./storage";
import { ENEMIES, GAME, WEAPONS, type EnemyKind, type WeaponId } from "./config";
import { createTextureSet, mulberry32, type Random, type TextureSet } from "./procedural";
import { createAmmoModel, createDropBeacon, createEnemyModel, createPlayerModel, createWeaponModel, type EnemyVisual, type WeaponVisual } from "./models";
import { ParticleSystem } from "./effects";
import { MultiplayerClient } from "./multiplayer";
import type { EnemyState, PlayerState, WorldSnapshot } from "@contracts/multiplayer";

type Mode = "title" | "playing" | "paused" | "gameover" | "victory";

interface Prop {
  mesh: THREE.Object3D;
  body: RigidBody;
  initial: { x: number; y: number; z: number };
  exploded?: boolean;
}

interface Enemy {
  id: number;
  kind: EnemyKind;
  vis: EnemyVisual;
  mesh: THREE.Group;
  rb: RigidBody;
  col: Collider;
  kcc: KinematicCharacterController;
  hp: number;
  maxHp: number;
  speed: number;
  range: number;
  fireRate: number;
  damage: number;
  bulletSpeed: number;
  fireTimer: number;
  vy: number;
  grounded: boolean;
  knockback: THREE.Vector3;
  strafeSign: number;
  stuckTime: number;
  lastPos: THREE.Vector3;
  avoidTimer: number;
  walkPhase: number;
  hitFlash: number;
  muzzleTimer: number;
  alive: boolean;
  netPos?: THREE.Vector3;
  netYaw?: number;
}

interface RemotePlayer {
  id: string;
  name: string;
  vis: EnemyVisual;
  mesh: THREE.Group;
  label: THREE.Sprite;
  targetPos: THREE.Vector3;
  lastPos: THREE.Vector3;
  targetYaw: number;
  targetPitch: number;
  hp: number;
  dead: boolean;
  weapon: WeaponId;
  walkPhase: number;
  muzzleTimer: number;
}

interface Bullet {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  active: boolean;
}

interface Drop {
  id: number;
  kind: "ammo" | "weapon";
  weapon: WeaponId;
  mesh: THREE.Group;
  life: number;
  phase: number;
  active: boolean;
}

interface InventoryItem { owned: boolean; ammo: number; reserve: number }
interface RagdollPart { mesh: THREE.Mesh; body: RigidBody }

const ENEMY_RADIUS = 0.36;
const ENEMY_HALF = 0.56;
const ENEMY_CENTER = ENEMY_RADIUS + ENEMY_HALF;
const PLAYER_CENTER = GAME.PLAYER_RADIUS + GAME.PLAYER_HALF;
const CENTER_SCREEN = new THREE.Vector2(0, 0);

export class ArenaGame {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly input: Input;
  private readonly audio = new AudioSystem();
  private readonly loop: GameLoop;
  private readonly rng: Random = mulberry32(0x51a7c3);
  private readonly textures: TextureSet;
  private readonly particles = new ParticleSystem();
  private readonly net = new MultiplayerClient();
  private readonly remotePlayers = new Map<string, RemotePlayer>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly enemies: Enemy[] = [];
  private readonly enemyColliders = new Set<Collider>();
  private readonly crates: Prop[] = [];
  private readonly barrels: Prop[] = [];
  private readonly staticTargets: THREE.Object3D[] = [];
  private readonly bullets: Bullet[] = [];
  private readonly drops: Drop[] = [];
  private readonly occupied: { x: number; z: number; r: number }[] = [];
  private readonly viewWeapons = new Map<WeaponId, WeaponVisual>();
  private readonly cleanup: Array<() => void> = [];
  private readonly inventory: Record<WeaponId, InventoryItem> = {
    pistol: { owned: true, ammo: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.startReserve },
    rifle: { owned: false, ammo: 0, reserve: 0 },
    lmg: { owned: false, ammo: 0, reserve: 0 },
  };

  private readonly playerBody: RigidBody;
  private readonly playerCollider: Collider;
  private readonly playerController: KinematicCharacterController;
  private readonly floorMaterial: THREE.MeshStandardMaterial;
  private readonly wallMaterial: THREE.MeshStandardMaterial;
  private readonly metalMaterial: THREE.MeshStandardMaterial;
  private readonly barrelMaterial: THREE.MeshStandardMaterial;
  private readonly muzzleLight = new THREE.PointLight(0xffb347, 0, 4, 2);
  private readonly muzzleFlash: THREE.Mesh;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpD = new THREE.Vector3();
  private readonly toPlayer = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly ragdoll: RagdollPart[] = [];

  private mode: Mode = "title";
  private currentWeapon: WeaponId = "pistol";
  private yaw = 0;
  private pitch = 0;
  private vy = 0;
  private onGround = false;
  private mouseDown = false;
  private wasPointerLocked = false;
  private hp = 100;
  private kills = 0;
  private score = 0;
  private best = storage.get<number>("arenaBest", 0);
  private fireCooldown = 0;
  private reloading = false;
  private reloadT = 0;
  private recoil = 0;
  private bobTime = 0;
  private muzzleTimer = 0;
  private hitTimer = 0;
  private headshotTimer = 0;
  private damageOpacity = 0;
  private messageTimer = 0;
  private titleTime = 0;
  private nearestDrop: Drop | null = null;
  private enemyId = 0;
  private dropId = 0;
  private networkTimer = 0;
  private worldTimer = 0;
  private multiplayerDead = false;
  private shotsFired = 0;
  private enemyShots = 0;
  private playerHits = 0;
  private fps = 60;
  private frameCount = 0;
  private frameTime = 0;
  private lastRenderTime = performance.now();
  private disposed = false;
  private wave = { number: 0, toSpawn: 0, spawnTimer: 0, between: false, breakTimer: 0 };

  private readonly el = {
    hud: this.getEl("hud"), menu: this.getEl("menu-overlay"), title: this.getEl("menu-title"),
    description: this.getEl("menu-description"), stats: this.getEl("menu-stats"), controls: this.getEl("menu-controls"),
    primary: this.getEl("primary-button") as HTMLButtonElement, secondary: this.getEl("secondary-button") as HTMLButtonElement,
    footnote: this.getEl("menu-footnote"), wave: this.getEl("wave-label"), enemyCount: this.getEl("enemy-count"),
    score: this.getEl("score-label"), hp: this.getEl("health-value"), hpFill: this.getEl("health-fill"),
    kills: this.getEl("kill-label"), weapon: this.getEl("weapon-name"), mag: this.getEl("ammo-mag"),
    reserve: this.getEl("ammo-reserve"), mode: this.getEl("fire-mode"), mute: this.getEl("mute-button") as HTMLButtonElement,
    crosshair: this.getEl("crosshair"), hitmarker: this.getEl("hitmarker"), message: this.getEl("message"),
    pickup: this.getEl("pickup-prompt"), reload: this.getEl("reload-bar"), reloadFill: this.getEl("reload-fill"),
    damage: this.getEl("damage-vignette"),
    setup: this.getEl("multiplayer-setup"), lobby: this.getEl("lobby-panel"),
    playerName: this.getEl("player-name") as HTMLInputElement, roomInput: this.getEl("room-code-input") as HTMLInputElement,
    createRoom: this.getEl("create-room-button") as HTMLButtonElement, joinRoom: this.getEl("join-room-button") as HTMLButtonElement,
    lobbyCode: this.getEl("lobby-code"), lobbyPlayers: this.getEl("lobby-players"), copyCode: this.getEl("copy-room-code") as HTMLButtonElement,
    networkStatus: this.getEl("network-status"), roomHud: this.getEl("room-hud"), roomHudCode: this.getEl("room-hud-code"),
    roomHudPlayers: this.getEl("room-hud-players"), teamList: this.getEl("team-list"),
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.scene.background = new THREE.Color(0x0a1820);
    this.scene.fog = new THREE.Fog(0x0a1820, 28, 82);
    this.camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
    this.scene.add(this.camera);
    this.world = new RAPIER.World({ x: 0, y: -GAME.GRAVITY, z: 0 });
    this.world.timestep = GAME.FIXED_DT;
    this.input = new Input(canvas);
    this.textures = createTextureSet(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.textures.floor.repeat.set(18, 18);
    this.textures.wall.repeat.set(2, 2);
    this.floorMaterial = new THREE.MeshStandardMaterial({ map: this.textures.floor, roughness: 0.92, metalness: 0.08 });
    this.wallMaterial = new THREE.MeshStandardMaterial({ map: this.textures.wall, roughness: 0.84, metalness: 0.08 });
    this.metalMaterial = new THREE.MeshStandardMaterial({ map: this.textures.metal, roughness: 0.55, metalness: 0.58 });
    this.barrelMaterial = new THREE.MeshStandardMaterial({ map: this.textures.metal, color: 0xb85c36, roughness: 0.46, metalness: 0.62, emissive: 0x2b0d05, emissiveIntensity: 0.35 });

    this.setupLights();
    this.buildArena();
    this.scene.add(this.particles.points);
    this.playerBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PLAYER_CENTER + 0.02, 8));
    this.playerCollider = this.world.createCollider(RAPIER.ColliderDesc.capsule(GAME.PLAYER_HALF, GAME.PLAYER_RADIUS), this.playerBody);
    this.playerController = this.makeCharacterController(0.05);
    this.muzzleFlash = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0.95 }));
    this.muzzleFlash.visible = false;
    this.switchWeapon("pistol", true);
    this.createBulletPool();
    this.bindEvents();
    this.bindMultiplayer();
    this.updateHUD();
    this.el.mute.textContent = this.audio.muted ? "ЗВУК: ВЫКЛ" : "ЗВУК: ВКЛ";
    this.showTitle();

    this.loop = new GameLoop({ update: (dt) => this.update(dt), render: () => this.render() });
    this.loop.start();
    this.installProbes();
  }

  private getEl(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing UI element #${id}`);
    return el;
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xa9d7dc, 0x14242a, 1.35));
    const sun = new THREE.DirectionalLight(0xffe4bd, 2.5);
    sun.position.set(18, 30, 12); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -42; sun.shadow.camera.right = 42;
    sun.shadow.camera.top = 42; sun.shadow.camera.bottom = -42;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.00035;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x4a9fb5, 1.1); rim.position.set(-20, 12, -18); this.scene.add(rim);
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const light = new THREE.PointLight(i === 1 ? 0xff9b55 : 0x51d9cb, 8, 18, 2);
      light.position.set(Math.cos(angle) * 19, 3.2, Math.sin(angle) * 19);
      this.scene.add(light);
    }
  }

  private makeCharacterController(offset: number): KinematicCharacterController {
    const controller = this.world.createCharacterController(offset);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.enableAutostep(0.35, 0.2, true);
    controller.enableSnapToGround(0.28);
    controller.setMaxSlopeClimbAngle(50 * Math.PI / 180);
    controller.setMinSlopeSlideAngle(32 * Math.PI / 180);
    controller.setApplyImpulsesToDynamicBodies(true);
    return controller;
  }

  private buildArena(): void {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(GAME.WORLD * 2, GAME.WORLD * 2), this.floorMaterial);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor); this.staticTargets.push(floor);
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(GAME.WORLD, 0.5, GAME.WORLD).setTranslation(0, -0.5, 0));
    this.addStaticBox(-GAME.WORLD, 0, 1, 6, GAME.WORLD * 2);
    this.addStaticBox(GAME.WORLD, 0, 1, 6, GAME.WORLD * 2);
    this.addStaticBox(0, -GAME.WORLD, GAME.WORLD * 2, 6, 1);
    this.addStaticBox(0, GAME.WORLD, GAME.WORLD * 2, 6, 1);

    const pillarGeo = new THREE.CylinderGeometry(0.78, 0.9, 5.4, 12);
    for (let i = 0; i < 10; i++) {
      const ring = i < 6 ? 16 : 25;
      const angle = (i % 6) / 6 * Math.PI * 2 + (i >= 6 ? 0.42 : 0);
      const x = Math.cos(angle) * ring, z = Math.sin(angle) * ring;
      const pillar = new THREE.Mesh(pillarGeo, this.wallMaterial);
      pillar.position.set(x, 2.7, z); pillar.castShadow = pillar.receiveShadow = true;
      this.scene.add(pillar); this.staticTargets.push(pillar);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 2.7, z));
      this.world.createCollider(RAPIER.ColliderDesc.cylinder(2.7, 0.86), body);
      this.occupied.push({ x, z, r: 1.5 });
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.91, 0.045, 5, 16), new THREE.MeshBasicMaterial({ color: i % 2 ? 0x57c8bb : 0xd8934e }));
      band.rotation.x = Math.PI / 2; band.position.set(x, 2.25, z); this.scene.add(band);
    }

    for (let i = 0; i < 6; i++) {
      const angle = i / 6 * Math.PI * 2 + Math.PI / 6;
      const x = Math.cos(angle) * 10.5, z = Math.sin(angle) * 10.5;
      const horizontal = i % 2 === 0;
      this.addStaticBox(x, z, horizontal ? 3.4 : 0.55, 1.15, horizontal ? 0.55 : 3.4);
      this.occupied.push({ x, z, r: 2.2 });
    }

    for (let i = 0; i < 13; i++) {
      const p = this.findOpenPosition(3.8);
      const size = 1.15 + this.rng() * 0.85;
      const crate = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), this.metalMaterial.clone());
      (crate.material as THREE.MeshStandardMaterial).color.setHSL(0.52, 0.08, 0.68 + this.rng() * 0.12);
      crate.castShadow = crate.receiveShadow = true; this.scene.add(crate);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, size / 2 + 0.02, p.z).setLinearDamping(0.55).setAngularDamping(0.72).setCcdEnabled(true));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setDensity(0.75).setFriction(0.72).setRestitution(0.08), body);
      const prop: Prop = { mesh: crate, body, initial: { x: p.x, y: size / 2 + 0.02, z: p.z } };
      crate.userData.crateRef = prop; this.crates.push(prop);
      this.occupied.push({ x: p.x, z: p.z, r: size * 0.75 });
    }

    for (let i = 0; i < 10; i++) {
      const p = this.findOpenPosition(4.5);
      const group = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.49, 1.35, 12), this.barrelMaterial.clone());
      shell.castShadow = shell.receiveShadow = true; group.add(shell);
      for (const y of [-0.43, 0.43]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.045, 5, 12), this.metalMaterial);
        band.rotation.x = Math.PI / 2; band.position.y = y; group.add(band);
      }
      const warning = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.018), new THREE.MeshBasicMaterial({ color: 0xffc65c }));
      warning.position.set(0, 0, -0.475); warning.rotation.z = Math.PI / 4; group.add(warning);
      group.position.set(p.x, 0.7, p.z); this.scene.add(group);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, 0.7, p.z).setLinearDamping(0.58).setAngularDamping(0.7).setCcdEnabled(true));
      this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.68, 0.48).setDensity(1.1).setFriction(0.62).setRestitution(0.06), body);
      const prop: Prop = { mesh: group, body, initial: { x: p.x, y: 0.7, z: p.z }, exploded: false };
      group.traverse((obj) => { obj.userData.barrelRef = prop; });
      this.barrels.push(prop); this.occupied.push({ x: p.x, z: p.z, r: 0.9 });
    }
  }

  private addStaticBox(x: number, z: number, w: number, h: number, d: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.wallMaterial);
    m.position.set(x, h / 2, z); m.castShadow = m.receiveShadow = true;
    this.scene.add(m); this.staticTargets.push(m);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, h / 2, z));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), body);
    return m;
  }

  private findOpenPosition(playerClearance: number): { x: number; z: number } {
    for (let attempt = 0; attempt < 80; attempt++) {
      const x = (this.rng() - 0.5) * GAME.WORLD * 1.65;
      const z = (this.rng() - 0.5) * GAME.WORLD * 1.65;
      if (Math.hypot(x, z - 8) < playerClearance) continue;
      if (this.occupied.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + 1.3)) continue;
      return { x, z };
    }
    return { x: -GAME.WORLD + 4 + this.rng() * 3, z: -GAME.WORLD + 4 + this.rng() * 3 };
  }

  private listen<T extends Event>(target: Window | Document | HTMLElement, type: string, fn: (event: T) => void): void {
    const handler = fn as EventListener;
    target.addEventListener(type, handler);
    this.cleanup.push(() => target.removeEventListener(type, handler));
  }

  private bindEvents(): void {
    const resize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    };
    window.addEventListener("resize", resize);
    this.cleanup.push(() => window.removeEventListener("resize", resize));

    this.listen<MouseEvent>(this.canvas, "mousedown", (event) => {
      if (this.mode !== "playing" || event.button !== 0) return;
      if (document.pointerLockElement !== this.canvas) { this.requestLock(); return; }
      this.mouseDown = true;
      if (!WEAPONS[this.currentWeapon].auto) this.attemptShoot();
    });
    this.listen<MouseEvent>(window, "mouseup", (event) => { if (event.button === 0) this.mouseDown = false; });
    this.listen<MouseEvent>(this.canvas, "click", () => { if (this.mode === "playing") this.requestLock(); });
    this.listen<WheelEvent>(this.canvas, "wheel", (event) => {
      if (this.mode !== "playing") return;
      event.preventDefault();
      const order: WeaponId[] = ["pistol", "rifle", "lmg"];
      const owned = order.filter((id) => this.inventory[id].owned);
      const index = owned.indexOf(this.currentWeapon);
      const next = owned[(index + (event.deltaY > 0 ? 1 : owned.length - 1)) % owned.length];
      this.switchWeapon(next);
    });
    this.listen<MouseEvent>(this.canvas, "contextmenu", (event) => event.preventDefault());
    this.listen(this.el.primary, "click", () => {
      if (this.multiplayerDead) { this.respawnMultiplayer(); return; }
      if (this.mode === "paused") { this.resume(); return; }
      if (this.net.active) {
        if (this.net.isHost) this.net.send({ type: "start" });
        else this.el.networkStatus.textContent = "Только создатель комнаты может начать или перезапустить бой";
        return;
      }
      this.startRun(true);
    });
    this.listen(this.el.secondary, "click", () => {
      if (this.net.active) this.leaveMultiplayer(); else this.startRun(true);
    });
    this.listen(this.el.createRoom, "click", () => void this.createRoom());
    this.listen(this.el.joinRoom, "click", () => void this.joinRoom());
    this.listen<KeyboardEvent>(this.el.roomInput, "keydown", (event) => { if (event.key === "Enter") void this.joinRoom(); });
    this.listen(this.el.copyCode, "click", () => {
      if (!this.net.code) return;
      void navigator.clipboard?.writeText(this.net.code).then(() => { this.el.networkStatus.textContent = "Код скопирован"; }).catch(() => { this.el.networkStatus.textContent = `Код: ${this.net.code}`; });
    });
    this.listen(this.el.mute, "click", () => this.toggleMute());
    this.listen(document, "pointerlockchange", () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked) { this.wasPointerLocked = true; return; }
      this.mouseDown = false;
      if (this.wasPointerLocked && this.mode === "playing") this.pause();
    });
  }

  private toggleMute(): void {
    const muted = this.audio.toggleMute();
    this.el.mute.textContent = muted ? "ЗВУК: ВЫКЛ" : "ЗВУК: ВКЛ";
    this.el.mute.setAttribute("aria-label", muted ? "Включить звук" : "Выключить звук");
  }

  private requestLock(): void {
    if (document.pointerLockElement === this.canvas) return;
    try {
      const request = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (request?.catch) void request.catch(() => { /* keyboard play remains available */ });
    } catch { /* pointer lock is optional for automated/keyboard play */ }
  }

  private showTitle(): void {
    this.mode = "title";
    this.el.menu.classList.remove("hidden"); this.el.hud.classList.add("hidden");
    this.el.title.innerHTML = "БЛОЧНЫЙ<br><em>ШТУРМ</em>";
    this.el.description.textContent = "Пять волн. Три ствола. Ни одного лишнего патрона.";
    this.el.stats.classList.remove("hidden"); this.el.controls.classList.remove("hidden");
    this.el.primary.innerHTML = "НАЧАТЬ ШТУРМ <span>→</span>";
    this.el.primary.disabled = false; this.el.secondary.classList.add("hidden");
    this.el.setup.classList.remove("hidden"); this.el.lobby.classList.add("hidden");
    this.el.roomHud.classList.add("hidden"); this.el.teamList.classList.add("hidden");
    this.el.footnote.textContent = `SPACE — старт · M — звук · рекорд ${this.best.toString().padStart(6, "0")} · сохранение в этом браузере`;
    this.camera.position.set(12, 6.5, 17); this.camera.lookAt(0, 1, 0);
  }

  private async createRoom(): Promise<void> {
    this.el.createRoom.disabled = true; this.el.joinRoom.disabled = true;
    this.el.networkStatus.textContent = "ПОДКЛЮЧЕНИЕ К СЕРВЕРУ…";
    try { await this.net.create(this.el.playerName.value.trim() || "Боец"); this.showLobby(); }
    catch (error) { this.el.networkStatus.textContent = error instanceof Error ? error.message : "Ошибка подключения"; }
    finally { this.el.createRoom.disabled = false; this.el.joinRoom.disabled = false; }
  }

  private async joinRoom(): Promise<void> {
    if (this.el.roomInput.value.trim().length !== 5) { this.el.networkStatus.textContent = "Введите пятисимвольный код комнаты"; return; }
    this.el.createRoom.disabled = true; this.el.joinRoom.disabled = true;
    this.el.networkStatus.textContent = "ПОИСК КОМНАТЫ…";
    try {
      await this.net.join(this.el.roomInput.value, this.el.playerName.value.trim() || "Боец");
      if (this.net.started) this.beginMultiplayer(); else this.showLobby();
    } catch (error) { this.el.networkStatus.textContent = error instanceof Error ? error.message : "Ошибка подключения"; }
    finally { this.el.createRoom.disabled = false; this.el.joinRoom.disabled = false; }
  }

  private showLobby(): void {
    this.mode = "title"; this.el.menu.classList.remove("hidden"); this.el.hud.classList.add("hidden");
    this.el.title.innerHTML = "КОМНАТА<br><em>ГОТОВА</em>";
    this.el.description.textContent = this.net.isHost
      ? "Передайте код бойцам. Когда все подключатся, начните общий штурм."
      : "Вы в комнате. Создатель начнёт бой — оружие и патроны выдаются при старте.";
    this.el.stats.classList.add("hidden"); this.el.controls.classList.add("hidden");
    this.el.setup.classList.add("hidden"); this.el.lobby.classList.remove("hidden");
    this.el.primary.innerHTML = this.net.isHost ? "НАЧАТЬ КООПЕРАТИВ <span>→</span>" : "ОЖИДАНИЕ СОЗДАТЕЛЯ";
    this.el.primary.disabled = !this.net.isHost;
    this.el.secondary.textContent = "ПОКИНУТЬ КОМНАТУ"; this.el.secondary.classList.remove("hidden");
    this.el.footnote.textContent = "Без регистрации · до 4 игроков · комната закроется при выходе создателя";
    this.el.networkStatus.textContent = "";
    this.updateLobby();
  }

  private updateLobby(): void {
    if (!this.net.active) return;
    this.el.lobbyCode.textContent = this.net.code;
    this.el.lobbyPlayers.replaceChildren();
    for (const player of this.net.players) {
      const row = document.createElement("div"); row.className = "lobby-player";
      const name = document.createElement("span"); name.textContent = player.name;
      const role = document.createElement("small"); role.textContent = player.id === this.net.hostId ? "СОЗДАТЕЛЬ" : "ГОТОВ";
      row.append(name, role); this.el.lobbyPlayers.append(row);
    }
    if (this.mode === "title" && !this.el.lobby.classList.contains("hidden")) {
      this.el.primary.disabled = !this.net.isHost;
      this.el.primary.innerHTML = this.net.isHost ? "НАЧАТЬ КООПЕРАТИВ <span>→</span>" : "ОЖИДАНИЕ СОЗДАТЕЛЯ";
    }
  }

  private bindMultiplayer(): void {
    this.net.handlers.players = () => {
      const ids = new Set(this.net.players.map((player) => player.id));
      for (const [id, remote] of this.remotePlayers) if (!ids.has(id)) this.removeRemotePlayer(remote);
      this.updateLobby(); this.updateTeamHUD();
    };
    this.net.handlers.start = () => this.beginMultiplayer();
    this.net.handlers.state = ({ state }) => this.updateRemoteState(state);
    this.net.handlers.world = ({ snapshot }) => { if (!this.net.isHost) this.applyWorldSnapshot(snapshot); };
    this.net.handlers.hit = ({ enemyId, damage, headshot }) => {
      if (!this.net.isHost || this.mode !== "playing") return;
      const enemy = this.enemies.find((item) => item.id === enemyId && item.alive);
      if (!enemy) return;
      enemy.hp -= damage * (headshot ? 1.75 : 1); enemy.hitFlash = 0.1;
      this.particles.burst(enemy.mesh.position.clone().add(new THREE.Vector3(0, 1.2, 0)), headshot ? 0xffcc66 : 0x80e7c9, 5, 2.2, this.rng);
      if (enemy.hp <= 0) this.killEnemy(enemy, true);
    };
    this.net.handlers.pickupRequest = ({ dropId, playerId }) => {
      if (!this.net.isHost) return;
      const drop = this.drops.find((item) => item.id === dropId && item.active);
      const remote = this.remotePlayers.get(playerId);
      if (!drop || !remote || remote.dead || Math.hypot(drop.mesh.position.x - remote.targetPos.x, drop.mesh.position.z - remote.targetPos.z) > 3) return;
      this.net.send({ type: "pickupGrant", targetId: playerId, weapon: drop.weapon, kind: drop.kind });
      this.removeDrop(drop);
    };
    this.net.handlers.pickup = (message) => {
      const data = message as unknown as { weapon: WeaponId; kind: "ammo" | "weapon" };
      this.grantDrop(data.weapon, data.kind);
    };
    this.net.handlers.damage = ({ amount }) => { if (amount > 0) this.damagePlayer(amount); };
    this.net.handlers.enemyShot = ({ origin, direction, speed, damage }) => {
      if (!this.net.isHost) this.spawnEnemyBullet(new THREE.Vector3(origin.x, origin.y, origin.z), new THREE.Vector3(direction.x, direction.y, direction.z).normalize(), speed, damage);
    };
    this.net.handlers.playerShot = ({ id, origin }) => {
      const remote = this.remotePlayers.get(id); if (remote) remote.muzzleTimer = 0.07;
      this.audio.enemyShot(new THREE.Vector3(origin.x, origin.y, origin.z));
    };
    this.net.handlers.barrel = ({ index }) => {
      const barrel = this.barrels[index]; if (barrel && !barrel.exploded) this.explodeBarrel(barrel);
    };
    this.net.handlers.end = ({ victory }) => { if (!this.net.isHost) this.finishRun(victory); };
    this.net.handlers.roomClosed = ({ reason }) => this.leaveMultiplayer(reason);
    this.net.handlers.error = ({ message }) => { if (this.net.active) this.el.networkStatus.textContent = message; };
  }

  private beginMultiplayer(): void {
    if (!this.net.active) return;
    this.startRun(false);
    this.showMessage("КООПЕРАТИВ НАЧАТ", `КОМНАТА ${this.net.code} · ДЕРЖИТЕСЬ ВМЕСТЕ`, 1.8);
  }

  private leaveMultiplayer(reason = ""): void {
    this.net.leave(); this.multiplayerDead = false; this.mouseDown = false;
    this.wasPointerLocked = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.clearRemotePlayers();
    for (let i = this.enemies.length - 1; i >= 0; i--) this.removeEnemy(this.enemies[i]);
    for (let i = this.drops.length - 1; i >= 0; i--) this.removeDrop(this.drops[i]);
    this.showTitle(); this.el.networkStatus.textContent = reason;
  }

  private clearRemotePlayers(): void {
    for (const remote of this.remotePlayers.values()) this.removeRemotePlayer(remote);
  }

  private removeRemotePlayer(remote: RemotePlayer): void {
    this.scene.remove(remote.mesh); this.disposeObject(remote.mesh);
    remote.label.material.map?.dispose(); this.remotePlayers.delete(remote.id);
  }

  private updateRemoteState(state: PlayerState): void {
    if (!this.net.active || state.id === this.net.id) return;
    let remote = this.remotePlayers.get(state.id);
    if (!remote) {
      const name = this.net.players.find((player) => player.id === state.id)?.name ?? "Боец";
      const { visual, label } = createPlayerModel(name, this.textures, this.remotePlayers.size);
      const feetY = state.y - PLAYER_CENTER - GAME.EYE_OFFSET;
      visual.group.position.set(state.x, feetY, state.z); this.scene.add(visual.group);
      remote = {
        id: state.id, name, vis: visual, mesh: visual.group, label,
        targetPos: new THREE.Vector3(state.x, feetY, state.z), lastPos: new THREE.Vector3(state.x, feetY, state.z),
        targetYaw: state.yaw, targetPitch: state.pitch, hp: state.hp, dead: state.dead, weapon: state.weapon, walkPhase: 0, muzzleTimer: 0,
      };
      this.remotePlayers.set(state.id, remote);
    }
    remote.targetPos.set(state.x, state.y - PLAYER_CENTER - GAME.EYE_OFFSET, state.z);
    remote.targetYaw = state.yaw; remote.targetPitch = state.pitch;
    remote.hp = state.hp; remote.dead = state.dead; remote.weapon = state.weapon;
    remote.mesh.visible = !state.dead;
  }

  private updateRemotePlayers(dt: number): void {
    const blend = 1 - Math.exp(-dt * 14);
    for (const remote of this.remotePlayers.values()) {
      remote.lastPos.copy(remote.mesh.position); remote.mesh.position.lerp(remote.targetPos, blend);
      const angle = Math.atan2(Math.sin(remote.targetYaw - remote.mesh.rotation.y), Math.cos(remote.targetYaw - remote.mesh.rotation.y));
      remote.mesh.rotation.y += angle * blend;
      const moved = remote.mesh.position.distanceTo(remote.lastPos) / Math.max(dt, 0.001);
      remote.walkPhase += moved * dt * 3;
      const swing = Math.sin(remote.walkPhase) * Math.min(0.65, moved * 0.16);
      remote.vis.leftLeg.rotation.x = swing; remote.vis.rightLeg.rotation.x = -swing;
      remote.vis.leftArm.rotation.x = -swing * 0.6;
      remote.muzzleTimer = Math.max(0, remote.muzzleTimer - dt);
      remote.vis.muzzleFlash.visible = remote.muzzleTimer > 0;
    }
  }

  private sendPlayerState(): void {
    if (!this.net.active || !this.net.id) return;
    this.net.send({ type: "state", state: {
      id: this.net.id, x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z,
      yaw: this.yaw, pitch: this.pitch, weapon: this.currentWeapon, hp: Math.max(0, this.hp), dead: this.multiplayerDead,
    } });
  }

  private makeWorldSnapshot(): WorldSnapshot {
    return {
      wave: this.wave.number, toSpawn: this.wave.toSpawn, between: this.wave.between, breakTimer: this.wave.breakTimer,
      kills: this.kills, score: this.score,
      enemies: this.enemies.filter((enemy) => enemy.alive).map((enemy) => ({
        id: enemy.id, kind: enemy.kind, x: enemy.mesh.position.x, y: enemy.mesh.position.y, z: enemy.mesh.position.z,
        yaw: enemy.mesh.rotation.y, hp: Math.max(0, enemy.hp), maxHp: enemy.maxHp,
      })),
      drops: this.drops.filter((drop) => drop.active).map((drop) => ({ id: drop.id, kind: drop.kind, weapon: drop.weapon, x: drop.mesh.position.x, z: drop.mesh.position.z })),
    };
  }

  private applyWorldSnapshot(snapshot: WorldSnapshot): void {
    this.wave.number = snapshot.wave; this.wave.toSpawn = snapshot.toSpawn;
    this.wave.between = snapshot.between; this.wave.breakTimer = snapshot.breakTimer;
    this.kills = snapshot.kills; this.score = snapshot.score;
    const enemyIds = new Set(snapshot.enemies.map((enemy) => enemy.id));
    for (let i = this.enemies.length - 1; i >= 0; i--) if (!enemyIds.has(this.enemies[i].id)) this.removeEnemy(this.enemies[i]);
    for (const state of snapshot.enemies) {
      let enemy = this.enemies.find((item) => item.id === state.id);
      if (!enemy) enemy = this.spawnEnemy(state.kind, false, state);
      enemy.hp = state.hp; enemy.maxHp = state.maxHp;
      if (!enemy.netPos) enemy.netPos = new THREE.Vector3();
      enemy.netPos.set(state.x, state.y, state.z); enemy.netYaw = state.yaw;
    }
    const dropIds = new Set(snapshot.drops.map((drop) => drop.id));
    for (let i = this.drops.length - 1; i >= 0; i--) if (!dropIds.has(this.drops[i].id)) this.removeDrop(this.drops[i]);
    for (const state of snapshot.drops) {
      if (!this.drops.some((drop) => drop.id === state.id)) this.spawnDrop(new THREE.Vector3(state.x, 0, state.z), state.weapon, state.kind, state.id);
    }
    this.updateHUD();
  }

  private updateNetworkEnemies(dt: number): void {
    const blend = 1 - Math.exp(-dt * 12);
    for (const enemy of this.enemies) {
      if (!enemy.netPos) continue;
      const previousX = enemy.mesh.position.x, previousZ = enemy.mesh.position.z;
      enemy.mesh.position.lerp(enemy.netPos, blend);
      const targetYaw = enemy.netYaw ?? enemy.mesh.rotation.y;
      const angle = Math.atan2(Math.sin(targetYaw - enemy.mesh.rotation.y), Math.cos(targetYaw - enemy.mesh.rotation.y));
      enemy.mesh.rotation.y += angle * blend;
      enemy.rb.setNextKinematicTranslation({ x: enemy.mesh.position.x, y: enemy.mesh.position.y + ENEMY_CENTER, z: enemy.mesh.position.z });
      const speed = Math.hypot(enemy.mesh.position.x - previousX, enemy.mesh.position.z - previousZ) / Math.max(dt, 0.001);
      enemy.walkPhase += speed * dt * 2.8;
      const swing = Math.sin(enemy.walkPhase) * Math.min(0.65, speed * 0.18);
      enemy.vis.leftLeg.rotation.x = swing; enemy.vis.rightLeg.rotation.x = -swing;
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
      enemy.vis.bodyMaterial.emissive.setHex(enemy.hitFlash > 0 ? 0xff301f : 0x000000);
      enemy.vis.bodyMaterial.emissiveIntensity = enemy.hitFlash > 0 ? 1.2 : 0;
    }
  }

  private updateTeamHUD(): void {
    if (!this.net.active) { this.el.teamList.classList.add("hidden"); return; }
    this.el.teamList.classList.remove("hidden"); this.el.teamList.replaceChildren();
    const add = (name: string, hp: number, dead: boolean) => {
      const row = document.createElement("div"); row.className = `team-member${dead ? " dead" : ""}`;
      const dot = document.createElement("i"), label = document.createElement("span"), value = document.createElement("b");
      label.textContent = name; value.textContent = dead ? "DOWN" : String(Math.ceil(hp));
      row.append(dot, label, value); this.el.teamList.append(row);
    };
    add(`${this.el.playerName.value.trim() || "Боец"} · ВЫ`, this.hp, this.multiplayerDead);
    for (const remote of this.remotePlayers.values()) add(remote.name, remote.hp, remote.dead);
    this.el.roomHudPlayers.textContent = String(this.net.players.length);
  }

  private respawnMultiplayer(): void {
    if (!this.net.active || !this.multiplayerDead) return;
    this.multiplayerDead = false; this.hp = 100; this.vy = 0; this.reloading = false;
    const offset = Math.max(0, this.net.players.findIndex((player) => player.id === this.net.id)) * 1.5;
    this.playerBody.setEnabled(true); this.playerBody.setTranslation({ x: offset, y: PLAYER_CENTER + 0.02, z: 8 }, true);
    this.camera.position.set(offset, PLAYER_CENTER + GAME.EYE_OFFSET + 0.02, 8);
    this.mode = "playing"; this.el.menu.classList.add("hidden"); this.el.hud.classList.remove("hidden");
    for (const visual of this.viewWeapons.values()) visual.group.visible = visual === this.viewWeapons.get(this.currentWeapon);
    this.audio.sfx("pickup"); this.updateHUD(); this.sendPlayerState(); this.requestLock();
  }

  private showMultiplayerDeath(): void {
    this.multiplayerDead = true; this.mouseDown = false; this.wasPointerLocked = false;
    if (document.pointerLockElement) document.exitPointerLock();
    for (const visual of this.viewWeapons.values()) visual.group.visible = false;
    this.el.menu.classList.remove("hidden"); this.el.hud.classList.add("hidden");
    this.el.title.innerHTML = "БОЕЦ<br><em>ВЫВЕДЕН</em>";
    this.el.description.textContent = "Команда продолжает бой. Возродитесь у стартовой зоны — волна и счёт сохранятся.";
    this.el.stats.classList.add("hidden"); this.el.controls.classList.add("hidden");
    this.el.setup.classList.add("hidden"); this.el.lobby.classList.add("hidden");
    this.el.primary.innerHTML = "ВОЗРОДИТЬСЯ <span>→</span>"; this.el.primary.disabled = false;
    this.el.secondary.textContent = "ПОКИНУТЬ КОМНАТУ"; this.el.secondary.classList.remove("hidden");
    this.el.footnote.textContent = "Бесконечные возрождения · общая победа после пятой волны";
    this.sendPlayerState();
  }

  private startRun(lock: boolean): void {
    this.resetRun();
    this.mode = "playing";
    this.el.menu.classList.add("hidden"); this.el.hud.classList.remove("hidden");
    this.el.setup.classList.add("hidden"); this.el.lobby.classList.add("hidden");
    this.el.networkStatus.textContent = ""; this.el.primary.disabled = false;
    this.el.roomHud.classList.toggle("hidden", !this.net.active);
    this.el.teamList.classList.toggle("hidden", !this.net.active);
    this.el.roomHudCode.textContent = this.net.code || "—";
    this.updateTeamHUD();
    this.audio.sfx("ui"); this.audio.startMusic();
    for (const visual of this.viewWeapons.values()) visual.group.visible = visual === this.viewWeapons.get(this.currentWeapon);
    if (lock) this.requestLock();
  }

  private pause(): void {
    if (this.mode !== "playing") return;
    this.mode = "paused"; this.mouseDown = false; this.wasPointerLocked = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.el.menu.classList.remove("hidden"); this.el.hud.classList.add("hidden");
    this.el.title.innerHTML = "ТАКТИЧЕСКАЯ<br><em>ПАУЗА</em>";
    this.el.description.textContent = this.net.active
      ? `Комната ${this.net.code} · волна ${this.wave.number}. Бой для команды продолжается, пока открыто это меню.`
      : `Волна ${this.wave.number} · устранено ${this.kills} · счёт ${this.score}`;
    this.el.stats.classList.add("hidden"); this.el.controls.classList.remove("hidden");
    this.el.setup.classList.add("hidden"); this.el.lobby.classList.add("hidden");
    this.el.primary.innerHTML = "ПРОДОЛЖИТЬ <span>→</span>";
    this.el.secondary.textContent = this.net.active ? "ПОКИНУТЬ КОМНАТУ" : "НАЧАТЬ ЗАНОВО"; this.el.secondary.classList.remove("hidden");
    this.el.footnote.textContent = this.net.active ? "ESC — вернуться в бой · сетевая волна не ставится на паузу" : "ESC — продолжить · прогресс текущей волны сохранён";
  }

  private resume(): void {
    if (this.mode !== "paused") return;
    this.mode = "playing"; this.el.menu.classList.add("hidden"); this.el.hud.classList.remove("hidden");
    this.input.consumeLook(); this.audio.sfx("ui"); this.requestLock();
  }

  private resetRun(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) this.removeEnemy(this.enemies[i]);
    for (const bullet of this.bullets) this.deactivateBullet(bullet);
    for (let i = this.drops.length - 1; i >= 0; i--) this.removeDrop(this.drops[i]);
    this.clearRagdoll();
    for (const prop of [...this.crates, ...this.barrels]) {
      prop.body.setEnabled(true); prop.body.setTranslation(prop.initial, true);
      prop.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true); prop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      prop.mesh.visible = true; prop.mesh.position.set(prop.initial.x, prop.initial.y, prop.initial.z);
      prop.mesh.quaternion.identity(); prop.exploded = false;
    }
    this.hp = 100; this.kills = 0; this.score = 0; this.shotsFired = 0; this.enemyShots = 0; this.playerHits = 0;
    this.inventory.pistol = { owned: true, ammo: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.startReserve };
    this.inventory.rifle = { owned: false, ammo: 0, reserve: 0 };
    this.inventory.lmg = { owned: false, ammo: 0, reserve: 0 };
    this.reloading = false; this.fireCooldown = 0; this.recoil = 0; this.mouseDown = false;
    this.yaw = 0; this.pitch = 0; this.vy = 0; this.onGround = false;
    this.playerBody.setEnabled(true);
    this.playerBody.setTranslation({ x: 0, y: PLAYER_CENTER + 0.02, z: 8 }, true);
    this.camera.position.set(0, PLAYER_CENTER + GAME.EYE_OFFSET + 0.02, 8);
    this.camera.rotation.order = "YXZ"; this.camera.rotation.set(0, 0, 0);
    this.switchWeapon("pistol", true);
    this.wave = { number: 0, toSpawn: 0, spawnTimer: 0, between: false, breakTimer: 0 };
    this.multiplayerDead = false; this.networkTimer = 0; this.worldTimer = 0;
    if (!this.net.active || this.net.isHost) this.startWave(1);
    else this.wave.number = 1;
    this.updateHUD();
    this.input.consumeLook(); this.input.actions.clear();
  }

  private startWave(number: number): void {
    this.wave.number = number; this.wave.toSpawn = 4 + number * 2;
    this.wave.spawnTimer = 0.3; this.wave.between = false;
    this.showMessage(`ВОЛНА ${number}`, number === 1 ? "НАЙДИТЕ НОВОЕ ОРУЖИЕ В ДРОПЕ" : "ПРОТИВНИКИ СТАНОВЯТСЯ ОПАСНЕЕ", 1.8);
    this.updateHUD();
  }

  private update(dt: number): void {
    if (this.disposed) return;
    this.titleTime += dt;
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.el.message.classList.remove("visible");
    }
    this.damageOpacity = Math.max(0, this.damageOpacity - dt * 2.6);
    this.el.damage.style.opacity = this.damageOpacity.toFixed(2);
    this.hitTimer = Math.max(0, this.hitTimer - dt);
    this.headshotTimer = Math.max(0, this.headshotTimer - dt);
    this.el.hitmarker.classList.toggle("visible", this.hitTimer > 0);
    this.el.hitmarker.classList.toggle("headshot", this.headshotTimer > 0);
    if (this.input.consumeAction("KeyM")) this.toggleMute();

    if (this.mode === "title") {
      if (!this.net.active && this.input.consumeAction("Space")) { this.startRun(false); return; }
      const angle = 0.55 + Math.sin(this.titleTime * 0.09) * 0.12;
      this.camera.position.set(Math.sin(angle) * 22, 6.4 + Math.sin(this.titleTime * 0.2) * 0.25, Math.cos(angle) * 22);
      this.camera.lookAt(0, 1.1, 0);
      this.particles.update(dt); this.updateRemotePlayers(dt);
      return;
    }
    if (this.mode === "paused") {
      if (this.input.consumeAction("Escape")) { this.resume(); return; }
      if (this.net.active) this.updateCombat(dt);
      return;
    }
    if (this.mode === "gameover" || this.mode === "victory") {
      if (this.input.consumeAction("Space")) {
        if (!this.net.active) this.startRun(false);
        else if (this.net.isHost) this.net.send({ type: "start" });
        return;
      }
      this.world.step(); this.syncDynamic(); this.particles.update(dt); this.updateRemotePlayers(dt);
      return;
    }

    if (this.multiplayerDead) { this.updateCombat(dt); return; }
    if (this.input.consumeAction("Escape")) { this.pause(); return; }
    if (this.input.consumeAction("Digit1")) this.switchWeapon("pistol");
    if (this.input.consumeAction("Digit2")) this.switchWeapon("rifle");
    if (this.input.consumeAction("Digit3")) this.switchWeapon("lmg");
    if (this.input.consumeAction("KeyR")) this.startReload();
    if (this.input.consumeAction("KeyE") && this.nearestDrop) this.pickupDrop(this.nearestDrop);

    this.updatePlayer(dt);
    this.updateWeapon(dt);
    this.updateCombat(dt);
  }

  private updateCombat(dt: number): void {
    if (this.net.active && !this.net.isHost) this.updateNetworkEnemies(dt);
    else this.updateEnemies(dt);
    this.updateBullets(dt);
    this.updateDrops(dt);
    if (!this.net.active || this.net.isHost) this.updateWaves(dt);
    this.world.step(); this.syncDynamic(); this.particles.update(dt); this.updateRemotePlayers(dt);
    if (!this.net.active) return;
    this.networkTimer += dt; this.worldTimer += dt;
    if (this.networkTimer >= 1 / 15) {
      this.networkTimer = 0; this.sendPlayerState(); this.updateTeamHUD();
    }
    if (this.net.isHost && this.worldTimer >= 0.1) {
      this.worldTimer = 0; this.net.send({ type: "world", snapshot: this.makeWorldSnapshot() });
    }
  }

  private updatePlayer(dt: number): void {
    const look = this.input.consumeLook();
    this.yaw += look.yaw; this.pitch += look.pitch;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.wish.set(0, 0, 0);
    this.wish.x += -sin * this.input.moveZ + cos * this.input.moveX;
    this.wish.z += -cos * this.input.moveZ - sin * this.input.moveX;
    const moving = this.wish.lengthSq() > 0.001;
    if (moving) this.wish.normalize();
    const sprint = this.input.isHeld("ShiftLeft") || this.input.isHeld("ShiftRight");
    const speed = (sprint ? 8.6 : 5.6) * WEAPONS[this.currentWeapon].moveScale;
    this.wish.multiplyScalar(speed);
    if (this.input.consumeAction("Space") && this.onGround) { this.vy = 7.3; this.onGround = false; }
    this.vy -= GAME.GRAVITY * dt; this.wish.y = this.vy;
    this.playerController.computeColliderMovement(this.playerCollider, { x: this.wish.x * dt, y: this.wish.y * dt, z: this.wish.z * dt });
    const corrected = this.playerController.computedMovement();
    const current = this.playerBody.translation();
    const next = { x: current.x + corrected.x, y: current.y + corrected.y, z: current.z + corrected.z };
    this.playerBody.setNextKinematicTranslation(next);
    this.onGround = this.playerController.computedGrounded();
    if (this.onGround && this.vy < 0) this.vy = 0;
    if (next.y < -4) { this.playerBody.setNextKinematicTranslation({ x: 0, y: PLAYER_CENTER + 0.02, z: 8 }); this.vy = 0; }
    this.camera.position.set(next.x, next.y + GAME.EYE_OFFSET, next.z);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw; this.camera.rotation.x = this.pitch + this.recoil;
    this.bobTime += dt * (moving && this.onGround ? 10 : 3);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 90);
  }

  private updateWeapon(dt: number): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.recoil = Math.max(0, this.recoil - dt * 0.12);
    this.muzzleTimer = Math.max(0, this.muzzleTimer - dt);
    this.muzzleFlash.visible = this.muzzleTimer > 0;
    if (this.muzzleTimer > 0) this.muzzleFlash.rotation.z += dt * 30;
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        const spec = WEAPONS[this.currentWeapon], item = this.inventory[this.currentWeapon];
        const amount = Math.min(spec.mag - item.ammo, item.reserve);
        item.ammo += amount; item.reserve -= amount; this.reloading = false;
        this.updateHUD();
      }
    }
    if (this.mouseDown && WEAPONS[this.currentWeapon].auto) this.attemptShoot();
    const visual = this.viewWeapons.get(this.currentWeapon);
    if (visual) {
      const moving = (Math.abs(this.input.moveX) + Math.abs(this.input.moveZ)) > 0 && this.onGround;
      const bob = moving ? Math.sin(this.bobTime) * 0.012 : 0;
      visual.group.position.set(0.25 + bob, -0.25 + (moving ? Math.abs(Math.cos(this.bobTime)) * 0.012 : 0) - this.recoil * 0.7, -0.44 + this.recoil * 1.3);
      visual.group.rotation.z = moving ? Math.sin(this.bobTime * 0.5) * 0.012 : 0;
      visual.group.rotation.x = this.reloading ? -0.48 + Math.sin(this.reloadT * 9) * 0.08 : 0;
    }
    const spec = WEAPONS[this.currentWeapon];
    this.el.reload.classList.toggle("visible", this.reloading);
    this.el.reloadFill.style.width = this.reloading ? `${(1 - this.reloadT / spec.reload) * 100}%` : "0%";
    this.el.crosshair.classList.toggle("firing", this.muzzleTimer > 0);
  }

  private switchWeapon(id: WeaponId, force = false): void {
    if (!force && (this.currentWeapon === id || !this.inventory[id].owned)) return;
    if (!this.inventory[id].owned) return;
    this.reloading = false; this.currentWeapon = id;
    for (const visual of this.viewWeapons.values()) visual.group.visible = false;
    let visual = this.viewWeapons.get(id);
    if (!visual) {
      visual = createWeaponModel(id, this.textures);
      visual.group.scale.setScalar(0.62);
      this.viewWeapons.set(id, visual); this.camera.add(visual.group);
    }
    visual.group.visible = this.mode !== "title";
    visual.muzzle.add(this.muzzleFlash); visual.muzzle.add(this.muzzleLight);
    this.muzzleLight.position.set(0, 0, 0);
    if (!force) this.audio.sfx("ui");
    this.updateHUD();
  }

  private startReload(): void {
    const spec = WEAPONS[this.currentWeapon], item = this.inventory[this.currentWeapon];
    if (this.reloading || item.ammo >= spec.mag || item.reserve <= 0 || this.mode !== "playing") {
      if (item.reserve <= 0 && item.ammo < spec.mag) this.audio.sfx("empty");
      return;
    }
    this.reloading = true; this.reloadT = spec.reload; this.audio.sfx("reload");
  }

  private attemptShoot(): void {
    if (this.mode !== "playing" || this.multiplayerDead || this.reloading || this.fireCooldown > 0) return;
    const spec = WEAPONS[this.currentWeapon], item = this.inventory[this.currentWeapon];
    if (item.ammo <= 0) { this.fireCooldown = 0.2; this.audio.sfx("empty"); this.startReload(); return; }
    item.ammo--; this.shotsFired++; this.fireCooldown = spec.interval;
    this.recoil = Math.min(0.11, this.recoil + spec.recoil);
    this.muzzleTimer = 0.055; this.muzzleLight.intensity = 5;
    this.audio.shot(spec.id); this.updateHUD();
    if (this.net.active) this.net.send({ type: "playerShot", origin: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z }, weapon: this.currentWeapon });

    this.raycaster.setFromCamera(CENTER_SCREEN, this.camera);
    this.tmpA.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.tmpB.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.raycaster.ray.direction
      .addScaledVector(this.tmpA, (this.rng() - 0.5) * spec.spread * 2)
      .addScaledVector(this.tmpB, (this.rng() - 0.5) * spec.spread * 2).normalize();
    const targets: THREE.Object3D[] = [...this.staticTargets];
    for (const enemy of this.enemies) if (enemy.alive) targets.push(enemy.mesh);
    for (const crate of this.crates) targets.push(crate.mesh);
    for (const barrel of this.barrels) if (!barrel.exploded) targets.push(barrel.mesh);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (!hits.length) return;
    const hit = hits[0], object = hit.object;
    const enemy = object.userData.enemyRef as Enemy | undefined;
    if (enemy?.alive) {
      const headshot = object.userData.hitPart === "head";
      enemy.hitFlash = 0.1; this.hitTimer = 0.12;
      if (headshot) this.headshotTimer = 0.12;
      this.audio.sfx(headshot ? "headshot" : "hit");
      this.particles.burst(hit.point, headshot ? 0xffcc66 : 0x80e7c9, headshot ? 9 : 5, 2.2, this.rng);
      if (this.net.active && !this.net.isHost) {
        this.net.send({ type: "hit", enemyId: enemy.id, damage: spec.damage, headshot });
      } else {
        enemy.hp -= spec.damage * (headshot ? 1.75 : 1);
        if (enemy.hp <= 0) this.killEnemy(enemy, true);
      }
      return;
    }
    const barrel = object.userData.barrelRef as Prop | undefined;
    if (barrel && !barrel.exploded) {
      if (this.net.active && !this.net.isHost) this.net.send({ type: "barrel", index: this.barrels.indexOf(barrel) });
      else this.explodeBarrel(barrel);
      return;
    }
    const crate = object.userData.crateRef as Prop | undefined;
    if (crate) {
      const d = this.raycaster.ray.direction;
      crate.body.applyImpulseAtPoint({ x: d.x * 4.5, y: d.y * 4.5 + 1.1, z: d.z * 4.5 }, hit.point, true);
    }
    this.particles.burst(hit.point, 0xffc777, 4, 1.8, this.rng);
  }

  private showMessage(text: string, sub = "", duration = 1.4): void {
    this.el.message.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ""}`;
    this.el.message.classList.add("visible"); this.messageTimer = duration;
  }

  private updateHUD(): void {
    const item = this.inventory[this.currentWeapon], spec = WEAPONS[this.currentWeapon];
    this.el.hp.textContent = String(Math.max(0, Math.ceil(this.hp)));
    this.el.hpFill.style.width = `${Math.max(0, this.hp)}%`;
    this.el.hpFill.style.background = this.hp < 30 ? "#ff6655" : "#72e5ce";
    this.el.kills.textContent = `УСТРАНЕНО ${this.kills}`;
    this.el.weapon.textContent = spec.name;
    this.el.mag.textContent = String(item.ammo).padStart(2, "0");
    this.el.reserve.textContent = String(item.reserve).padStart(3, "0");
    this.el.mode.textContent = `${spec.auto ? "АВТОМАТИЧЕСКИЙ" : "ОДИНОЧНЫЙ"} · R — ПЕРЕЗАРЯДКА`;
    this.el.wave.textContent = `ВОЛНА ${Math.max(1, this.wave.number)} / ${GAME.MAX_WAVE}`;
    this.el.enemyCount.textContent = `ПРОТИВНИКИ ${this.enemies.length + this.wave.toSpawn}`;
    this.el.score.textContent = `СЧЁТ ${this.score.toString().padStart(6, "0")}`;
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const slot = document.querySelector(`[data-slot="${id}"]`);
      slot?.classList.toggle("active", id === this.currentWeapon);
      slot?.classList.toggle("locked", !this.inventory[id].owned);
    }
  }

  private updateWaves(dt: number): void {
    if (this.wave.between) {
      this.wave.breakTimer -= dt;
      if (this.wave.breakTimer <= 0) this.startWave(this.wave.number + 1);
      return;
    }
    if (this.wave.toSpawn > 0 && this.enemies.length < GAME.MAX_ACTIVE_ENEMIES) {
      this.wave.spawnTimer -= dt;
      if (this.wave.spawnTimer <= 0) {
        const roll = this.rng();
        const kind: EnemyKind = this.wave.number >= 3 && roll < 0.22 ? "heavy" : this.wave.number >= 2 && roll < 0.55 ? "runner" : "grunt";
        this.spawnEnemy(kind);
        this.wave.toSpawn--; this.wave.spawnTimer = 0.55 + this.rng() * 0.45;
        this.updateHUD();
      }
    }
    if (this.wave.toSpawn === 0 && this.enemies.length === 0 && !this.wave.between) {
      if (this.wave.number >= GAME.MAX_WAVE) { this.finishRun(true); return; }
      this.wave.between = true; this.wave.breakTimer = 4;
      this.hp = Math.min(100, this.hp + 12);
      this.showMessage("ВОЛНА ЗАЧИЩЕНА", "+12 HP · СЛЕДУЮЩАЯ ЧЕРЕЗ 4 СЕКУНДЫ", 1.8);
      this.updateHUD();
    }
  }

  private spawnEnemy(kind: EnemyKind, near = false, network?: EnemyState): Enemy {
    const spawn = network ? { x: network.x, z: network.z } : this.findEnemySpawn(near);
    const vis = createEnemyModel(kind, this.textures);
    vis.group.position.set(spawn.x, network?.y ?? 0.02, spawn.z); this.scene.add(vis.group);
    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, (network?.y ?? 0.02) + ENEMY_CENTER, spawn.z));
    const col = this.world.createCollider(RAPIER.ColliderDesc.capsule(ENEMY_HALF, ENEMY_RADIUS), rb);
    const kcc = this.makeCharacterController(0.045);
    const spec = ENEMIES[kind];
    const scale = 1 + Math.max(0, this.wave.number - 1) * 0.07;
    const enemy: Enemy = {
      id: network?.id ?? ++this.enemyId, kind, vis, mesh: vis.group, rb, col, kcc,
      hp: network?.hp ?? spec.hp * scale, maxHp: network?.maxHp ?? spec.hp * scale, speed: spec.speed * (1 + Math.max(0, this.wave.number - 1) * 0.035),
      range: spec.range + this.rng() * 1.4, fireRate: spec.fireRate, damage: spec.damage,
      bulletSpeed: spec.bulletSpeed, fireTimer: 0.8 + this.rng() * 1.1, vy: 0, grounded: false,
      knockback: new THREE.Vector3(), strafeSign: this.rng() > 0.5 ? 1 : -1,
      stuckTime: 0, lastPos: new THREE.Vector3(spawn.x, ENEMY_CENTER, spawn.z), avoidTimer: 0,
      walkPhase: this.rng() * Math.PI * 2, hitFlash: 0, muzzleTimer: 0, alive: true,
      netPos: network ? new THREE.Vector3(network.x, network.y, network.z) : undefined, netYaw: network?.yaw,
    };
    if (network) this.enemyId = Math.max(this.enemyId, network.id);
    vis.group.traverse((obj) => { obj.userData.enemyRef = enemy; });
    this.enemies.push(enemy); this.enemyColliders.add(col);
    return enemy;
  }

  private findEnemySpawn(near: boolean): { x: number; z: number } {
    const shape = new RAPIER.Capsule(ENEMY_HALF, ENEMY_RADIUS);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    for (let attempt = 0; attempt < 70; attempt++) {
      let x: number, z: number;
      if (near) {
        const angle = this.yaw + (this.rng() - 0.5) * 0.5;
        const distance = 7 + this.rng() * 2;
        x = this.camera.position.x - Math.sin(angle) * distance;
        z = this.camera.position.z - Math.cos(angle) * distance;
      } else {
        x = (this.rng() - 0.5) * GAME.WORLD * 1.72;
        z = (this.rng() - 0.5) * GAME.WORLD * 1.72;
      }
      if (Math.abs(x) > GAME.WORLD - 2 || Math.abs(z) > GAME.WORLD - 2) continue;
      if (this.combatTargets().some((target) => Math.hypot(x - target.position.x, z - target.position.z) < (near ? 5 : 15))) continue;
      if (this.enemies.some((e) => Math.hypot(x - e.mesh.position.x, z - e.mesh.position.z) < 1.8)) continue;
      const blocked = this.world.intersectionWithShape(
        { x, y: ENEMY_CENTER + 0.08, z }, rotation, shape,
        undefined, undefined, undefined, undefined,
        (col) => col !== this.playerCollider && !this.enemyColliders.has(col),
      );
      if (!blocked) return { x, z };
    }
    return { x: near ? this.camera.position.x : -GAME.WORLD + 3, z: near ? this.camera.position.z - 7 : -GAME.WORLD + 3 };
  }

  private hasLOS(from: THREE.Vector3, to: THREE.Vector3, exclude: Collider): boolean {
    this.rayDirection.subVectors(to, from);
    const distance = this.rayDirection.length();
    if (distance < 0.01) return true;
    this.rayDirection.multiplyScalar(1 / distance);
    const ray = new RAPIER.Ray(from, this.rayDirection);
    const hit = this.world.castRay(ray, distance, true, undefined, undefined, exclude, undefined, (col) => col !== this.playerCollider);
    return hit === null;
  }

  private obstacleAhead(origin: THREE.Vector3, direction: THREE.Vector3, distance: number, exclude: Collider): boolean {
    const ray = new RAPIER.Ray(origin, direction);
    const hit = this.world.castRay(ray, distance, true, undefined, undefined, exclude, undefined,
      (col) => col !== this.playerCollider && !this.enemyColliders.has(col));
    return hit !== null;
  }

  private combatTargets(): { id: string; position: THREE.Vector3 }[] {
    const targets: { id: string; position: THREE.Vector3 }[] = [];
    if (!this.multiplayerDead && this.hp > 0) targets.push({ id: this.net.id || "local", position: this.camera.position });
    if (this.net.active) {
      for (const remote of this.remotePlayers.values()) {
        if (!remote.dead && remote.hp > 0) targets.push({ id: remote.id, position: remote.targetPos.clone().add(new THREE.Vector3(0, PLAYER_CENTER + GAME.EYE_OFFSET, 0)) });
      }
    }
    return targets;
  }

  private updateEnemies(dt: number): void {
    const targets = this.combatTargets();
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (!enemy.alive) continue;
      const raw = enemy.rb.translation();
      this.tmpA.set(raw.x, raw.y, raw.z);
      let target = targets[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of targets) {
        const candidateDistance = Math.hypot(candidate.position.x - raw.x, candidate.position.z - raw.z);
        if (candidateDistance < bestDistance) { bestDistance = candidateDistance; target = candidate; }
      }
      if (!target) continue;
      this.toPlayer.set(target.position.x - raw.x, 0, target.position.z - raw.z);
      const distance = Math.max(0.001, this.toPlayer.length());
      this.toPlayer.multiplyScalar(1 / distance);
      this.tmpB.set(raw.x, raw.y + 0.55, raw.z);
      this.tmpC.copy(target.position);
      const los = this.hasLOS(this.tmpB, this.tmpC, enemy.col);

      this.wish.set(0, 0, 0);
      if (!los || distance > enemy.range + 1.3) this.wish.copy(this.toPlayer);
      else if (distance < enemy.range - 1.8) this.wish.copy(this.toPlayer).multiplyScalar(-0.75);
      else this.wish.set(-this.toPlayer.z * enemy.strafeSign, 0, this.toPlayer.x * enemy.strafeSign).multiplyScalar(0.62);

      for (const other of this.enemies) {
        if (other === enemy || !other.alive) continue;
        const dx = raw.x - other.rb.translation().x, dz = raw.z - other.rb.translation().z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.001 && d2 < 2.1) {
          const strength = (2.1 - d2) / 2.1;
          this.wish.x += dx / Math.sqrt(d2) * strength * 0.9;
          this.wish.z += dz / Math.sqrt(d2) * strength * 0.9;
        }
      }
      if (this.wish.lengthSq() > 0.001) this.wish.normalize();
      enemy.avoidTimer = Math.max(0, enemy.avoidTimer - dt);
      if (enemy.avoidTimer > 0) {
        const angle = enemy.strafeSign * 1.05, x = this.wish.x, z = this.wish.z;
        this.wish.x = x * Math.cos(angle) - z * Math.sin(angle);
        this.wish.z = x * Math.sin(angle) + z * Math.cos(angle);
      }
      if (this.wish.lengthSq() > 0.01) {
        this.tmpD.set(raw.x, raw.y - 0.15, raw.z);
        if (this.obstacleAhead(this.tmpD, this.wish, 1.15, enemy.col)) {
          const x = this.wish.x, z = this.wish.z, angle = enemy.strafeSign * Math.PI * 0.52;
          this.wish.x = x * Math.cos(angle) - z * Math.sin(angle) + this.toPlayer.x * 0.16;
          this.wish.z = x * Math.sin(angle) + z * Math.cos(angle) + this.toPlayer.z * 0.16;
          this.wish.normalize();
        }
      }
      const moved = Math.hypot(raw.x - enemy.lastPos.x, raw.z - enemy.lastPos.z);
      if (moved < 0.004 && this.wish.lengthSq() > 0.1) enemy.stuckTime += dt;
      else enemy.stuckTime = Math.max(0, enemy.stuckTime - dt * 2);
      enemy.lastPos.set(raw.x, raw.y, raw.z);
      if (enemy.stuckTime > 0.45) {
        enemy.stuckTime = 0; enemy.avoidTimer = 0.85; enemy.strafeSign *= -1;
      }

      enemy.knockback.multiplyScalar(Math.pow(0.08, dt));
      this.wish.multiplyScalar(enemy.speed).add(enemy.knockback);
      enemy.vy -= GAME.GRAVITY * dt; this.wish.y = enemy.vy;
      enemy.kcc.computeColliderMovement(enemy.col, { x: this.wish.x * dt, y: this.wish.y * dt, z: this.wish.z * dt });
      const corrected = enemy.kcc.computedMovement();
      const next = { x: raw.x + corrected.x, y: raw.y + corrected.y, z: raw.z + corrected.z };
      enemy.rb.setNextKinematicTranslation(next);
      enemy.grounded = enemy.kcc.computedGrounded();
      if (enemy.grounded && enemy.vy < 0) enemy.vy = 0;
      enemy.mesh.position.set(next.x, next.y - ENEMY_CENTER, next.z);
      enemy.mesh.rotation.y = Math.atan2(-this.toPlayer.x, -this.toPlayer.z);

      const actualSpeed = Math.sqrt(corrected.x * corrected.x + corrected.z * corrected.z) / dt;
      enemy.walkPhase += actualSpeed * dt * 2.8;
      const swing = Math.sin(enemy.walkPhase) * Math.min(0.65, actualSpeed * 0.18);
      enemy.vis.leftLeg.rotation.x = swing; enemy.vis.rightLeg.rotation.x = -swing;
      enemy.vis.leftArm.rotation.x = -swing * 0.7;
      enemy.vis.rightArm.rotation.x = 0.85 + swing * 0.12;
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
      enemy.vis.bodyMaterial.emissive.setHex(enemy.hitFlash > 0 ? 0xff301f : 0x000000);
      enemy.vis.bodyMaterial.emissiveIntensity = enemy.hitFlash > 0 ? 1.2 : 0;
      enemy.muzzleTimer = Math.max(0, enemy.muzzleTimer - dt);
      enemy.vis.muzzleFlash.visible = enemy.muzzleTimer > 0;

      enemy.fireTimer -= dt;
      if (enemy.fireTimer <= 0 && los && distance < 29) {
        enemy.fireTimer = enemy.fireRate * (0.86 + this.rng() * 0.3);
        enemy.mesh.updateMatrixWorld(true);
        const origin = enemy.vis.muzzle.getWorldPosition(new THREE.Vector3());
        const aim = target.position.clone();
        const spread = enemy.kind === "runner" ? 0.75 : enemy.kind === "heavy" ? 0.45 : 0.55;
        aim.x += (this.rng() - 0.5) * spread; aim.y += (this.rng() - 0.5) * spread * 0.5; aim.z += (this.rng() - 0.5) * spread;
        const direction = aim.sub(origin).normalize();
        this.spawnEnemyBullet(origin, direction, enemy.bulletSpeed, enemy.damage);
        enemy.muzzleTimer = 0.075; this.enemyShots++;
        this.audio.enemyShot(origin);
      } else if (enemy.fireTimer <= 0) enemy.fireTimer = 0.15;
    }
  }

  private createBulletPool(): void {
    const geometry = new THREE.SphereGeometry(0.065, 6, 5);
    const material = new THREE.MeshBasicMaterial({ color: 0xff6747 });
    for (let i = 0; i < GAME.MAX_BULLETS; i++) {
      const bulletMesh = new THREE.Mesh(geometry, material);
      bulletMesh.visible = false; this.scene.add(bulletMesh);
      this.bullets.push({ mesh: bulletMesh, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, damage: 0, active: false });
    }
  }

  private spawnEnemyBullet(origin: THREE.Vector3, direction: THREE.Vector3, speed: number, damage: number): void {
    const bullet = this.bullets.find((b) => !b.active);
    if (!bullet) return;
    bullet.active = true; bullet.mesh.visible = true; bullet.pos.copy(origin); bullet.prev.copy(origin);
    bullet.vel.copy(direction).multiplyScalar(speed); bullet.life = 3; bullet.damage = damage;
    bullet.mesh.position.copy(origin);
    if (this.net.active && this.net.isHost) this.net.send({ type: "enemyShot", origin, direction, speed, damage });
  }

  private deactivateBullet(bullet: Bullet): void {
    bullet.active = false; bullet.mesh.visible = false; bullet.life = 0;
  }

  private updateBullets(dt: number): void {
    for (const bullet of this.bullets) {
      if (!bullet.active) continue;
      bullet.life -= dt;
      if (bullet.life <= 0) { this.deactivateBullet(bullet); continue; }
      bullet.prev.copy(bullet.pos);
      bullet.vel.y -= 1.6 * dt;
      this.tmpA.copy(bullet.vel).multiplyScalar(dt);
      const travel = this.tmpA.length();
      if (travel < 0.0001) continue;
      this.tmpA.multiplyScalar(1 / travel);
      const ray = new RAPIER.Ray(bullet.prev, this.tmpA);
      const environmentHit = this.world.castRay(ray, travel, true, undefined, undefined, undefined, undefined,
        (col) => col !== this.playerCollider && !this.enemyColliders.has(col));

      let playerHitDistance = Number.POSITIVE_INFINITY;
      let hitTargetId = "";
      const targets = this.net.active && !this.net.isHost ? [] : this.combatTargets();
      for (const target of targets) {
        this.tmpD.set(target.position.x, target.position.y - 0.32, target.position.z);
        this.tmpB.copy(this.tmpD).sub(bullet.prev);
        const projection = THREE.MathUtils.clamp(this.tmpB.dot(this.tmpA), 0, travel);
        this.tmpC.copy(bullet.prev).addScaledVector(this.tmpA, projection);
        if (this.tmpC.distanceToSquared(this.tmpD) < 0.24 && projection < playerHitDistance) {
          playerHitDistance = projection; hitTargetId = target.id;
        }
      }
      const envDistance = environmentHit?.timeOfImpact ?? Number.POSITIVE_INFINITY;

      if (playerHitDistance < envDistance) {
        bullet.pos.copy(bullet.prev).addScaledVector(this.tmpA, playerHitDistance); bullet.mesh.position.copy(bullet.pos);
        if (!this.net.active || hitTargetId === this.net.id || hitTargetId === "local") this.damagePlayer(bullet.damage);
        else this.net.send({ type: "damage", targetId: hitTargetId, amount: bullet.damage });
        this.deactivateBullet(bullet); continue;
      }
      if (environmentHit) {
        bullet.pos.copy(bullet.prev).addScaledVector(this.tmpA, environmentHit.timeOfImpact);
        this.particles.burst(bullet.pos, 0xff704d, 3, 1.2, this.rng);
        this.deactivateBullet(bullet); continue;
      }
      bullet.pos.addScaledVector(this.tmpA, travel); bullet.mesh.position.copy(bullet.pos);
      if (Math.abs(bullet.pos.x) > GAME.WORLD || Math.abs(bullet.pos.z) > GAME.WORLD || bullet.pos.y < -1) this.deactivateBullet(bullet);
    }
  }

  private damagePlayer(amount: number): void {
    if (this.mode !== "playing" || this.multiplayerDead) return;
    this.hp -= amount; this.playerHits++; this.damageOpacity = 0.92;
    this.audio.sfx("hurt"); this.updateHUD();
    if (this.hp <= 0) {
      this.hp = 0;
      if (this.net.active) this.showMultiplayerDeath(); else this.finishRun(false);
    }
  }

  private killEnemy(enemy: Enemy, reward: boolean): void {
    if (!enemy.alive) return;
    const position = enemy.mesh.position.clone();
    if (reward) {
      this.kills++; this.score += ENEMIES[enemy.kind].score;
      this.particles.burst(position.clone().add(new THREE.Vector3(0, 1, 0)), enemy.kind === "heavy" ? 0xff7655 : 0x79dbc4, enemy.kind === "heavy" ? 26 : 16, 4.2, this.rng);
      this.dropLoot(enemy, position);
    }
    this.removeEnemy(enemy); this.updateHUD();
  }

  private removeEnemy(enemy: Enemy): void {
    if (!enemy.alive) return;
    enemy.alive = false; this.enemyColliders.delete(enemy.col);
    this.world.removeCharacterController(enemy.kcc); this.world.removeRigidBody(enemy.rb);
    this.scene.remove(enemy.mesh); this.disposeObject(enemy.mesh);
    const index = this.enemies.indexOf(enemy); if (index >= 0) this.enemies.splice(index, 1);
  }

  private dropLoot(enemy: Enemy, position: THREE.Vector3): void {
    if (!this.inventory.rifle.owned && this.kills >= 2) { this.spawnDrop(position, "rifle", "weapon"); return; }
    if (!this.inventory.lmg.owned && this.wave.number >= 2 && this.kills >= 5) { this.spawnDrop(position, "lmg", "weapon"); return; }
    const roll = this.rng();
    if (roll < 0.5) {
      const owned = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => this.inventory[id].owned);
      this.spawnDrop(position, owned[Math.floor(this.rng() * owned.length)], "ammo");
    } else if (roll < 0.65) {
      const locked = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => !this.inventory[id].owned);
      if (locked.length) this.spawnDrop(position, locked[Math.floor(this.rng() * locked.length)], "weapon");
      else this.spawnDrop(position, enemy.kind === "heavy" ? "lmg" : "rifle", "ammo");
    }
  }

  private spawnDrop(position: THREE.Vector3, weapon: WeaponId, kind: "ammo" | "weapon", networkId?: number): Drop | null {
    if (this.drops.length >= GAME.MAX_DROPS) this.removeDrop(this.drops[0]);
    const group = new THREE.Group();
    if (kind === "weapon") {
      const visual = createWeaponModel(weapon, this.textures);
      visual.group.scale.setScalar(0.82); visual.group.position.y = 0.85;
      visual.group.rotation.y = Math.PI / 2; group.add(visual.group);
    } else group.add(createAmmoModel(WEAPONS[weapon].color, this.textures));
    group.add(createDropBeacon(WEAPONS[weapon].color));
    group.position.set(position.x, 0, position.z); this.scene.add(group);
    const drop: Drop = { id: networkId ?? ++this.dropId, kind, weapon, mesh: group, life: 32, phase: this.rng() * Math.PI * 2, active: true };
    if (networkId) this.dropId = Math.max(this.dropId, networkId);
    this.drops.push(drop); return drop;
  }

  private removeDrop(drop: Drop): void {
    if (!drop.active) return;
    drop.active = false; this.scene.remove(drop.mesh); this.disposeObject(drop.mesh);
    if (this.nearestDrop === drop) this.nearestDrop = null;
    const index = this.drops.indexOf(drop); if (index >= 0) this.drops.splice(index, 1);
  }

  private updateDrops(dt: number): void {
    this.nearestDrop = null;
    let nearestDistance = 2.25;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      if (!this.net.active || this.net.isHost) {
        drop.life -= dt;
        if (drop.life <= 0) { this.removeDrop(drop); continue; }
      }
      drop.phase += dt * 2; drop.mesh.rotation.y += dt * 0.75;
      drop.mesh.position.y = Math.sin(drop.phase) * 0.07;
      const distance = Math.hypot(drop.mesh.position.x - this.camera.position.x, drop.mesh.position.z - this.camera.position.z);
      if (distance < nearestDistance) { nearestDistance = distance; this.nearestDrop = drop; }
    }
    if (this.nearestDrop) {
      const drop = this.nearestDrop;
      const action = drop.kind === "weapon" ? (this.inventory[drop.weapon].owned ? "ПАТРОНЫ ИЗ ОРУЖИЯ" : WEAPONS[drop.weapon].name) : `ПАТРОНЫ · ${WEAPONS[drop.weapon].short}`;
      this.el.pickup.textContent = `[ E ] ${action}`;
      this.el.pickup.classList.add("visible");
    } else this.el.pickup.classList.remove("visible");
  }

  private pickupDrop(drop: Drop): void {
    if (this.net.active && !this.net.isHost) {
      this.net.send({ type: "pickup", dropId: drop.id });
      this.el.pickup.classList.remove("visible");
      return;
    }
    this.grantDrop(drop.weapon, drop.kind); this.removeDrop(drop);
  }

  private grantDrop(weapon: WeaponId, kind: "ammo" | "weapon"): void {
    const item = this.inventory[weapon], spec = WEAPONS[weapon];
    if (kind === "weapon" && !item.owned) {
      item.owned = true; item.ammo = spec.mag; item.reserve = Math.floor(spec.startReserve * 0.55);
      this.showMessage("ОРУЖИЕ ПОЛУЧЕНО", spec.name, 1.25);
      this.switchWeapon(weapon, true);
    } else {
      const amount = spec.mag * 2;
      item.reserve = Math.min(spec.maxReserve, item.reserve + amount);
      this.showMessage("БОЕЗАПАС ПОПОЛНЕН", `${spec.short} +${amount}`, 0.9);
      this.updateHUD();
    }
    this.audio.sfx("pickup");
  }

  private explodeBarrel(barrel: Prop): void {
    if (barrel.exploded) return;
    const authoritative = !this.net.active || this.net.isHost;
    if (this.net.active && this.net.isHost) this.net.send({ type: "barrel", index: this.barrels.indexOf(barrel) });
    barrel.exploded = true;
    const raw = barrel.body.translation();
    const center = new THREE.Vector3(raw.x, raw.y, raw.z);
    barrel.mesh.visible = false; barrel.body.setEnabled(false);
    this.particles.burst(center, 0xff763e, 48, 8, this.rng, 0.8);
    this.particles.burst(center, 0xffcf65, 22, 4, this.rng, 1.1);
    this.audio.sfx("explosion");
    const radius = 6.5;
    for (const crate of this.crates) {
      const p = crate.body.translation();
      this.tmpA.set(p.x - center.x, p.y - center.y, p.z - center.z);
      const distance = this.tmpA.length();
      if (distance > 0.05 && distance < radius) {
        const force = 15 * (1 - distance / radius);
        this.tmpA.normalize().multiplyScalar(force); this.tmpA.y += force * 0.65;
        crate.body.applyImpulse(this.tmpA, true);
      }
    }
    if (authoritative) {
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const enemy = this.enemies[i], p = enemy.rb.translation();
        this.tmpA.set(p.x - center.x, p.y - center.y, p.z - center.z);
        const distance = this.tmpA.length();
        if (distance >= radius) continue;
        const falloff = 1 - distance / radius;
        enemy.hp -= 125 * falloff; enemy.hitFlash = 0.15;
        this.tmpA.normalize(); enemy.knockback.addScaledVector(this.tmpA, 8 * falloff); enemy.vy = Math.max(enemy.vy, 4 * falloff);
        if (enemy.hp <= 0) this.killEnemy(enemy, true);
      }
      for (const target of this.combatTargets()) {
        const distance = target.position.distanceTo(center);
        if (distance >= radius) continue;
        const damage = Math.max(1, Math.floor(42 * (1 - distance / radius)));
        if (!this.net.active || target.id === this.net.id || target.id === "local") this.damagePlayer(damage);
        else this.net.send({ type: "damage", targetId: target.id, amount: damage });
      }
    }
    for (const other of this.barrels) {
      if (other === barrel || other.exploded) continue;
      const p = other.body.translation();
      if (Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) < 4.2) this.explodeBarrel(other);
    }
  }

  private finishRun(victory: boolean): void {
    if (this.mode !== "playing") return;
    if (this.net.active && this.net.isHost) this.net.send({ type: "end", victory });
    this.mode = victory ? "victory" : "gameover"; this.mouseDown = false; this.wasPointerLocked = false;
    if (document.pointerLockElement) document.exitPointerLock();
    if (victory) this.score += Math.round(this.hp) * 20 + 1000;
    if (this.score > this.best) { this.best = this.score; storage.set("arenaBest", this.best); }
    this.audio.sfx(victory ? "win" : "lose");
    if (!victory) this.createRagdoll();
    for (const visual of this.viewWeapons.values()) visual.group.visible = false;
    this.el.hud.classList.add("hidden"); this.el.menu.classList.remove("hidden");
    this.el.title.innerHTML = victory ? "СЕКТОР<br><em>ЗАЧИЩЕН</em>" : "СВЯЗЬ<br><em>ПОТЕРЯНА</em>";
    this.el.description.textContent = victory
      ? `Пять волн позади. Счёт ${this.score} · устранено ${this.kills} · рекорд ${this.best}.`
      : `Волна ${this.wave.number} · устранено ${this.kills} · счёт ${this.score}. Перегруппируйтесь и попробуйте снова.`;
    this.el.stats.classList.add("hidden"); this.el.controls.classList.add("hidden");
    this.el.setup.classList.add("hidden"); this.el.lobby.classList.add("hidden");
    this.el.primary.innerHTML = this.net.active && !this.net.isHost ? "ОЖИДАНИЕ СОЗДАТЕЛЯ" : "ЕЩЁ ОДИН ЗАБЕГ <span>→</span>";
    this.el.primary.disabled = this.net.active && !this.net.isHost;
    this.el.secondary.textContent = "ПОКИНУТЬ КОМНАТУ"; this.el.secondary.classList.toggle("hidden", !this.net.active);
    this.el.footnote.textContent = this.net.active ? `КОМНАТА ${this.net.code} · создатель может начать новый бой` : "SPACE — быстрый рестарт · рекорд сохранён в этом браузере";
  }

  private createRagdoll(): void {
    this.clearRagdoll();
    const material = new THREE.MeshStandardMaterial({ map: this.textures.metal, color: 0x66868b, roughness: 0.75 });
    const sizes = [[0.52, 0.65, 0.3], [0.42, 0.42, 0.42], [0.2, 0.65, 0.22], [0.2, 0.65, 0.22], [0.24, 0.7, 0.25]] as const;
    for (let i = 0; i < sizes.length; i++) {
      const [w, h, d] = sizes[i];
      const partMesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      partMesh.castShadow = true; this.scene.add(partMesh);
      const offsetX = (i - 2) * 0.12;
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.camera.position.x + offsetX, Math.max(0.6, this.camera.position.y - 0.5 + (i === 1 ? 0.65 : 0)), this.camera.position.z)
        .setLinvel((this.rng() - 0.5) * 2.2, 1.5 + this.rng(), (this.rng() - 0.5) * 2.2)
        .setAngvel({ x: this.rng() * 3, y: this.rng() * 3, z: this.rng() * 3 }).setLinearDamping(0.45).setAngularDamping(0.6));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setDensity(0.8), body);
      this.ragdoll.push({ mesh: partMesh, body });
    }
  }

  private clearRagdoll(): void {
    for (const part of this.ragdoll) {
      this.scene.remove(part.mesh); part.mesh.geometry.dispose(); this.world.removeRigidBody(part.body);
    }
    this.ragdoll.length = 0;
  }

  private syncDynamic(): void {
    for (const prop of [...this.crates, ...this.barrels]) {
      if (prop.exploded) continue;
      const p = prop.body.translation(), r = prop.body.rotation();
      prop.mesh.position.set(p.x, p.y, p.z); prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    for (const part of this.ragdoll) {
      const p = part.body.translation(), r = part.body.rotation();
      part.mesh.position.set(p.x, p.y, p.z); part.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  private render(): void {
    if (this.disposed) return;
    const now = performance.now();
    this.frameTime += now - this.lastRenderTime; this.lastRenderTime = now; this.frameCount++;
    if (this.frameTime >= 700) {
      this.fps = this.frameCount * 1000 / this.frameTime; this.frameCount = 0; this.frameTime = 0;
    }
    this.audio.updateListener(this.camera);
    this.renderer.render(this.scene, this.camera);
    window.__GAME_READY__ = true;
  }

  private installProbes(): void {
    window.__gameProbe = () => ({ x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z });
    if (new URLSearchParams(window.location.search).has("debug")) {
      window.__gameDebug = {
        start: () => this.startRun(false),
        snapshot: () => ({
          mode: this.mode, hp: this.hp, kills: this.kills, score: this.score, wave: this.wave.number,
          enemies: this.enemies.map((e) => ({ id: e.id, kind: e.kind, x: e.mesh.position.x, y: e.mesh.position.y, z: e.mesh.position.z, hp: e.hp })),
          bullets: this.bullets.filter((b) => b.active).length, drops: this.drops.length,
          currentWeapon: this.currentWeapon, inventory: JSON.parse(JSON.stringify(this.inventory)),
          shotsFired: this.shotsFired, enemyShots: this.enemyShots, playerHits: this.playerHits,
          fps: this.fps, drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
          multiplayer: { active: this.net.active, host: this.net.isHost, code: this.net.code, id: this.net.id, dead: this.multiplayerDead, remote: [...this.remotePlayers.values()].map((player) => ({ id: player.id, x: player.mesh.position.x, y: player.mesh.position.y, z: player.mesh.position.z, hp: player.hp })) },
        }),
        giveWeapons: () => {
          for (const id of Object.keys(WEAPONS) as WeaponId[]) {
            this.inventory[id].owned = true;
            this.inventory[id].ammo = WEAPONS[id].mag; this.inventory[id].reserve = WEAPONS[id].startReserve;
          }
          this.updateHUD();
        },
        spawnEnemy: (kind: EnemyKind = "grunt") => this.spawnEnemy(kind, true).id,
        readyEnemies: () => { for (const enemy of this.enemies) enemy.fireTimer = 0; },
        spawnDrop: (weapon: WeaponId = "rifle", kind: "ammo" | "weapon" = "weapon") => {
          const position = new THREE.Vector3(this.camera.position.x - Math.sin(this.yaw) * 1.5, 0, this.camera.position.z - Math.cos(this.yaw) * 1.5);
          this.spawnDrop(position, weapon, kind);
        },
        killAll: () => {
          this.wave.toSpawn = 0;
          for (let i = this.enemies.length - 1; i >= 0; i--) this.killEnemy(this.enemies[i], true);
        },
        damagePlayer: (amount: number) => this.damagePlayer(amount),
        teleport: (x: number, z: number) => {
          this.playerBody.setTranslation({ x, y: PLAYER_CENTER + 0.02, z }, true);
          this.camera.position.set(x, PLAYER_CENTER + GAME.EYE_OFFSET + 0.02, z); this.sendPlayerState();
        },
        shootAt: (enemyId: number) => {
          const enemy = this.enemies.find((item) => item.id === enemyId); if (!enemy) return;
          this.tmpA.copy(enemy.mesh.position).add(new THREE.Vector3(0, 1.15, 0)).sub(this.camera.position);
          this.yaw = Math.atan2(-this.tmpA.x, -this.tmpA.z);
          this.pitch = Math.atan2(this.tmpA.y, Math.hypot(this.tmpA.x, this.tmpA.z));
          this.camera.rotation.order = "YXZ"; this.camera.rotation.set(this.pitch, this.yaw, 0); this.camera.updateMatrixWorld(true);
          this.fireCooldown = 0; this.attemptShoot();
        },
        win: () => { this.wave.number = GAME.MAX_WAVE; this.finishRun(true); },
      };
    }
  }

  private disposeObject(root: THREE.Object3D): void {
    root.traverse((object) => {
      const renderable = object as THREE.Mesh;
      renderable.geometry?.dispose();
      if (Array.isArray(renderable.material)) for (const material of renderable.material) material.dispose();
      else renderable.material?.dispose();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.loop.stop(); this.net.leave();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    for (const fn of this.cleanup) fn();
    this.input.dispose(); this.audio.dispose();
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      const renderable = object as THREE.Mesh;
      if (renderable.geometry) geometries.add(renderable.geometry);
      if (Array.isArray(renderable.material)) for (const material of renderable.material) materials.add(material);
      else if (renderable.material) materials.add(renderable.material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of Object.values(this.textures)) texture.dispose();
    this.particles.dispose(); this.world.free(); this.renderer.dispose();
    delete window.__gameProbe; delete window.__gameDebug; window.__GAME_READY__ = false;
  }
}
