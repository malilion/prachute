// Sky: single-scattering atmosphere baked every frame into a small sky-view LUT,
// then sampled by the sky dome, the terrain haze and the cloud march.
import * as THREE from 'three';

export const SUN_INTENSITY = 22.0;

const R_PLANET = 6371e3;
const R_ATMOS = 6471e3;
const K_RAY = [5.5e-6, 13.0e-6, 22.4e-6];
const K_MIE = 21e-6;
const H_RAY = 8e3;
const H_MIE = 1.2e3;

// Lowest elevation stored in the LUT (radians). Everything below is clamped to haze.
export const SKY_MIN_EL = -0.05;

export const SKY_LUT_GLSL = /* glsl */ `
uniform sampler2D tSky;
vec3 skyLUT(vec3 d) {
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = sqrt(clamp((el - (${SKY_MIN_EL.toFixed(4)})) / (1.5707963 - (${SKY_MIN_EL.toFixed(4)})), 0.0, 1.0));
  float u = atan(d.z, d.x) / 6.2831853;
  return texture2D(tSky, vec2(u, v)).rgb;
}
`;

const ATMOS_GLSL = /* glsl */ `
const float PI = 3.141592653589793;
const float R_PLANET = ${R_PLANET.toFixed(1)};
const float R_ATMOS = ${R_ATMOS.toFixed(1)};
const vec3 K_RAY = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float K_MIE = 21e-6;
const float H_RAY = 8e3;
const float H_MIE = 1.2e3;
const float G_MIE = 0.76;

float farHit(vec3 r0, vec3 rd, float sr) {
  float b = dot(rd, r0);
  float c = dot(r0, r0) - sr * sr;
  float d = b * b - c;
  return d < 0.0 ? -1.0 : -b + sqrt(d);
}

vec3 atmosphere(vec3 r, vec3 r0, vec3 pSun, float iSun) {
  const int iSteps = 20;
  const int jSteps = 6;
  float tMax = farHit(r0, r, R_ATMOS);
  if (tMax < 0.0) return vec3(0.0);
  float iStep = tMax / float(iSteps);
  float iTime = 0.0;
  vec3 totalRay = vec3(0.0);
  vec3 totalMie = vec3(0.0);
  float iOdRay = 0.0;
  float iOdMie = 0.0;
  float mu = dot(r, pSun);
  float mumu = mu * mu;
  float gg = G_MIE * G_MIE;
  float pRay = 3.0 / (16.0 * PI) * (1.0 + mumu);
  float pMie = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) /
    (pow(1.0 + gg - 2.0 * mu * G_MIE, 1.5) * (2.0 + gg));
  for (int i = 0; i < iSteps; i++) {
    vec3 iPos = r0 + r * (iTime + iStep * 0.5);
    float iH = max(length(iPos) - R_PLANET, 0.0);
    float odStepRay = exp(-iH / H_RAY) * iStep;
    float odStepMie = exp(-iH / H_MIE) * iStep;
    iOdRay += odStepRay;
    iOdMie += odStepMie;
    float jMax = farHit(iPos, pSun, R_ATMOS);
    float jStep = jMax / float(jSteps);
    float jTime = 0.0;
    float jOdRay = 0.0;
    float jOdMie = 0.0;
    for (int j = 0; j < jSteps; j++) {
      vec3 jPos = iPos + pSun * (jTime + jStep * 0.5);
      float jH = max(length(jPos) - R_PLANET, 0.0);
      jOdRay += exp(-jH / H_RAY) * jStep;
      jOdMie += exp(-jH / H_MIE) * jStep;
      jTime += jStep;
    }
    vec3 attn = exp(-(K_MIE * (iOdMie + jOdMie) + K_RAY * (iOdRay + jOdRay)));
    totalRay += odStepRay * attn;
    totalMie += odStepMie * attn;
    iTime += iStep;
  }
  return iSun * (pRay * K_RAY * totalRay + pMie * K_MIE * totalMie);
}
`;

// ---- CPU twin of the sun transmittance (used for light colours) ----
function farHit(ox, oy, oz, dx, dy, dz, sr) {
  const b = dx * ox + dy * oy + dz * oz;
  const c = ox * ox + oy * oy + oz * oz - sr * sr;
  const d = b * b - c;
  return d < 0 ? -1 : -b + Math.sqrt(d);
}

export function sunTransmittance(altitude, sunDir, out = new THREE.Color()) {
  const oy = R_PLANET + Math.max(altitude, 0);
  const tMax = farHit(0, oy, 0, sunDir.x, sunDir.y, sunDir.z, R_ATMOS);
  const N = 24;
  const step = tMax / N;
  let odR = 0;
  let odM = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * step;
    const x = sunDir.x * t;
    const y = oy + sunDir.y * t;
    const z = sunDir.z * t;
    const h = Math.max(Math.hypot(x, y, z) - R_PLANET, 0);
    odR += Math.exp(-h / H_RAY) * step;
    odM += Math.exp(-h / H_MIE) * step;
  }
  out.setRGB(
    Math.exp(-(K_RAY[0] * odR + K_MIE * odM)),
    Math.exp(-(K_RAY[1] * odR + K_MIE * odM)),
    Math.exp(-(K_RAY[2] * odR + K_MIE * odM)),
  );
  return out;
}

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export function fullscreenGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}

