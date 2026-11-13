import * as THREE from "three";
import type { WeaponId } from "./config";

export type SfxId = "hit" | "headshot" | "pickup" | "ui" | "explosion" | "win" | "lose" | "reload" | "empty" | "hurt";
const MUTE_KEY = "game.muted";

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private music: OscillatorNode[] = [];
  private disposed = false;
  private seed = 0x12345678;
  muted = readMuted();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private readonly unlock = () => { this.ensureCtx(); this.detachUnlock(); };

  constructor() {
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  private detachUnlock(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private ensureCtx(): AudioContext {
    if (this.disposed) throw new Error("Audio disposed");
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.48;
      this.master.connect(this.ctx.destination);
      const length = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = this.rand() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? "1" : "0"); } catch { /* local mode still works */ }
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.48;
    return this.muted;
  }

  private tone(type: OscillatorType, f0: number, f1: number, duration: number, gain: number, at = 0, destination?: AudioNode): void {
    if (this.disposed || this.muted) return;
    const ctx = this.ensureCtx();
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const t = ctx.currentTime + at;
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + duration);
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(env).connect(destination ?? this.master!);
    osc.start(t); osc.stop(t + duration + 0.01);
  }

  private burst(duration: number, gain: number, cutoff: number, destination?: AudioNode): void {
    if (this.disposed || this.muted) return;
    const ctx = this.ensureCtx();
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    const t = ctx.currentTime;
    src.buffer = this.noise;
    filter.type = "lowpass"; filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + duration);
    env.gain.setValueAtTime(gain, t); env.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(env).connect(destination ?? this.master!);
    src.start(t, this.rand() * 0.5, duration); src.stop(t + duration + 0.01);
  }

  shot(id: WeaponId): void {
    if (id === "pistol") { this.burst(0.12, 0.55, 2600); this.tone("square", 170, 65, 0.11, 0.2); }
    else if (id === "rifle") { this.burst(0.1, 0.45, 3200); this.tone("sawtooth", 135, 52, 0.09, 0.16); }
    else { this.burst(0.13, 0.52, 2300); this.tone("square", 105, 42, 0.12, 0.22); }
  }

  enemyShot(position: THREE.Vector3): void {
    if (this.disposed || this.muted) return;
    const ctx = this.ensureCtx();
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF"; panner.distanceModel = "inverse";
    panner.refDistance = 4; panner.maxDistance = 65; panner.rolloffFactor = 1.25;
    panner.positionX.value = position.x; panner.positionY.value = position.y; panner.positionZ.value = position.z;
    panner.connect(this.master!);
    this.burst(0.12, 0.32, 1800, panner);
    this.tone("square", 120, 55, 0.1, 0.12, 0, panner);
  }

  sfx(id: SfxId): void {
    if (this.disposed || this.muted) return;
    if (id === "reload") {
      this.tone("square", 1500, 900, 0.035, 0.1);
      this.tone("square", 900, 1400, 0.04, 0.1, 0.3);
      this.tone("square", 1200, 2100, 0.045, 0.1, 0.75);
      return;
    }
    if (id === "empty") { this.tone("square", 800, 500, 0.035, 0.12); return; }
    if (id === "explosion") { this.burst(0.48, 0.65, 800); this.tone("sine", 85, 25, 0.5, 0.55); return; }
    const spec: Record<Exclude<SfxId, "reload" | "empty" | "explosion">, [OscillatorType, number, number, number, number]> = {
      hit: ["square", 1200, 1700, 0.055, 0.16], headshot: ["square", 1700, 2500, 0.08, 0.2],
      pickup: ["sine", 620, 1120, 0.14, 0.2], ui: ["sine", 420, 560, 0.06, 0.13],
      win: ["sine", 520, 1040, 0.55, 0.25], lose: ["sawtooth", 190, 45, 0.65, 0.25],
      hurt: ["sawtooth", 110, 60, 0.16, 0.2],
    };
    const [type, f0, f1, dur, gain] = spec[id];
    this.tone(type, f0, f1, dur, gain);
  }

  updateListener(camera: THREE.Camera): void {
    if (!this.ctx) return;
    camera.getWorldDirection(this.forward);
    const p = camera.position;
    const listener = this.ctx.listener;
    if (listener.positionX) {
      listener.positionX.value = p.x; listener.positionY.value = p.y; listener.positionZ.value = p.z;
      listener.forwardX.value = this.forward.x; listener.forwardY.value = this.forward.y; listener.forwardZ.value = this.forward.z;
      listener.upX.value = this.up.x; listener.upY.value = this.up.y; listener.upZ.value = this.up.z;
    }
  }

  startMusic(): void {
    if (this.disposed || this.music.length) return;
    const ctx = this.ensureCtx();
    for (const [frequency, volume] of [[55, 0.035], [82.5, 0.014]] as const) {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = frequency; gain.gain.value = volume;
      osc.connect(gain).connect(this.master!); osc.start(); this.music.push(osc);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.detachUnlock();
    for (const osc of this.music) { try { osc.stop(); } catch { /* already stopped */ } }
    this.music = []; this.master?.disconnect();
    const ctx = this.ctx; this.ctx = null; this.master = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }
}
