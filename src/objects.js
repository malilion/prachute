// Foreground actors: skydiver, jump plane, ram-air canopy, score rings, wind streaks.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Orientation fixes for the generated models (authored upright / arbitrary yaw).
const DIVER_YAW = Math.PI; // so the belly faces the ground once pitched forward
const PLANE_YAW = Math.PI;
const PLANE_SPAN = 17; // metres across the model's longest horizontal axis

export async function loadModels() {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL + 'models/';
  const [diver, plane] = await Promise.all([
    loader.loadAsync(base + 'skydiver.glb'),
    loader.loadAsync(base + 'plane.glb'),
  ]);
  for (const g of [diver, plane]) {
    g.scene.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.material.envMapIntensity = 0.6;
        o.material.metalness = Math.min(o.material.metalness, 0.3);
        o.material.roughness = Math.max(o.material.roughness, 0.55);
      }
    });
  }
  return { diver: diver.scene, plane: plane.scene };
}

function normalized(model, targetSize, axis) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const k = targetSize / (axis ? size[axis] : Math.max(size.x, size.y, size.z));
  model.position.sub(center).multiplyScalar(k);
  model.scale.setScalar(k);
  const holder = new THREE.Group();
  holder.add(model);
  return holder;
}

export function buildDiver(model) {
  // root: world position + heading. tilt: pitch/roll pose. fix: model-space correction.
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  const fix = normalized(model, 1.95, 'y');
  fix.rotation.y = DIVER_YAW;
  tilt.add(fix);
  root.add(tilt);
  return { root, tilt };
}

export function buildPlane(model) {
  const root = new THREE.Group();
  const fix = normalized(model, PLANE_SPAN);
  fix.rotation.y = PLANE_YAW;
  root.add(fix);
  // spinning prop discs read better than frozen blades
  const discMat = new THREE.MeshBasicMaterial({
    color: 0xdfe6ee, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
  });
  root.userData.discMat = discMat;
  return root;
}

const CANOPY_COLORS = [0xff5a1f, 0xfff4e0, 0xff5a1f, 0xfff4e0, 0x14b8a6, 0xfff4e0, 0xff5a1f, 0xfff4e0, 0xff5a1f];

