import * as THREE from "three";
import { GAME } from "./config";
import type { Random } from "./procedural";

export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly positions = new Float32Array(GAME.MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(GAME.MAX_PARTICLES * 3);
  private readonly velocities = new Float32Array(GAME.MAX_PARTICLES * 3);
  private readonly life = new Float32Array(GAME.MAX_PARTICLES);
  private cursor = 0;
  private readonly color = new THREE.Color();

  constructor() {
    for (let i = 0; i < GAME.MAX_PARTICLES; i++) this.positions[i * 3 + 1] = -1000;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.1, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  burst(origin: THREE.Vector3, color: number, count: number, speed: number, rng: Random, upward = 0.5): void {
    this.color.setHex(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor++ % GAME.MAX_PARTICLES;
      const p = i * 3;
      const theta = rng() * Math.PI * 2;
      const y = rng() * 2 - 0.65;
      const radial = Math.sqrt(Math.max(0, 1 - Math.min(1, y * y)));
      const velocity = speed * (0.35 + rng() * 0.65);
      this.positions[p] = origin.x; this.positions[p + 1] = origin.y; this.positions[p + 2] = origin.z;
      this.velocities[p] = Math.cos(theta) * radial * velocity;
      this.velocities[p + 1] = (y + upward) * velocity;
      this.velocities[p + 2] = Math.sin(theta) * radial * velocity;
      this.colors[p] = this.color.r; this.colors[p + 1] = this.color.g; this.colors[p + 2] = this.color.b;
      this.life[i] = 0.28 + rng() * 0.48;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  update(dt: number): void {
    let changed = false;
    for (let i = 0; i < GAME.MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      const p = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[p + 1] = -1000;
      } else {
        this.velocities[p + 1] -= 9 * dt;
        this.positions[p] += this.velocities[p] * dt;
        this.positions[p + 1] += this.velocities[p + 1] * dt;
        this.positions[p + 2] += this.velocities[p + 2] * dt;
        this.velocities[p] *= 0.985; this.velocities[p + 2] *= 0.985;
      }
      changed = true;
    }
    if (changed) this.points.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
