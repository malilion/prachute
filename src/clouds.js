// Volumetric clouds: weather-map coverage -> base shape carve -> height-dependent
// detail erosion, marched only inside the layer slab at reduced resolution.
import * as THREE from 'three';
import { fullscreenGeometry, SKY_LUT_GLSL } from './sky.js';

// Parameters grouped by perceptual role. Shared by the GPU march, the terrain
// cloud shadows and the CPU density probe.
export const CLOUD = {
  // layout (metres)
  low: { base: 1050, top: 2000, density: 1.0, shape: 1.0, detail: 1.0 },
  mid: { base: 1450, top: 2750, density: 0.85, shape: 0.9, detail: 0.8 },
  bottom: 1050,
  top: 2750,
  // weather
  coverage: 0.37,
  coverageWidth: 0.6,
  weatherTile: 52000,
  shapeScale: 1 / 5200,
  detailScale: 1 / 760,
  // optics
  sigma: 0.055,
  hazeDistance: 42000,
  // motion (m/s)
  weatherWind: [9, 3],
  shapeWind: [13, 0.6, 5],
  detailWind: [17, -1.5, 8],
};

const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

export const CLOUD_WEATHER_GLSL = /* glsl */ `
uniform sampler2D tWeather;
uniform vec2 uWeatherOffset;
uniform float uCoverage;
const float CL_BOTTOM = ${f(CLOUD.bottom)};
const float CL_TOP = ${f(CLOUD.top)};
const vec2 L0 = vec2(${f(CLOUD.low.base)}, ${f(CLOUD.low.top)});
const vec2 L1 = vec2(${f(CLOUD.mid.base)}, ${f(CLOUD.mid.top)});
const float COV_WIDTH = ${f(CLOUD.coverageWidth)};

float remapC(float v, float a, float b) { return clamp((v - a) / (b - a), 0.0, 1.0); }

vec2 weatherAt(vec2 xz) {
  // mip 2 (~400 m texels) irons out the sharp Worley creases baked into the map
  vec2 w = textureLod(tWeather, (xz + uWeatherOffset) / ${f(CLOUD.weatherTile)}, 2.0).rg;
  // The map stores low = low - middle, which leaves hairline gaps where the two
  // populations meet. Let low cloud continue underneath the middle deck instead.
  return vec2(max(w.r, w.g), w.g);
}

// Global coverage shifts the weather remap, rounded toward the layer middle.
float layerCoverage(float w, float h) {
  float x = clamp(2.0 * h - 1.0, -1.0, 1.0);
  float heightScale = 1.0 - x * x;
  float factor = 1.0 - uCoverage * heightScale;
  return remapC(mix(w, 1.0, COV_WIDTH), factor, factor + COV_WIDTH);
}

// Cheap sun occlusion for surfaces below the layer.
float cloudShadow(vec3 worldPos, vec3 sunDir) {
  float sy = max(sunDir.y, 0.06);
  vec3 p0 = worldPos + sunDir * ((mix(L0.x, L0.y, 0.5) - worldPos.y) / sy);
  vec3 p1 = worldPos + sunDir * ((mix(L1.x, L1.y, 0.5) - worldPos.y) / sy);
  float d = layerCoverage(weatherAt(p0.xz).r, 0.5) * ${f(CLOUD.low.density)} * (L0.y - L0.x)
          + layerCoverage(weatherAt(p1.xz).g, 0.5) * ${f(CLOUD.mid.density)} * (L1.y - L1.x);
  return 0.3 + 0.7 * exp(-d * ${f(CLOUD.sigma)} * 0.07 / sy);
}
`;

async function loadBin(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function make3D(data, w, h, d, filter, mips = false) {
  const t = new THREE.Data3DTexture(data, w, h, d);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : filter;
  t.magFilter = filter;
  t.generateMipmaps = mips;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export async function loadCloudAssets() {
  const base = import.meta.env.BASE_URL + 'clouds/';
  const [shape, detail, stbn, weatherImg] = await Promise.all([
    loadBin(base + 'shape.bin'),
    loadBin(base + 'shape_detail.bin'),
    loadBin(base + 'stbn.bin'),
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = base + 'local_weather.png';
    }),
  ]);

  const weather = new THREE.Texture(weatherImg);
  weather.flipY = false;
  weather.wrapS = weather.wrapT = THREE.RepeatWrapping;
  weather.minFilter = THREE.LinearMipmapLinearFilter;
  weather.magFilter = THREE.LinearFilter;
  weather.generateMipmaps = true;
  weather.colorSpace = THREE.NoColorSpace;
  weather.needsUpdate = true;

  // CPU copy of the weather map for the density probe.
  const cv = document.createElement('canvas');
  cv.width = weatherImg.width;
  cv.height = weatherImg.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(weatherImg, 0, 0);
  const weatherPixels = ctx.getImageData(0, 0, cv.width, cv.height);

  return {
    weather,
    weatherPixels,
    shapeData: shape,
    shape: make3D(shape, 128, 128, 128, THREE.LinearFilter, true),
    detail: make3D(detail, 32, 32, 32, THREE.LinearFilter, true),
    blue: make3D(stbn, 128, 128, 64, THREE.NearestFilter),
  };
}

