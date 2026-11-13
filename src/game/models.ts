import * as THREE from "three";
import type { EnemyKind, WeaponId } from "./config";
import { WEAPONS } from "./config";
import type { TextureSet } from "./procedural";

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export interface WeaponVisual {
  group: THREE.Group;
  muzzle: THREE.Object3D;
}

export function createWeaponModel(id: WeaponId, textures: TextureSet, enemy = false): WeaponVisual {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ map: textures.metal, color: enemy ? 0x6f7474 : 0xa5b0b5, roughness: 0.38, metalness: 0.78 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x151d23, roughness: 0.65, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: WEAPONS[id].color, roughness: 0.5, metalness: 0.35 });
  const add = (m: THREE.Mesh) => { group.add(m); return m; };

  if (id === "pistol") {
    add(mesh(box(0.13, 0.14, 0.42), metal, 0, 0.03, -0.2));
    add(mesh(box(0.1, 0.25, 0.13), dark, 0, -0.13, -0.03)).rotation.x = -0.18;
    add(mesh(box(0.135, 0.025, 0.24), accent, 0, 0.115, -0.24));
    add(mesh(box(0.035, 0.045, 0.035), dark, 0, 0.15, -0.35));
  } else if (id === "rifle") {
    add(mesh(box(0.15, 0.18, 0.66), metal, 0, 0, -0.32));
    add(mesh(box(0.11, 0.12, 0.35), dark, 0, 0.015, -0.79));
    add(mesh(box(0.045, 0.045, 0.35), metal, 0, 0.02, -1.05));
    add(mesh(box(0.12, 0.3, 0.16), dark, 0, -0.2, -0.3)).rotation.x = 0.16;
    add(mesh(box(0.1, 0.22, 0.12), dark, 0, -0.15, -0.02)).rotation.x = -0.2;
    add(mesh(box(0.14, 0.15, 0.32), dark, 0, -0.01, 0.16));
    add(mesh(box(0.055, 0.065, 0.26), accent, 0, 0.13, -0.32));
    add(mesh(box(0.035, 0.07, 0.035), dark, 0, 0.17, -0.65));
  } else {
    add(mesh(box(0.19, 0.22, 0.76), metal, 0, 0, -0.38));
    add(mesh(box(0.13, 0.14, 0.46), dark, 0, 0.02, -0.91));
    add(mesh(box(0.06, 0.06, 0.48), metal, 0, 0.02, -1.29));
    add(mesh(box(0.21, 0.3, 0.28), accent, -0.15, -0.17, -0.35));
    add(mesh(box(0.12, 0.25, 0.14), dark, 0, -0.18, -0.04)).rotation.x = -0.18;
    add(mesh(box(0.17, 0.18, 0.38), dark, 0, -0.01, 0.18));
    add(mesh(box(0.04, 0.26, 0.04), dark, -0.09, -0.19, -0.93)).rotation.x = -0.28;
    add(mesh(box(0.04, 0.26, 0.04), dark, 0.09, -0.19, -0.93)).rotation.x = -0.28;
    add(mesh(box(0.16, 0.035, 0.42), accent, 0, 0.14, -0.42));
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, id === "pistol" ? -0.46 : id === "rifle" ? -1.25 : -1.56);
  group.add(muzzle);
  group.userData.weaponId = id;
  return { group, muzzle };
}

export interface EnemyVisual {
  group: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  muzzle: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
}