export class Sky {
  constructor(renderer, weatherTexture) {
    this.renderer = renderer;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Color(); // direct sun radiance scale at camera altitude
    this.ambientTop = new THREE.Color();
    this.ambientBottom = new THREE.Color();

    this.lut = new THREE.WebGLRenderTarget(256, 128, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });

    this.lutMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: this.sunDir },
        uAltitude: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform vec3 uSunDir;
        uniform float uAltitude;
        ${ATMOS_GLSL}
        void main() {
          float az = vUv.x * 2.0 * PI;
          float el = mix(${SKY_MIN_EL.toFixed(4)}, PI * 0.5, vUv.y * vUv.y);
          vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
          vec3 c = atmosphere(dir, vec3(0.0, R_PLANET + uAltitude, 0.0), uSunDir, ${SUN_INTENSITY.toFixed(1)});
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.lutScene = new THREE.Scene();
    this.lutMesh = new THREE.Mesh(fullscreenGeometry(), this.lutMaterial);
    this.lutMesh.frustumCulled = false;
    this.lutScene.add(this.lutMesh);
    this.lutCamera = new THREE.Camera();

    // Sky dome drawn as a far-plane fullscreen triangle.
    this.domeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSky: { value: this.lut.texture },
        tWeather: { value: weatherTexture },
        uSunDir: { value: this.sunDir },
        uSunColor: { value: this.sunColor },
        uAmbient: { value: this.ambientTop },
        uCamPos: { value: new THREE.Vector3() },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        void main() {
          vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0);
          vDir = mat3(uCamWorld) * (v.xyz / v.w);
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform sampler2D tWeather;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uCamPos;
        uniform float uTime;
        ${SKY_LUT_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyLUT(d);
          float mu = dot(d, uSunDir);

          // Sun disc with limb darkening + tight corona.
          float disc = smoothstep(0.99985, 0.99995, mu);
          col += uSunColor * disc * 60.0;
          col += uSunColor * pow(max(mu, 0.0), 900.0) * 1.2;

          // High cirrus sheet: a cheap 2D layer far above the jump altitude.
          if (d.y > 0.015) {
            float t = (9500.0 - uCamPos.y) / d.y;
            vec2 p = uCamPos.xz + d.xz * t;
            vec2 wind = vec2(uTime * 14.0, uTime * 5.0);
            float a = texture2D(tWeather, (p + wind) / 90000.0).b;
            float b = texture2D(tWeather, (p * vec2(1.0, 2.6) + wind * 2.0) / 23000.0 + 0.37).b;
            float c = smoothstep(0.28, 0.95, a * 0.75 + b * 0.5) * (0.35 + 0.65 * b);
            float fade = exp(-t / 70000.0) * smoothstep(0.015, 0.09, d.y);
            float alpha = c * fade * 0.5;
            float fw = pow(max(mu, 0.0), 6.0);
            vec3 cirrus = uSunColor * (0.55 + 1.6 * fw) + uAmbient * 0.9;
            col = mix(col, cirrus, alpha);
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      depthWrite: false,
      toneMapped: false,
    });
    this.dome = new THREE.Mesh(fullscreenGeometry(), this.domeMaterial);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
  }

  setSun(elevationDeg, azimuthDeg) {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  }

  update(camera, time) {
    const alt = Math.max(camera.position.y, 2);
    this.lutMaterial.uniforms.uAltitude.value = alt;

    // Light colours follow the same extinction model as the sky.
    sunTransmittance(alt, this.sunDir, this.sunColor).multiplyScalar(SUN_INTENSITY * 0.19);
    const warm = THREE.MathUtils.smoothstep(this.sunDir.y, 0.02, 0.45);
    this.ambientTop.setRGB(0.36, 0.52, 0.86).multiplyScalar(0.55 + 0.9 * warm);
    this.ambientBottom.setRGB(0.55, 0.56, 0.62).multiplyScalar(0.3 + 0.55 * warm);
    this.ambientBottom.r += this.sunColor.r * 0.035;
    this.ambientBottom.g += this.sunColor.g * 0.03;
    this.ambientBottom.b += this.sunColor.b * 0.03;

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.lut);
    this.renderer.render(this.lutScene, this.lutCamera);
    this.renderer.setRenderTarget(prev);

    const u = this.domeMaterial.uniforms;
    u.uCamPos.value.copy(camera.position);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uTime.value = time;
  }
}