const QUALITY = {
  low: { steps: 56, lightSteps: 3, scale: 0.4 },
  medium: { steps: 84, lightSteps: 5, scale: 0.5 },
  high: { steps: 120, lightSteps: 6, scale: 0.66 },
};

export class Clouds {
  constructor(assets, sky, quality = 'medium') {
    this.assets = assets;
    this.sky = sky;
    this.quality = QUALITY[quality] ?? QUALITY.medium;
    this.weatherOffset = new THREE.Vector2(9000, 2500);
    this.shapeOffset = new THREE.Vector3();
    this.detailOffset = new THREE.Vector3();
    this.frame = 0;

    // ping-pong pair: each frame blends the new march with the reprojected last one
    const makeTarget = () => new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.raw = makeTarget();
    this.target = makeTarget();
    this.history = makeTarget();
    this.prevViewProj = new THREE.Matrix4();
    this.historyValid = false;

    this.uniforms = {
      tShape: { value: assets.shape },
      tDetail: { value: assets.detail },
      tWeather: { value: assets.weather },
      tBlue: { value: assets.blue },
      tDepth: { value: null },
      tSky: { value: sky.lut.texture },
      uWeatherOffset: { value: this.weatherOffset },
      uShapeOffset: { value: this.shapeOffset },
      uDetailOffset: { value: this.detailOffset },
      uCoverage: { value: CLOUD.coverage },
      uSunDir: { value: sky.sunDir },
      uSunColor: { value: sky.sunColor },
      uAmbTop: { value: sky.ambientTop },
      uAmbBot: { value: sky.ambientBottom },
      uCamPos: { value: new THREE.Vector3() },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uNear: { value: 1 },
      uFar: { value: 1 },
      uFrame: { value: 0 },
      uDebug: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: { STEPS: this.quality.steps, LIGHT_STEPS: this.quality.lightSteps },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp sampler3D;
        #include <packing>
        varying vec2 vUv;
        uniform sampler3D tShape;
        uniform sampler3D tDetail;
        uniform sampler3D tBlue;
        uniform sampler2D tDepth;
        uniform vec3 uShapeOffset;
        uniform vec3 uDetailOffset;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbTop;
        uniform vec3 uAmbBot;
        uniform vec3 uCamPos;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        uniform float uNear;
        uniform float uFar;
        uniform int uFrame;
        uniform int uDebug;
        ${SKY_LUT_GLSL}
        ${CLOUD_WEATHER_GLSL}

        const float SIGMA = ${f(CLOUD.sigma)};
        const float MAX_DIST = 90000.0;

        // Returns density in [0,1]. \`detailAmt\` fades the erosion with distance.
        float cloudDensity(vec3 p, float detailAmt, float mip, out float cover) {
          cover = 0.0;
          float h0 = (p.y - L0.x) / (L0.y - L0.x);
          float h1 = (p.y - L1.x) / (L1.y - L1.x);
          bool in0 = h0 > 0.0 && h0 < 1.0;
          bool in1 = h1 > 0.0 && h1 < 1.0;
          if (!in0 && !in1) return 0.0;
          vec2 w = weatherAt(p.xz);
          float d0 = in0 ? layerCoverage(w.r, h0) : 0.0;
          float d1 = in1 ? layerCoverage(w.g, h1) : 0.0;
          if (d0 + d1 <= 0.0) return 0.0;
          cover = 1.0;
          float shape = textureLod(tShape, p * ${f(CLOUD.shapeScale)} + uShapeOffset, mip).r;
          d0 = remapC(d0, (1.0 - shape) * ${f(CLOUD.low.shape)}, 1.0);
          d1 = remapC(d1, (1.0 - shape) * ${f(CLOUD.mid.shape)}, 1.0);
          if (d0 + d1 <= 0.0) return 0.0;
          float m0 = 0.0;
          float m1 = 0.0;
          if (detailAmt > 0.01) {
            float detail = textureLod(tDetail, p * ${f(CLOUD.detailScale)} + uDetailOffset, 1.0).r;
            // cap the inverted term: its hairline peaks cut visible creases into cloud bases
            float inv = min(1.0 - detail, 0.62);
            // fluffy tops, wispy eroded bases
            m0 = mix(detail * detail * 0.7, inv, remapC(h0, 0.2, 0.4)) * ${f(CLOUD.low.detail)} * detailAmt;
            m1 = mix(detail * detail * 0.7, inv, remapC(h1, 0.2, 0.4)) * ${f(CLOUD.mid.detail)} * detailAmt;
          }
          d0 = remapC(d0 * 2.0, m0 * 0.5, 1.0);
          d1 = remapC(d1 * 2.0, m1 * 0.5, 1.0);
          d0 *= ${f(CLOUD.low.density)} * (0.75 * clamp(h0, 0.0, 1.0) + 0.25);
          d1 *= ${f(CLOUD.mid.density)} * (0.75 * clamp(h1, 0.0, 1.0) + 0.25);
          // soften the hard slab floor / ceiling
          d0 *= smoothstep(0.0, 0.08, h0) * smoothstep(1.0, 0.9, h0);
          d1 *= smoothstep(0.0, 0.08, h1) * smoothstep(1.0, 0.9, h1);
          return clamp(d0 + d1, 0.0, 1.0);
        }

        float hg(float mu, float g) {
          float gg = g * g;
          return (1.0 - gg) / pow(1.0 + gg - 2.0 * g * mu, 1.5);
        }

        float sunOpticalDepth(vec3 p, float jitter) {
          float od = 0.0;
          float st = 45.0;
          vec3 q = p + uSunDir * st * (jitter - 0.5);
          float cv;
          for (int i = 0; i < LIGHT_STEPS; i++) {
            q += uSunDir * st;
            od += cloudDensity(q, 0.0, 1.3 + min(float(i) * 0.3, 1.0), cv) * st;
            st *= 1.9;
          }
          return od * SIGMA;
        }

        void main() {
          vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec3 vd = normalize(v.xyz / v.w);
          vec3 rd = normalize(mat3(uCamWorld) * vd);
          vec3 ro = uCamPos;

          float sceneDist = 1e9;
          float depth = texture2D(tDepth, vUv).x;
          if (depth < 1.0) sceneDist = perspectiveDepthToViewZ(depth, uNear, uFar) / vd.z;

          // Bounded segment: only the slab between cloud bottom and top.
          float t0 = 0.0;
          float t1 = -1.0;
          if (abs(rd.y) > 1e-5) {
            float ta = (CL_BOTTOM - ro.y) / rd.y;
            float tb = (CL_TOP - ro.y) / rd.y;
            t0 = max(min(ta, tb), 0.0);
            t1 = max(ta, tb);
          } else if (ro.y > CL_BOTTOM && ro.y < CL_TOP) {
            t1 = MAX_DIST;
          }
          t1 = min(t1, min(sceneDist, MAX_DIST));
          if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

          float blue = texelFetch(tBlue, ivec3(ivec2(gl_FragCoord.xy) & 127, uFrame & 63), 0).r;
          float mu = dot(rd, uSunDir);
          float phase = mix(hg(mu, -0.25), hg(mu, 0.78), 0.55);

          float T = 1.0;
          vec3 col = vec3(0.0);
          float tAcc = 0.0;
          float wAcc = 0.0;
          float t = t0 + max(26.0, t0 * 0.012) * blue;
          int used = 0;
          bool wasEmpty = true;
          float lastSkip = 0.0;
          for (int i = 0; i < STEPS; i++) {
            if (t >= t1 || T < 0.012) break;
            float dt = max(26.0, t * 0.012);
            vec3 p = ro + rd * t;
            // base bias of ~1 mip blurs the hairline creases between Worley cells
            float mip = 1.1 + clamp(log2(t / 3000.0), 0.0, 1.2);
            float cover;
            float d = cloudDensity(p, 1.0 - smoothstep(1400.0, 3600.0, t), mip, cover);
            if (cover < 0.5) {
              // nothing in the weather map here: stride through the gap
              lastSkip = clamp(t * 0.03, 70.0, 450.0);
              t += lastSkip;
              wasEmpty = true;
              continue;
            }
            if (wasEmpty && lastSkip > 0.0) {
              // just entered a covered cell after a long stride: back up once
              wasEmpty = false;
              t -= lastSkip * 0.5;
              lastSkip = 0.0;
              continue;
            }
            wasEmpty = false;
            if (d > 0.002) {
              used++;
              float od = sunOpticalDepth(p, fract(blue + 0.618 * float(i)));
              // direct + cheap multiple-scattering lobes that survive deeper
              float direct = exp(-od * 0.7) * phase * 0.6;
              float multi = exp(-od * 0.14) * 0.3 + exp(-od * 0.035) * 0.09;
              float hN = remapC(p.y, CL_BOTTOM, CL_TOP);
              vec3 amb = mix(uAmbBot, uAmbTop, hN) * (0.22 + 0.3 * hN);
              vec3 L = uSunColor * (direct + multi) + amb;
              float Ts = exp(-d * SIGMA * dt);
              float wgt = T * (1.0 - Ts);
              col += L * wgt;
              tAcc += t * wgt;
              wAcc += wgt;
              T *= Ts;
            }
            t += dt;
          }

          if (wAcc > 1e-4) {
            float tMean = tAcc / wAcc;
            float haze = 1.0 - exp(-tMean / ${f(CLOUD.hazeDistance)});
            col = mix(col, skyLUT(rd) * wAcc, haze);
          }
          if (T < 0.012) T = 0.0;

          if (uDebug == 1) { gl_FragColor = vec4(vec3(float(used) / float(STEPS)), 0.0); return; }
          if (uDebug == 2) { gl_FragColor = vec4(vec3(1.0 - T), 0.0); return; }
          if (uDebug == 3) {
            vec2 w = weatherAt((ro + rd * t0).xz);
            gl_FragColor = vec4(w.r, w.g, 0.0, 0.0); return;
          }
          gl_FragColor = vec4(col, T);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    // Temporal resolve: reproject last frame through a proxy depth inside the layer
    // and clamp it to the current 3x3 neighbourhood so stale history cannot smear.
    this.resolve = new THREE.ShaderMaterial({
      uniforms: {
        tRaw: { value: this.raw.texture },
        tHistory: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uCamPos: this.uniforms.uCamPos,
        uInvProj: this.uniforms.uInvProj,
        uCamWorld: this.uniforms.uCamWorld,
        uPrevViewProj: { value: new THREE.Matrix4() },
        uHistoryWeight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tRaw;
        uniform sampler2D tHistory;
        uniform vec2 uTexel;
        uniform vec3 uCamPos;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        uniform mat4 uPrevViewProj;
        uniform float uHistoryWeight;
        void main() {
          vec4 cur = texture2D(tRaw, vUv);
          vec4 mn = cur;
          vec4 mx = cur;
          vec4 avg = cur;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              if (x == 0 && y == 0) continue;
              vec4 s = texture2D(tRaw, vUv + vec2(float(x), float(y)) * uTexel);
              mn = min(mn, s);
              mx = max(mx, s);
              avg += s;
            }
          }
          avg /= 9.0;
          vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec3 rd = normalize(mat3(uCamWorld) * normalize(v.xyz / v.w));
          // proxy distance: where the ray meets the bulk of the layer
          float tRep = 30000.0;
          if (uCamPos.y > ${f(CLOUD.top)}) {
            if (rd.y < -1e-4) tRep = (${f(CLOUD.top - 450)} - uCamPos.y) / rd.y;
          } else if (uCamPos.y < ${f(CLOUD.bottom)}) {
            if (rd.y > 1e-4) tRep = (${f(CLOUD.bottom + 250)} - uCamPos.y) / rd.y;
          } else {
            tRep = 450.0;
          }
          tRep = clamp(tRep, 200.0, 40000.0);
          vec4 pc = uPrevViewProj * vec4(uCamPos + rd * tRep, 1.0);
          vec2 huv = pc.xy / pc.w * 0.5 + 0.5;
          vec4 outc = cur;
          if (uHistoryWeight > 0.0 && pc.w > 0.0 && huv.x > 0.0 && huv.x < 1.0 && huv.y > 0.0 && huv.y < 1.0) {
            // widen the box slightly so jitter noise still averages out
            vec4 pad = (mx - mn) * 0.15;
            vec4 hist = clamp(texture2D(tHistory, huv), mn - pad, mx + pad);
            outc = mix(mix(cur, avg, 0.15), hist, uHistoryWeight);
          }
          gl_FragColor = outc;
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.resolveScene = new THREE.Scene();
    const rmesh = new THREE.Mesh(fullscreenGeometry(), this.resolve);
    rmesh.frustumCulled = false;
    this.resolveScene.add(rmesh);

    this.scene = new THREE.Scene();
    const mesh = new THREE.Mesh(fullscreenGeometry(), this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.camera = new THREE.Camera();
  }

  setSize(width, height) {
    const s = this.quality.scale;
    const w = Math.max(2, Math.round(width * s));
    const h = Math.max(2, Math.round(height * s));
    this.target.setSize(w, h);
    this.history.setSize(w, h);
    this.raw.setSize(w, h);
    this.resolve.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.historyValid = false;
  }

  update(dt) {
    this.weatherOffset.x += CLOUD.weatherWind[0] * dt;
    this.weatherOffset.y += CLOUD.weatherWind[1] * dt;
    const s = CLOUD.shapeScale;
    this.shapeOffset.x += CLOUD.shapeWind[0] * dt * s;
    this.shapeOffset.y += CLOUD.shapeWind[1] * dt * s;
    this.shapeOffset.z += CLOUD.shapeWind[2] * dt * s;
    const e = CLOUD.detailScale;
    this.detailOffset.x += CLOUD.detailWind[0] * dt * e;
    this.detailOffset.y += CLOUD.detailWind[1] * dt * e;
    this.detailOffset.z += CLOUD.detailWind[2] * dt * e;
    for (const o of [this.shapeOffset, this.detailOffset]) {
      o.x -= Math.floor(o.x);
      o.y -= Math.floor(o.y);
      o.z -= Math.floor(o.z);
    }
  }

  render(renderer, camera, depthTexture) {
    const u = this.uniforms;
    u.tDepth.value = depthTexture;
    u.uCamPos.value.copy(camera.position);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uFrame.value = this.frame++;
    // swap: last frame's result becomes the history
    const swap = this.target;
    this.target = this.history;
    this.history = swap;
    renderer.setRenderTarget(this.raw);
    renderer.render(this.scene, this.camera);
    const r = this.resolve.uniforms;
    r.tHistory.value = this.history.texture;
    r.uPrevViewProj.value.copy(this.prevViewProj);
    r.uHistoryWeight.value = this.historyValid && u.uDebug.value === 0 ? 0.86 : 0;
    renderer.setRenderTarget(this.target);
    renderer.render(this.resolveScene, this.camera);
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.historyValid = true;
  }

  // CPU twin of the coarse density (weather + shape, no detail). Used for
  // gameplay cues: in-cloud mist, audio muffling, object fade.
  densityAt(x, y, z) {
    const { weatherPixels, shapeData } = this.assets;
    const layer = (L, w) => {
      const h = (y - L.base) / (L.top - L.base);
      if (h <= 0 || h >= 1) return 0;
      const xx = 2 * h - 1;
      const factor = 1 - CLOUD.coverage * (1 - xx * xx);
      const m = w + (1 - w) * CLOUD.coverageWidth;
      let d = Math.min(Math.max((m - factor) / CLOUD.coverageWidth, 0), 1);
      if (d <= 0) return 0;
      const lo = (1 - shape) * L.shape;
      d = Math.min(Math.max((d - lo) / (1 - lo), 0), 1);
      return Math.min(d * 2, 1) * L.density * (0.75 * h + 0.25);
    };
    if (y <= CLOUD.bottom || y >= CLOUD.top) return 0;
    const W = weatherPixels.width;
    const H = weatherPixels.height;
    const u = (x + this.weatherOffset.x) / CLOUD.weatherTile;
    const v = (z + this.weatherOffset.y) / CLOUD.weatherTile;
    const px = Math.floor((u - Math.floor(u)) * W) % W;
    const py = Math.floor((v - Math.floor(v)) * H) % H;
    const i = (py * W + px) * 4;
    const wg = weatherPixels.data[i + 1] / 255;
    const wr = Math.max(weatherPixels.data[i] / 255, wg);
    const wrap = (c) => Math.floor((c - Math.floor(c)) * 128) % 128;
    const sx = wrap(x * CLOUD.shapeScale + this.shapeOffset.x);
    const sy = wrap(y * CLOUD.shapeScale + this.shapeOffset.y);
    const sz = wrap(z * CLOUD.shapeScale + this.shapeOffset.z);
    const shape = shapeData[sx + sy * 128 + sz * 128 * 128] / 255;
    return Math.min(layer(CLOUD.low, wr) + layer(CLOUD.mid, wg), 1);
  }
}