export function createEnemyModel(kind: EnemyKind, textures: TextureSet): EnemyVisual {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    map: textures[kind], roughness: 0.88, metalness: kind === "heavy" ? 0.16 : 0.02,
    emissive: 0x000000, emissiveIntensity: 0,
  });
  const skinMat = new THREE.MeshStandardMaterial({ map: textures.skin, color: kind === "runner" ? 0xc0aa78 : 0xa6b69d, roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a252b, roughness: 0.75, metalness: 0.2 });
  const armor = new THREE.MeshStandardMaterial({ map: textures.metal, color: kind === "heavy" ? 0x9b6957 : 0x5d6a70, roughness: 0.55, metalness: 0.55 });
  const eye = new THREE.MeshBasicMaterial({ color: kind === "heavy" ? 0xff4b32 : 0xffb13b });

  const torso = mesh(box(kind === "heavy" ? 0.78 : 0.64, 0.7, 0.34), bodyMaterial, 0, 1.08, 0);
  const head = mesh(box(0.48, 0.48, 0.48), skinMat, 0, 1.69, 0);
  head.userData.hitPart = "head";
  group.add(torso, head);
  group.add(mesh(box(0.075, 0.07, 0.018), eye, -0.12, 1.74, -0.249));
  group.add(mesh(box(0.075, 0.07, 0.018), eye, 0.12, 1.74, -0.249));
  group.add(mesh(box(0.18, 0.035, 0.018), dark, 0, 1.57, -0.25));
  group.add(mesh(box(0.68, 0.1, 0.37), armor, 0, 0.82, 0));

  const limb = (x: number, y: number, arm: boolean) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const width = arm ? (kind === "heavy" ? 0.24 : 0.19) : 0.25;
    const part = mesh(box(width, arm ? 0.72 : 0.74, 0.26), arm ? bodyMaterial : dark, 0, arm ? -0.3 : -0.35, 0);
    pivot.add(part); group.add(pivot); return pivot;
  };
  const leftArm = limb(kind === "heavy" ? -0.51 : -0.43, 1.38, true);
  const rightArm = limb(kind === "heavy" ? 0.51 : 0.43, 1.38, true);
  const leftLeg = limb(-0.18, 0.72, false);
  const rightLeg = limb(0.18, 0.72, false);

  if (kind === "heavy") {
    group.add(mesh(box(0.3, 0.18, 0.45), armor, -0.5, 1.42, 0));
    group.add(mesh(box(0.3, 0.18, 0.45), armor, 0.5, 1.42, 0));
    group.add(mesh(box(0.54, 0.42, 0.09), armor, 0, 1.12, -0.215));
  } else if (kind === "runner") {
    group.add(mesh(box(0.5, 0.09, 0.39), armor, 0, 1.4, 0));
  }

  const weapon = createWeaponModel(kind === "heavy" ? "lmg" : kind === "runner" ? "pistol" : "rifle", textures, true);
  weapon.group.scale.setScalar(kind === "heavy" ? 0.52 : 0.46);
  weapon.group.position.set(kind === "heavy" ? 0.48 : 0.4, 1.14, -0.38);
  group.add(weapon.group);
  rightArm.rotation.x = 0.85;

  const muzzleFlash = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.12, 0),
    new THREE.MeshBasicMaterial({ color: 0xffc25a, transparent: true, opacity: 0.95 }),
  );
  muzzleFlash.visible = false;
  weapon.muzzle.add(muzzleFlash);
  group.userData.enemyRoot = true;
  return { group, leftArm, rightArm, leftLeg, rightLeg, bodyMaterial, muzzle: weapon.muzzle, muzzleFlash };
}

export function createPlayerModel(name: string, textures: TextureSet, colorIndex: number): { visual: EnemyVisual; label: THREE.Sprite } {
  const visual = createEnemyModel("grunt", textures);
  const colors = [0x43d9c1, 0xf0a54a, 0x73a9ff, 0xd687e8];
  visual.group.scale.setScalar(0.96);
  visual.bodyMaterial.color.setHex(colors[colorIndex % colors.length]);
  visual.bodyMaterial.emissive.setHex(0x000000);
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgba(3, 12, 17, .78)"; context.fillRect(0, 5, 256, 50);
  context.strokeStyle = "#72e5ce"; context.lineWidth = 2; context.strokeRect(1, 6, 254, 48);
  context.fillStyle = "#effffb"; context.font = "600 25px monospace";
  context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText(name.slice(0, 16), 128, 31, 238);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  label.position.set(0, 2.35, 0); label.scale.set(1.9, 0.48, 1);
  visual.group.add(label);
  return { visual, label };
}

export function createAmmoModel(color: number, textures: TextureSet): THREE.Group {
  const group = new THREE.Group();
  const crate = new THREE.MeshStandardMaterial({ map: textures.metal, color: 0x6c7b76, roughness: 0.65, metalness: 0.35 });
  const glow = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.45 });
  group.add(mesh(box(0.62, 0.36, 0.46), crate, 0, 0.24, 0));
  group.add(mesh(box(0.64, 0.07, 0.48), glow, 0, 0.43, 0));
  for (let i = -1; i <= 1; i++) {
    const bullet = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 6), glow, i * 0.12, 0.57, 0);
    group.add(bullet);
  }
  return group;
}

export function createDropBeacon(color: number): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.54, 0.66, 24), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.025;
  return ring;
}
