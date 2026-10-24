import * as THREE from 'three';
import {
  SHELL_VERTEX_SHADER,
  SHELL_FRAGMENT_SHADER,
  STRAND_VERTEX_SHADER,
  STRAND_FRAGMENT_SHADER
} from './furShaders.js';
import { evaluateFollicleMask, evaluateGroomFlow } from './blobCreature.js';

export const SHELL_COUNT = 64;
export const WEBGL_SHELL_COUNT = 32;
export const WEBGL_STRAND_COUNT = 26000;
export const MAX_STRAND_COUNT = 60000;

/**
 * Builds a 20-segment high-resolution hair strand ribbon along Y in [0..1].
 * position.x in [-1, +1] stores the cross-strand ribbon coordinate for
 * smooth camera-aligned cylindrical billboarding in the vertex shader.
 */
function createHairBladeTemplateGeometry(segments = 20) {
  const positions = [];
  const indices = [];

  for (let s = 0; s <= segments; s++) {
    const h = s / segments;
    positions.push(-1.0, h, 0.0);
    positions.push(1.0, h, 0.0);
  }

  for (let s = 0; s < segments; s++) {
    const row0 = s * 2;
    const row1 = row0 + 2;
    indices.push(row0, row0 + 1, row1);
    indices.push(row0 + 1, row1 + 1, row1);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  return geom;
}

/**
 * Creates the Hybrid Dual-Pipeline GPU Fur System attached to the blob creature:
 * - High-Fidelity GPU Fur Mode: 64-Layer Volumetric GPU Shell Mesh + 60,000 GPU-Instanced 3D Tapered Hair Strands + WebGL2 GPGPU Verlet
 * - Fallback / Lightweight WebGL Mode: Lightweight analytical WebGL fur (32 shells + 26k plush strands, zero GPGPU RTT)
 */
export function createGPUFurSystem(baseGeometry, initialParams) {
  let gpuFurEnabled = initialParams.gpuFurEnabled !== undefined ? Boolean(initialParams.gpuFurEnabled) : true;

  const sharedUniforms = {
    uPhysicsTex: { value: null },
    uFurLength: { value: initialParams.furLength },
    uFurDensity: { value: initialParams.furDensity },
    uClumping: { value: initialParams.clumping },
    uCurliness: { value: initialParams.curliness ?? 0.16 },
    uBaseColor: { value: new THREE.Color(initialParams.baseColor) },
    uTipColor: { value: new THREE.Color(initialParams.tipColor) },
    uRoughness: { value: initialParams.roughness },
    uSpecular: { value: initialParams.specular },
    uKeyLightDir: { value: new THREE.Vector3(0.6, 0.8, 0.7).normalize() },
    uKeyLightColor: { value: new THREE.Color('#f0f9ff') },
    uKeyLightIntensity: { value: initialParams.lightIntensity },
    uRimLightDir: { value: new THREE.Vector3(-0.6, 0.4, -0.85).normalize() },
    uRimLightColor: { value: new THREE.Color('#38bdf8') },
    uRimIntensity: { value: initialParams.rimIntensity },
    uAmbientIntensity: { value: 0.62 },
    uEnvSkyColor: { value: new THREE.Color('#7dd3fc') },
    uEnvGroundColor: { value: new THREE.Color('#080f1d') },
    uEnvTintStrength: { value: 0.08 },
    uTime: { value: 0.0 },
    uWindStrength: { value: initialParams.windStrength },
    uPointerLocalPos: { value: new THREE.Vector3(0, 0, 2) },
    uPointerVelocity: { value: new THREE.Vector3(0, 0, 0) },
    uPointerActive: { value: 0.0 },
    uGpuFurMode: { value: gpuFurEnabled ? 1.0 : 0.0 },
    uShellCountScale: { value: gpuFurEnabled ? 1.0 : SHELL_COUNT / WEBGL_SHELL_COUNT },
    uWebGLInertia: { value: new THREE.Vector3(0, 0, 0) },
    uBoopShockwave: { value: 0.0 },
    uHitOrigin: { value: new THREE.Vector3(0.0, 0.1, 0.98) },
    uHitOriginNormal: { value: new THREE.Vector3(0.0, 0.1, 0.98) },
    uHitStrength: { value: 0.0 },
    uHitTime: { value: 0.0 }
  };

  // ---------------------------------------------------------------------------
  // 1. Volumetric Shell Geometry (32 shells in default WebGL mode, 64 in GPU Fur mode)
  // ---------------------------------------------------------------------------
  const shellGeometry = new THREE.InstancedBufferGeometry();
  shellGeometry.index = baseGeometry.index;
  shellGeometry.attributes.position = baseGeometry.attributes.position;
  shellGeometry.attributes.normal = baseGeometry.attributes.normal;
  shellGeometry.attributes.uv = baseGeometry.attributes.uv;
  shellGeometry.attributes.aFollicleMask = baseGeometry.attributes.aFollicleMask;
  shellGeometry.attributes.aGroomTangent = baseGeometry.attributes.aGroomTangent;

  const shellIndices = new Float32Array(SHELL_COUNT);
  for (let i = 0; i < SHELL_COUNT; i++) {
    shellIndices[i] = (i + 1) / SHELL_COUNT;
  }
  shellGeometry.setAttribute(
    'aShellIndex',
    new THREE.InstancedBufferAttribute(shellIndices, 1)
  );
  shellGeometry.instanceCount = gpuFurEnabled ? SHELL_COUNT : WEBGL_SHELL_COUNT;

  const shellMaterial = new THREE.ShaderMaterial({
    vertexShader: SHELL_VERTEX_SHADER,
    fragmentShader: SHELL_FRAGMENT_SHADER,
    uniforms: sharedUniforms,
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide
  });

  const shellMesh = new THREE.Mesh(shellGeometry, shellMaterial);
  shellMesh.name = 'GPUFurShells64';
  shellMesh.frustumCulled = false;
  shellMesh.renderOrder = 1;

  // ---------------------------------------------------------------------------
  // 2. High-Subdivision (20-Segment) GPU-Instanced 3D Tapered Hair Strands
  // ---------------------------------------------------------------------------
  const templateGeo = createHairBladeTemplateGeometry(20);
  const strandGeometry = new THREE.InstancedBufferGeometry();
  strandGeometry.index = templateGeo.index;
  strandGeometry.attributes.position = templateGeo.attributes.position;

  // Compute area-weighted CDF over the blob triangles for uniform surface follicle sampling
  const posAttr = baseGeometry.attributes.position;
  const normAttr = baseGeometry.attributes.normal;
  const idxAttr = baseGeometry.index;
  const triCount = idxAttr.count / 3;

  const cumulativeAreas = new Float32Array(triCount);
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const crossVec = new THREE.Vector3();

  let totalArea = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = idxAttr.getX(t * 3);
    const i1 = idxAttr.getX(t * 3 + 1);
    const i2 = idxAttr.getX(t * 3 + 2);
    vA.fromBufferAttribute(posAttr, i0);
    vB.fromBufferAttribute(posAttr, i1);
    vC.fromBufferAttribute(posAttr, i2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    const area = crossVec.crossVectors(edge1, edge2).length() * 0.5;
    totalArea += area;
    cumulativeAreas[t] = totalArea;
  }

  // Generate 420 macro-clump tuft centroids on the surface for realistic fur clumping
  const CLUMP_COUNT = 420;
  const clumpCenters = new Float32Array(CLUMP_COUNT * 3);
  for (let c = 0; c < CLUMP_COUNT; c++) {
    const rArea = ((c + 0.5) / CLUMP_COUNT) * totalArea;
    let lo = 0;
    let hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulativeAreas[mid] < rArea) lo = mid + 1;
      else hi = mid;
    }
    const i0 = idxAttr.getX(lo * 3);
    clumpCenters[c * 3] = posAttr.getX(i0);
    clumpCenters[c * 3 + 1] = posAttr.getY(i0);
    clumpCenters[c * 3 + 2] = posAttr.getZ(i0);
  }

  const rootPosArray = new Float32Array(MAX_STRAND_COUNT * 3);
  const rootNormalArray = new Float32Array(MAX_STRAND_COUNT * 3);
  const groomDirArray = new Float32Array(MAX_STRAND_COUNT * 3);
  const clumpOffsetArray = new Float32Array(MAX_STRAND_COUNT * 3);
  const strandSeedArray = new Float32Array(MAX_STRAND_COUNT);
  const maskValueArray = new Float32Array(MAX_STRAND_COUNT);

  let validCount = 0;
  let prngState = 133742;
  const nextRand = () => {
    prngState = (prngState * 1664525 + 1013904223) >>> 0;
    return prngState / 4294967296;
  };

  while (validCount < MAX_STRAND_COUNT) {
    const targetArea = nextRand() * totalArea;
    let lo = 0;
    let hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulativeAreas[mid] < targetArea) lo = mid + 1;
      else hi = mid;
    }

    const i0 = idxAttr.getX(lo * 3);
    const i1 = idxAttr.getX(lo * 3 + 1);
    const i2 = idxAttr.getX(lo * 3 + 2);

    let r1 = Math.sqrt(nextRand());
    let r2 = nextRand();
    const w0 = 1.0 - r1;
    const w1 = r1 * (1.0 - r2);
    const w2 = r1 * r2;

    const px =
      posAttr.getX(i0) * w0 + posAttr.getX(i1) * w1 + posAttr.getX(i2) * w2;
    const py =
      posAttr.getY(i0) * w0 + posAttr.getY(i1) * w1 + posAttr.getY(i2) * w2;
    const pz =
      posAttr.getZ(i0) * w0 + posAttr.getZ(i1) * w1 + posAttr.getZ(i2) * w2;

    const mask = evaluateFollicleMask(px, py, pz);
    // Reject follicles directly inside the eye cornea or mouth opening
    if (mask < 0.04) {
      continue;
    }

    let nx =
      normAttr.getX(i0) * w0 + normAttr.getX(i1) * w1 + normAttr.getX(i2) * w2;
    let ny =
      normAttr.getY(i0) * w0 + normAttr.getY(i1) * w1 + normAttr.getY(i2) * w2;
    let nz =
      normAttr.getZ(i0) * w0 + normAttr.getZ(i1) * w1 + normAttr.getZ(i2) * w2;
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;

    const [gx, gy, gz] = evaluateGroomFlow(px, py, pz, nx, ny, nz);

    // Find nearest clump centroid to pull hair tip toward tuft center
    let nearestIdx = 0;
    let minDistSq = Infinity;
    // Sample a stride of clump centroids for fast O(1) lookup
    const startC = Math.floor(((py + 1.1) / 2.2) * (CLUMP_COUNT - 40));
    const searchStart = Math.max(0, Math.min(CLUMP_COUNT - 40, startC));
    for (let c = searchStart; c < searchStart + 40; c++) {
      const dx = clumpCenters[c * 3] - px;
      const dy = clumpCenters[c * 3 + 1] - py;
      const dz = clumpCenters[c * 3 + 2] - pz;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < minDistSq) {
        minDistSq = dSq;
        nearestIdx = c;
      }
    }

    let cx = clumpCenters[nearestIdx * 3] - px;
    let cy = clumpCenters[nearestIdx * 3 + 1] - py;
    let cz = clumpCenters[nearestIdx * 3 + 2] - pz;
    // Project clump vector onto tangent plane
    const dotCN = cx * nx + cy * ny + cz * nz;
    cx -= dotCN * nx;
    cy -= dotCN * ny;
    cz -= dotCN * nz;

    const idx3 = validCount * 3;
    rootPosArray[idx3] = px;
    rootPosArray[idx3 + 1] = py;
    rootPosArray[idx3 + 2] = pz;

    rootNormalArray[idx3] = nx;
    rootNormalArray[idx3 + 1] = ny;
    rootNormalArray[idx3 + 2] = nz;

    groomDirArray[idx3] = gx;
    groomDirArray[idx3 + 1] = gy;
    groomDirArray[idx3 + 2] = gz;

    clumpOffsetArray[idx3] = cx;
    clumpOffsetArray[idx3 + 1] = cy;
    clumpOffsetArray[idx3 + 2] = cz;

    strandSeedArray[validCount] = validCount / MAX_STRAND_COUNT;
    maskValueArray[validCount] = mask;

    validCount++;
  }

  strandGeometry.setAttribute(
    'aRootPos',
    new THREE.InstancedBufferAttribute(rootPosArray, 3)
  );
  strandGeometry.setAttribute(
    'aRootNormal',
    new THREE.InstancedBufferAttribute(rootNormalArray, 3)
  );
  strandGeometry.setAttribute(
    'aGroomDir',
    new THREE.InstancedBufferAttribute(groomDirArray, 3)
  );
  strandGeometry.setAttribute(
    'aClumpOffset',
    new THREE.InstancedBufferAttribute(clumpOffsetArray, 3)
  );
  strandGeometry.setAttribute(
    'aStrandSeed',
    new THREE.InstancedBufferAttribute(strandSeedArray, 1)
  );
  strandGeometry.setAttribute(
    'aMaskValue',
    new THREE.InstancedBufferAttribute(maskValueArray, 1)
  );
  const activeMaxStrands = gpuFurEnabled ? MAX_STRAND_COUNT : WEBGL_STRAND_COUNT;
  strandGeometry.instanceCount = Math.floor(activeMaxStrands * initialParams.furDensity);

  const strandMaterial = new THREE.ShaderMaterial({
    vertexShader: STRAND_VERTEX_SHADER,
    fragmentShader: STRAND_FRAGMENT_SHADER,
    uniforms: sharedUniforms,
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide
  });

  const strandMesh = new THREE.Mesh(strandGeometry, strandMaterial);
  strandMesh.name = 'GPUFurStrands60k';
  strandMesh.frustumCulled = false;
  strandMesh.renderOrder = 2;

  function updateDensity(density) {
    const clamped = Math.max(0.1, Math.min(1.0, density));
    sharedUniforms.uFurDensity.value = clamped;
    const cap = gpuFurEnabled ? MAX_STRAND_COUNT : WEBGL_STRAND_COUNT;
    strandGeometry.instanceCount = Math.floor(cap * clamped);
  }

  function setGPUFurEnabled(enabled) {
    gpuFurEnabled = Boolean(enabled);
    sharedUniforms.uGpuFurMode.value = gpuFurEnabled ? 1.0 : 0.0;
    sharedUniforms.uShellCountScale.value = gpuFurEnabled ? 1.0 : SHELL_COUNT / WEBGL_SHELL_COUNT;
    shellGeometry.instanceCount = gpuFurEnabled ? SHELL_COUNT : WEBGL_SHELL_COUNT;
    const cap = gpuFurEnabled ? MAX_STRAND_COUNT : WEBGL_STRAND_COUNT;
    strandGeometry.instanceCount = Math.floor(cap * sharedUniforms.uFurDensity.value);
  }

  return {
    shellMesh,
    strandMesh,
    sharedUniforms,
    updateDensity,
    setGPUFurEnabled,
    isGPUFurEnabled: () => gpuFurEnabled
  };
}
