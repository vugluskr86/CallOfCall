import * as THREE from "three";

export type Random = () => number;

export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(canvas: HTMLCanvasElement, anisotropy: number, pixel = false): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  if (pixel) {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapLinearFilter;
  }
  return texture;
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  return [canvas, ctx];
}

function noise(ctx: CanvasRenderingContext2D, size: number, rng: Random, strength: number): void {
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (rng() - 0.5) * strength;
    image.data[i] = Math.max(0, Math.min(255, image.data[i] + n));
    image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1] + n));
    image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2] + n));
  }
  ctx.putImageData(image, 0, 0);
}

export function createTextureSet(anisotropy: number) {
  const floor = (() => {
    const rng = mulberry32(1103);
    const [c, ctx] = makeCanvas(256);
    ctx.fillStyle = "#35454b";
    ctx.fillRect(0, 0, 256, 256);
    noise(ctx, 256, rng, 30);
    ctx.strokeStyle = "rgba(7,15,19,.72)";
    ctx.lineWidth = 5;
    for (let p = 0; p <= 256; p += 64) {
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(145,178,181,.18)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 18; i++) {
      const x = rng() * 256, y = rng() * 256;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + (rng() - 0.5) * 40, y + (rng() - 0.5) * 40);
      ctx.lineTo(x + (rng() - 0.5) * 55, y + (rng() - 0.5) * 55); ctx.stroke();
    }
    for (let x = 8; x < 256; x += 64) for (let y = 8; y < 256; y += 64) {
      ctx.fillStyle = "#17252a"; ctx.fillRect(x, y, 5, 5);
      ctx.fillStyle = "#688087"; ctx.fillRect(x + 1, y + 1, 2, 2);
    }
    return canvasTexture(c, anisotropy);
  })();

  const wall = (() => {
    const rng = mulberry32(2207);
    const [c, ctx] = makeCanvas(256);
    ctx.fillStyle = "#52616a"; ctx.fillRect(0, 0, 256, 256);
    noise(ctx, 256, rng, 38);
    for (let y = 0; y < 256; y += 64) {
      ctx.fillStyle = "rgba(10,20,26,.38)"; ctx.fillRect(0, y, 256, 4);
      const offset = (y / 64) % 2 ? 64 : 0;
      for (let x = offset; x < 256; x += 128) ctx.fillRect(x, y, 4, 64);
    }
    ctx.fillStyle = "rgba(205,222,216,.12)";
    for (let i = 0; i < 70; i++) ctx.fillRect(rng() * 256, rng() * 256, 1 + rng() * 3, 1 + rng() * 3);
    return canvasTexture(c, anisotropy);
  })();

  const metal = (() => {
    const rng = mulberry32(3301);
    const [c, ctx] = makeCanvas(256);
    const gradient = ctx.createLinearGradient(0, 0, 256, 256);
    gradient.addColorStop(0, "#34434b"); gradient.addColorStop(0.45, "#61717a"); gradient.addColorStop(1, "#26343b");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 256);
    noise(ctx, 256, rng, 20);
    for (let i = 0; i < 120; i++) {
      const shade = 120 + Math.floor(rng() * 100);
      ctx.strokeStyle = `rgba(${shade},${shade + 8},${shade + 12},${0.05 + rng() * 0.18})`;
      ctx.lineWidth = rng() < 0.85 ? 1 : 2;
      const x = rng() * 256, y = rng() * 256;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 8 + rng() * 45, y + (rng() - 0.5) * 4); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(6,13,17,.55)"; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 250, 250);
    return canvasTexture(c, anisotropy);
  })();

  const cloth = (base: string, accent: string, seed: number) => {
    const rng = mulberry32(seed);
    const [c, ctx] = makeCanvas(64);
    ctx.fillStyle = base; ctx.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 64; y += 8) for (let x = 0; x < 64; x += 8) {
      ctx.fillStyle = rng() > 0.72 ? accent : `rgba(255,255,255,${rng() * 0.055})`;
      ctx.fillRect(x, y, 8, 8);
      if (rng() > 0.55) { ctx.fillStyle = "rgba(0,0,0,.08)"; ctx.fillRect(x, y + 6, 8, 2); }
    }
    return canvasTexture(c, anisotropy, true);
  };

  const skin = (() => {
    const rng = mulberry32(9017);
    const [c, ctx] = makeCanvas(64);
    ctx.fillStyle = "#8fa28b"; ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 85; i++) {
      ctx.fillStyle = rng() > 0.5 ? "rgba(40,58,43,.14)" : "rgba(210,224,179,.1)";
      const s = 2 + Math.floor(rng() * 6); ctx.fillRect(rng() * 64, rng() * 64, s, s);
    }
    return canvasTexture(c, anisotropy, true);
  })();

  return {
    floor, wall, metal, skin,
    grunt: cloth("#526e63", "#3d5b52", 4101),
    runner: cloth("#796342", "#9b7743", 4102),
    heavy: cloth("#525d6d", "#343e4c", 4103),
  };
}

export type TextureSet = ReturnType<typeof createTextureSet>;
