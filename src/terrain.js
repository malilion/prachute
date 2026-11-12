// Ground: one polar-grid mesh displaced and shaded from a shared height field.
// Flat drop zone in the middle, lakes, hills and a coastline further out.
import * as THREE from 'three';
import { SKY_LUT_GLSL } from './sky.js';
import { CLOUD_WEATHER_GLSL, CLOUD } from './clouds.js';

export const WORLD = {
  radius: 110000,
  flatRadius: 5200, // guaranteed level ground around the drop zone
  playRadius: 4300, // soft airspace boundary for the player
  runway: { x: 260, z: -80, halfW: 16, halfL: 520 },
};

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p = r * p * 2.03 + 17.7;
    a *= 0.5;
  }
  return s;
}
// Signed terrain height in metres; negative means water.
float terrainHeight(vec2 p, int oct) {
  float d = length(p);
  float mask = smoothstep(${WORLD.flatRadius.toFixed(1)}, 15000.0, d);
  float n = fbm(p / 9500.0 + 3.1, oct);
  float ridge = 1.0 - abs(2.0 * fbm(p / 21000.0 - 7.3, 4) - 1.0);
  float h = mask * ((n * n * 1500.0 - 170.0) + ridge * ridge * 420.0 * smoothstep(12000.0, 40000.0, d));
  float coast = smoothstep(11000.0, 26000.0, p.x * 0.85 - p.y * 0.5 + 9000.0 * (fbm(p / 16000.0, 3) - 0.5));
  h = mix(h, -90.0 - 60.0 * n, coast);
  return h;
}
`;

function polarGrid(radius, rings, segments) {
  const pos = new Float32Array((rings * segments + 1) * 3);
  const idx = [];
  let k = 3; // vertex 0 = centre
  for (let r = 1; r <= rings; r++) {
    const rr = radius * Math.pow(r / rings, 2.6);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos[k++] = Math.cos(a) * rr;
      pos[k++] = 0;
      pos[k++] = Math.sin(a) * rr;
    }
  }
  const at = (r, s) => 1 + (r - 1) * segments + (s % segments);
  for (let s = 0; s < segments; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = at(r, s), b = at(r, s + 1), c = at(r + 1, s), d = at(r + 1, s + 1);
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class Terrain {
  constructor(sky, clouds) {
    this.group = new THREE.Group();
    const rw = WORLD.runway;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tSky: { value: sky.lut.texture },
        tWeather: { value: clouds.assets.weather },
        uWeatherOffset: { value: clouds.weatherOffset },
        uCoverage: { value: CLOUD.coverage },
        uSunDir: { value: sky.sunDir },
        uSunColor: { value: sky.sunColor },
        uAmbient: { value: sky.ambientTop },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        ${NOISE_GLSL}
        void main() {
          vec3 p = position;
          p.y = max(terrainHeight(p.xz, 5), 0.0);
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorld;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform float uTime;
        ${NOISE_GLSL}
        ${SKY_LUT_GLSL}
        ${CLOUD_WEATHER_GLSL}

        float ringMask(float d, float r, float w, float aa) {
          return 1.0 - smoothstep(w, w + aa, abs(d - r));
        }

        void main() {
          vec2 p = vWorld.xz;
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          float px = dist * 0.0012; // approx pixel footprint in metres

          float h = terrainHeight(p, 7);
          float e = max(12.0, px * 2.0);
          float hx = terrainHeight(p + vec2(e, 0.0), 7);
          float hz = terrainHeight(p + vec2(0.0, e), 7);
          vec3 N = normalize(vec3(h - hx, e, h - hz));
          float slope = 1.0 - N.y;

          float shadow = cloudShadow(vWorld, uSunDir);
          float ndl = max(dot(N, uSunDir), 0.0);
          vec3 col;

          if (h < -1.0) {
            // ---- water ----
            float depth = clamp(-h / 70.0, 0.0, 1.0);
            vec2 wp = p * 0.05 + vec2(uTime * 0.35, uTime * 0.2);
            float fadeW = 1.0 / (1.0 + px * 0.6);
            vec3 Nw = normalize(vec3((vnoise(wp) - 0.5) * 0.35 * fadeW, 1.0, (vnoise(wp + 31.0) - 0.5) * 0.35 * fadeW));
            vec3 R = reflect(-V, Nw);
            R.y = abs(R.y);
            float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, Nw), 0.0), 5.0);
            vec3 deep = mix(vec3(0.05, 0.27, 0.3), vec3(0.012, 0.07, 0.14), depth);
            vec3 body = deep * (uSunColor * 0.16 * (0.35 + 0.65 * shadow) + uAmbient * 0.5);
            float glint = pow(max(dot(R, uSunDir), 0.0), 220.0 / (1.0 + px * 0.8)) * 3.0;
            col = mix(body, skyLUT(R), fres) + uSunColor * glint * shadow * 0.6;
            // shoreline foam
            col = mix(col, vec3(0.8) * (uSunColor * 0.2 + uAmbient * 0.5), smoothstep(-6.0, -1.0, h) * 0.5);
          } else {
            // ---- land ----
            vec2 q = p + 240.0 * (vec2(fbm(p / 1700.0, 3), fbm(p / 1700.0 + 9.1, 3)) - 0.5);
            // field patchwork
            vec2 cell = floor(q / 340.0);
            vec2 cf = fract(q / 340.0);
            vec2 rnd = hash22(cell);
            vec2 sub = floor(cf * (1.0 + floor(rnd * 2.99)));
            vec2 rnd2 = hash22(cell * 3.7 + sub + 11.0);
            vec3 crop = mix(vec3(0.20, 0.38, 0.10), vec3(0.66, 0.56, 0.20), rnd2.x * rnd2.x);
            crop = mix(crop, vec3(0.34, 0.24, 0.14), step(0.8, rnd2.y));
            crop = mix(crop, vec3(0.30, 0.46, 0.14), step(rnd2.y, 0.25));
            // plough lines when close
            float rows = sin((rnd2.x > 0.5 ? q.x : q.y) * 1.3) * 0.5 + 0.5;
            crop *= 1.0 - 0.14 * rows / (1.0 + px * 1.5);
            vec2 edge = min(cf, 1.0 - cf) * 340.0;
            float border = 1.0 - smoothstep(2.5 + px, 5.0 + px * 2.0, min(edge.x, edge.y));
            crop = mix(crop, vec3(0.16, 0.24, 0.08), border * 0.7);

            float wild = fbm(p / 2600.0 + 40.0, 4);
            float forest = smoothstep(0.5, 0.58, wild + 0.25 * fbm(p / 300.0, 3) - 0.1);
            vec3 meadow = mix(vec3(0.23, 0.36, 0.11), vec3(0.36, 0.42, 0.16), fbm(p / 420.0, 3));
            vec3 land = mix(crop, meadow, smoothstep(0.42, 0.5, wild));
            vec3 forestCol = vec3(0.055, 0.15, 0.06) * (0.7 + 0.6 * fbm(p / 38.0, 2));
            land = mix(land, forestCol, forest);

            // drop zone is a mown clearing
            float dz = length(p);
            land = mix(vec3(0.26, 0.42, 0.13), land, smoothstep(160.0, 420.0, dz));

            // altitude / slope bands
            vec3 rock = mix(vec3(0.34, 0.31, 0.28), vec3(0.46, 0.43, 0.39), fbm(p / 90.0, 3));
            land = mix(land, vec3(0.27, 0.33, 0.14), smoothstep(250.0, 700.0, h));
            land = mix(land, rock, smoothstep(0.1, 0.24, slope + 0.04 * (fbm(p / 60.0, 2) - 0.5)));
            land = mix(land, rock, smoothstep(950.0, 1250.0, h));
            land = mix(land, vec3(0.62, 0.56, 0.4), smoothstep(7.0, 0.5, h) * step(0.5, h + 1.0) * smoothstep(${WORLD.flatRadius.toFixed(1)}, ${(WORLD.flatRadius + 600).toFixed(1)}, dz));

            // close-range grain so the ground holds up under canopy
            float grain = fbm(p * 0.9, 3) * 0.6 + fbm(p * 0.11, 3) * 0.4;
            land *= mix(1.0, 0.72 + 0.56 * grain, 1.0 / (1.0 + px * 0.9));

            // runway
            vec2 rp = p - vec2(${rw.x.toFixed(1)}, ${rw.z.toFixed(1)});
            float aa = px + 0.2;
            float inRw = (1.0 - smoothstep(${rw.halfW.toFixed(1)}, ${rw.halfW.toFixed(1)} + aa, abs(rp.x)))
                       * (1.0 - smoothstep(${rw.halfL.toFixed(1)}, ${rw.halfL.toFixed(1)} + aa, abs(rp.y)));
            vec3 asphalt = vec3(0.105, 0.11, 0.12) * (0.85 + 0.3 * vnoise(p * 0.6));
            float dash = step(0.5, fract(rp.y / 60.0)) * (1.0 - smoothstep(0.6, 0.6 + aa, abs(rp.x)));
            float edgeLine = 1.0 - smoothstep(0.5, 0.5 + aa, abs(abs(rp.x) - ${(rw.halfW - 1.5).toFixed(1)}));
            asphalt = mix(asphalt, vec3(0.8), max(dash, edgeLine) * 0.85);
            land = mix(land, asphalt, inRw);

            // landing target
            float tAA = px * 0.8 + 0.15;
            float bull = 1.0 - smoothstep(4.0, 4.0 + tAA, dz);
            float rings = max(ringMask(dz, 15.0, 1.2, tAA), ringMask(dz, 32.0, 1.6, tAA));
            float outer = ringMask(dz, 60.0, 2.2, tAA);
            land = mix(land, vec3(0.95, 0.93, 0.88), max(rings, outer * 0.85));
            land = mix(land, vec3(1.0, 0.36, 0.05), bull);

            col = land * 1.35 * (uSunColor * ndl * shadow * 0.32 + uAmbient * (0.5 + 0.25 * N.y));
          }

          // aerial perspective toward the horizon haze
          vec3 hd = normalize(vec3(-V.x, max(-V.y, 0.0) + 0.012, -V.z));
          float T = exp(-dist / ${CLOUD.hazeDistance.toFixed(1)});
          float rim = smoothstep(${(WORLD.radius * 0.72).toFixed(1)}, ${(WORLD.radius * 0.98).toFixed(1)}, length(p));
          T *= 1.0 - rim;
          col = col * T + skyLUT(hd) * (1.0 - T);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(polarGrid(WORLD.radius, 230, 288), this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.group.add(buildTrees());
    this.group.add(buildWindsock());
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
  }
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTrees() {
  const rand = mulberry32(20261113);
  const crown = new THREE.ConeGeometry(2.6, 9, 7);
  crown.translate(0, 7.5, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const count = 2600;
  const mesh = new THREE.InstancedMesh(crown, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  const rw = WORLD.runway;
  let n = 0;
  while (n < count) {
    // clusters
    const cr = 220 + rand() * 3600;
    const ca = rand() * Math.PI * 2;
    const cx = Math.cos(ca) * cr;
    const cz = Math.sin(ca) * cr;
    const members = 12 + Math.floor(rand() * 40);
    const spread = 30 + rand() * 120;
    for (let i = 0; i < members && n < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * spread;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (Math.hypot(x, z) < 130) continue;
      if (Math.abs(x - rw.x) < rw.halfW + 40 && Math.abs(z - rw.z) < rw.halfL + 60) continue;
      const k = 0.7 + rand() * 0.9;
      p.set(x, 0, z);
      s.set(k, k * (0.85 + rand() * 0.5), k);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * 6.28);
      m.compose(p, q, s);
      mesh.setMatrixAt(n, m);
      c.setHSL(0.27 + rand() * 0.07, 0.45, 0.16 + rand() * 0.08);
      mesh.setColorAt(n, c);
      n++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

function buildWindsock() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 8, 6),
    new THREE.MeshLambertMaterial({ color: 0xdddddd }),
  );
  pole.position.y = 4;
  const sock = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.6, 3.4, 10, 1, true),
    new THREE.MeshLambertMaterial({ color: 0xff5a1f, side: THREE.DoubleSide }),
  );
  sock.rotation.z = Math.PI / 2 - 0.25;
  sock.position.set(1.7, 7.6, 0);
  g.add(pole, sock);
  g.position.set(75, 0, 20);
  return g;
}