export function buildCanopy() {
  const cells = 9;
  const perCell = 5;
  const nu = cells * perCell;
  const nv = 12;
  const lineLen = 6.4;
  const halfAngle = 0.52;
  const chord = 3.5;
  const pos = [];
  const col = [];
  const idx = [];
  const c = new THREE.Color();

  const point = (u, v, side) => {
    const a = (u * 2 - 1) * halfAngle;
    const nx = Math.sin(a);
    const ny = Math.cos(a);
    const th = 1.15 * Math.sqrt(v) * Math.pow(1 - v, 0.9) * 0.42; // airfoil thickness
    const cellPhase = Math.abs(Math.sin(Math.PI * u * cells));
    const bulge = 0.1 * cellPhase * Math.sqrt(Math.sin(Math.PI * Math.min(Math.max(v, 0.02), 0.98)));
    const off = side > 0 ? th + bulge : -th * 0.12 + bulge * 0.3;
    const r = lineLen + off;
    return [nx * r, ny * r, (v - 0.32) * chord];
  };

  for (const side of [1, -1]) {
    const start = pos.length / 3;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const cell = Math.min(Math.floor(u * cells), cells - 1);
      c.setHex(CANOPY_COLORS[cell]);
      if (side < 0) c.multiplyScalar(0.72);
      for (let j = 0; j <= nv; j++) {
        const v = j / nv;
        pos.push(...point(u, v, side));
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = start + i * (nv + 1) + j;
        const b = a + nv + 1;
        if (side > 0) idx.push(a, a + 1, b, b, a + 1, b + 1);
        else idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const wing = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  wing.frustumCulled = false;

  // suspension lines: two per rib, gathered into left/right risers
  const lp = [];
  for (let r = 0; r <= cells; r++) {
    const u = r / cells;
    const riserX = u < 0.5 ? -0.24 : 0.24;
    for (const v of [0.08, 0.62]) {
      const p = point(u, v, -1);
      lp.push(riserX, 0.45, v < 0.3 ? -0.08 : 0.12, p[0], p[1], p[2]);
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const lines = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({ color: 0x1b1f24, transparent: true, opacity: 0.75 }),
  );
  lines.frustumCulled = false;

  const group = new THREE.Group();
  group.add(wing, lines);
  group.rotation.x = -0.1;
  group.visible = false;
  return group;
}

export class Rings {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.geo = new THREE.TorusGeometry(15, 0.55, 10, 64);
    this.geo.rotateX(Math.PI / 2);
    this.glowGeo = new THREE.RingGeometry(9, 15, 64);
    this.glowGeo.rotateX(-Math.PI / 2);
  }

  clear() {
    for (const r of this.items) this.scene.remove(r.group);
    this.items.length = 0;
  }

  add(x, y, z) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.9, 0.5), transparent: true });
    const glow = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.0, 1.1, 0.3), transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.geo, mat), new THREE.Mesh(this.glowGeo, glow));
    group.position.set(x, y, z);
    this.scene.add(group);
    const ring = { group, mat, glow, state: 'live', t: 0, radius: 15 };
    this.items.push(ring);
    return ring;
  }

  next(y) {
    for (const r of this.items) if (r.state === 'live' && r.group.position.y < y) return r;
    return null;
  }

  // Called once per frame with the diver's previous and current position.
  update(dt, time, prev, cur, camera, fade, onHit, onMiss) {
    for (const r of this.items) {
      const p = r.group.position;
      if (r.state === 'live') {
        if (prev.y > p.y && cur.y <= p.y) {
          const k = (prev.y - p.y) / Math.max(prev.y - cur.y, 1e-4);
          const x = prev.x + (cur.x - prev.x) * k;
          const z = prev.z + (cur.z - prev.z) * k;
          if (Math.hypot(x - p.x, z - p.z) < r.radius + 1.0) {
            r.state = 'hit';
            onHit(r);
          } else {
            r.state = 'missed';
            onMiss(r);
          }
          r.t = 0;
        }
        const dist = camera.position.distanceTo(p);
        const vis = THREE.MathUtils.smoothstep(dist, 1500, 700) * fade;
        const pulse = 1 + 0.04 * Math.sin(time * 4 + p.y);
        r.group.scale.setScalar(pulse);
        r.mat.opacity = vis;
        r.glow.opacity = 0.14 * vis;
        r.group.visible = vis > 0.01;
      } else {
        r.t += dt;
        if (r.state === 'hit') {
          r.group.scale.setScalar(1 + r.t * 3.5);
          r.mat.opacity = Math.max(0, 1 - r.t * 2.2);
          r.glow.opacity = Math.max(0, 0.5 - r.t * 1.2);
        } else {
          r.mat.opacity = Math.max(0, 0.5 - r.t * 1.5);
          r.glow.opacity = 0;
        }
        r.group.visible = r.mat.opacity > 0.01;
      }
    }
  }
}

// World-static air specks; the camera rushing past them makes the speed lines.
export class WindStreaks {
  constructor(scene, count = 260) {
    this.count = count;
    this.box = 46;
    this.points = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) this.points[i] = (Math.random() - 0.5) * this.box;
    this.positions = new Float32Array(count * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
    scene.add(this.lines);
  }

  update(camera, velocity, mist) {
    const h = this.box / 2;
    const c = camera.position;
    const speed = velocity.length();
    const len = 0.028;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      // wrap each speck into the box centred on the camera
      for (let a = 0; a < 3; a++) {
        const cc = a === 0 ? c.x : a === 1 ? c.y : c.z;
        let d = this.points[k + a] - cc;
        d = ((((d + h) % this.box) + this.box) % this.box) - h;
        this.points[k + a] = cc + d;
      }
      const o = i * 6;
      this.positions[o] = this.points[k];
      this.positions[o + 1] = this.points[k + 1];
      this.positions[o + 2] = this.points[k + 2];
      this.positions[o + 3] = this.points[k] - velocity.x * len;
      this.positions[o + 4] = this.points[k + 1] - velocity.y * len;
      this.positions[o + 5] = this.points[k + 2] - velocity.z * len;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    const target = THREE.MathUtils.smoothstep(speed, 14, 60) * (0.16 + 0.3 * mist);
    this.material.opacity += (target - this.material.opacity) * 0.1;
  }
}
