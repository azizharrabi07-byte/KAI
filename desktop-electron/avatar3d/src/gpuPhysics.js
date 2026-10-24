import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';

const SIM_SIZE = 128; // 128x128 = 16,384 parallel GPU spring-verlet hair patches

const VELOCITY_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uDelta;
  uniform float uStiffness;
  uniform float uDamping;
  uniform float uGravity;
  uniform float uWindStrength;
  uniform vec3 uCreatureVelocity;
  uniform vec3 uCreatureAngularVel;
  uniform float uCreatureDecel;
  uniform vec3 uPointerLocalPos;
  uniform vec3 uPointerVelocity;
  uniform float uPointerActive;
  uniform float uBoopShockwave;
  uniform vec3 uHitOrigin;
  uniform vec3 uHitOriginNormal;
  uniform float uHitStrength;
  uniform float uHitTime;

  // Compact 3D pseudo-curl turbulence for organic wind gusts
  vec3 windField(vec3 p, float t) {
    float wx = sin(p.y * 3.1 + t * 2.4) * cos(p.z * 2.7 + t * 1.9)
             + 0.5 * sin(p.z * 6.3 - t * 4.1);
    float wy = 0.35 * cos(p.x * 3.5 + t * 2.1) * sin(p.z * 2.9 + t * 1.7);
    float wz = cos(p.x * 2.8 - t * 2.2) * sin(p.y * 3.4 + t * 2.0);
    return vec3(wx, wy, wz);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;

    // Reconstruct spherical surface direction for this simulation texel
    float theta = (uv.x * 2.0 - 1.0) * 3.14159265;
    float phi = (1.0 - uv.y) * 3.14159265;
    vec3 surfNormal = normalize(vec3(
      sin(phi) * sin(theta),
      cos(phi),
      sin(phi) * cos(theta)
    ));

    vec4 posData = texture2D(texturePosition, uv);
    vec4 velData = texture2D(textureVelocity, uv);
    vec3 disp = posData.xyz;
    float combMemory = posData.w;
    vec3 vel = velData.xyz;

    float dt = clamp(uDelta, 0.001, 0.033);

    // 1. Hookean angular spring restoring force toward rest pose
    vec3 force = -uStiffness * disp;

    // 2. Tangential gravity droop (prevents hair from collapsing inward into the body)
    vec3 gravVec = vec3(0.0, -uGravity, 0.0);
    vec3 tangentGravity = gravVec - surfNormal * min(0.0, dot(gravVec, surfNormal));
    force += tangentGravity;

    // 3. Creature movement & rotational inertia (secondary motion follow-through)
    vec3 linearInertia = -uCreatureVelocity * 1.85;
    vec3 rotationalInertia = -cross(uCreatureAngularVel, surfNormal) * 2.2;
    force += linearInertia + rotationalInertia;

    // 4. Turbulent wind gusts
    vec3 wind = windField(surfNormal * 1.4, uTime) * uWindStrength;
    force += wind;

    // 5. Interactive pointer petting, contact compression, and directional combing
    if (uPointerActive > 0.5) {
      float dist = distance(surfNormal, normalize(uPointerLocalPos + vec3(0.0, 0.0, 1e-5)));
      if (dist < 0.55) {
        float falloff = pow(1.0 - dist / 0.55, 2.0);
        vec3 partDir = normalize(surfNormal - normalize(uPointerLocalPos) + vec3(0.0, 1e-4, 0.0));
        // Project parting & stroke velocity onto local tangent plane
        vec3 strokeImpulse = uPointerVelocity * 3.2 + partDir * 2.4;
        strokeImpulse -= surfNormal * dot(strokeImpulse, surfNormal);
        // Soft contact compression force pushing inward against surface normal
        vec3 compressionForce = -surfNormal * 4.2;
        force += (strokeImpulse + compressionForce) * falloff * 16.0;
      }
    }

    // 6. Click localized radial shockwave vibration originating at contact point
    if (uHitStrength > 0.005) {
      float hitDist = distance(surfNormal, uHitOriginNormal);
      float waveSpeed = 3.6;
      float waveFront = uHitTime * waveSpeed;
      float dWave = abs(hitDist - waveFront);
      float waveWidth = 0.42;
      if (dWave < waveWidth) {
        float pulse = 1.0 - dWave / waveWidth;
        float decay = exp(-uHitTime * 3.4) * exp(-hitDist * 0.7) * uHitStrength;
        float ripple = sin((hitDist - waveFront) * 22.0) * pulse * decay;
        vec3 radial = normalize(surfNormal - uHitOriginNormal + vec3(1e-4, 1e-4, 0.0));
        radial -= surfNormal * dot(radial, surfNormal);
        force += radial * (ripple * 34.0) - surfNormal * (pulse * decay * 18.0);
      }
    } else if (uBoopShockwave > 0.01) {
      float waveFront = (1.0 - uBoopShockwave) * 2.2;
      float dFront = abs(distance(surfNormal, vec3(0.0, 0.1, 0.98)) - waveFront);
      if (dFront < 0.35) {
        float ripple = (1.0 - dFront / 0.35) * uBoopShockwave;
        vec3 radial = normalize(surfNormal - vec3(0.0, 0.1, 0.98) + vec3(0.0, 1e-4, 0.0));
        force += radial * ripple * 22.0;
      }
    }

    // 7. Dynamic velocity-dependent dampening factor:
    // Dynamically tied to the creature's current movement velocity.
    // At higher movement speeds, aerodynamic drag & inter-strand viscous friction increase damping.
    // Crucially, when the character performs a sudden stop during a state transition
    // (creature movement velocity rapidly drops while fur retains displacement or momentum),
    // a sudden-stop stabilization brake activates, boosting the dampening factor toward
    // critical damping to completely extinguish post-transition ringing, oscillation,
    // and unwanted fur vibration.
    float creatureLinearSpeed = length(uCreatureVelocity);
    float creatureAngularSpeed = length(uCreatureAngularVel);
    float totalCreatureMotion = creatureLinearSpeed + creatureAngularSpeed * 0.55;

    // Aerodynamic velocity-proportional drag + deceleration response
    float dynamicDamping = uDamping + totalCreatureMotion * 4.5 + uCreatureDecel * 3.8;

    // Critical damping coefficient for harmonic oscillator: c_crit = 2.0 * sqrt(k)
    float criticalDamping = 2.0 * sqrt(max(1.0, uStiffness));

    // Sudden-stop settle brake dynamically tied to creature velocity and residual displacement:
    // When creature motion drops below threshold while displacement or velocity remains,
    // progressively increase damping up to critical/overdamped level to halt oscillation.
    float dispMag = length(disp);
    float furSpeed = length(vel);
    float stopThreshold = 0.42;
    if (totalCreatureMotion < stopThreshold && (dispMag > 0.003 || furSpeed > 0.005)) {
      float stopRatio = 1.0 - (totalCreatureMotion / stopThreshold);
      // Extra damping to halt oscillation completely without bouncy ringing
      float settleBrake = stopRatio * (criticalDamping + dispMag * 12.0 + furSpeed * 3.5);
      dynamicDamping += settleBrake;
    }

    // Semi-implicit Euler / Verlet velocity integration with dynamic exponential damping
    vel = (vel + force * dt) * exp(-dynamicDamping * dt);

    // Clamp max velocity for guaranteed numerical stability
    float speed = length(vel);
    if (speed > 6.0) {
      vel = (vel / speed) * 6.0;
    }

    gl_FragColor = vec4(vel, combMemory);
  }
`;

const POSITION_FRAGMENT_SHADER = /* glsl */ `
  uniform float uDelta;
  uniform vec3 uPointerLocalPos;
  uniform float uPointerActive;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    float theta = (uv.x * 2.0 - 1.0) * 3.14159265;
    float phi = (1.0 - uv.y) * 3.14159265;
    vec3 surfNormal = normalize(vec3(
      sin(phi) * sin(theta),
      cos(phi),
      sin(phi) * cos(theta)
    ));

    vec4 posData = texture2D(texturePosition, uv);
    vec4 velData = texture2D(textureVelocity, uv);
    vec3 disp = posData.xyz;
    float combMemory = posData.w;
    vec3 vel = velData.xyz;

    float dt = clamp(uDelta, 0.001, 0.033);
    disp += vel * dt;

    // Allow controlled soft compression under finger contact without penetrating body
    float inward = dot(disp, surfNormal);
    if (inward < -0.22) {
      disp -= surfNormal * (inward + 0.22);
    }

    // Smooth resting deadband to extinguish sub-pixel numerical vibration when settling
    if (length(disp) < 0.004 && length(vel) < 0.006) {
      disp = vec3(0.0);
    }

    // Elastic length constraint (prevents infinite stretching under extreme forces)
    float maxDisp = 0.85;
    float dLen = length(disp);
    if (dLen > maxDisp) {
      disp = (disp / dLen) * maxDisp;
    }

    // Track recently petted/groomed regions in alpha channel for subtle sheen boost
    combMemory *= exp(-dt * 1.2);
    if (uPointerActive > 0.5) {
      float dist = distance(surfNormal, normalize(uPointerLocalPos + vec3(0.0, 0.0, 1e-5)));
      if (dist < 0.45) {
        combMemory = min(1.0, combMemory + (1.0 - dist / 0.45) * dt * 8.0);
      }
    }

    gl_FragColor = vec4(disp, combMemory);
  }
`;

export function createGPUFurPhysics(renderer) {
  let gpuCompute = null;
  let posVariable = null;
  let velVariable = null;
  let fallbackTexture = null;
  let isGPGPUActive = false;

  // Create a safe 4x4 fallback float texture in case a software WebGL context lacks float RTT
  const fallbackData = new Float32Array(4 * 4 * 4);
  fallbackTexture = new THREE.DataTexture(
    fallbackData,
    4,
    4,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  fallbackTexture.needsUpdate = true;

  try {
    gpuCompute = new GPUComputationRenderer(SIM_SIZE, SIM_SIZE, renderer);
    if (!renderer.capabilities.isWebGL2) {
      gpuCompute.setDataType(THREE.HalfFloatType);
    } else {
      gpuCompute.setDataType(THREE.HalfFloatType);
    }

    const dtPosition = gpuCompute.createTexture();
    const dtVelocity = gpuCompute.createTexture();

    posVariable = gpuCompute.addVariable('texturePosition', POSITION_FRAGMENT_SHADER, dtPosition);
    velVariable = gpuCompute.addVariable('textureVelocity', VELOCITY_FRAGMENT_SHADER, dtVelocity);

    gpuCompute.setVariableDependencies(velVariable, [posVariable, velVariable]);
    gpuCompute.setVariableDependencies(posVariable, [posVariable, velVariable]);

    // Initialize velocity uniforms
    velVariable.material.uniforms.uTime = { value: 0.0 };
    velVariable.material.uniforms.uDelta = { value: 0.016 };
    velVariable.material.uniforms.uStiffness = { value: 26.0 };
    velVariable.material.uniforms.uDamping = { value: 5.2 };
    velVariable.material.uniforms.uGravity = { value: 2.8 };
    velVariable.material.uniforms.uWindStrength = { value: 1.4 };
    velVariable.material.uniforms.uCreatureVelocity = { value: new THREE.Vector3() };
    velVariable.material.uniforms.uCreatureAngularVel = { value: new THREE.Vector3() };
    velVariable.material.uniforms.uCreatureDecel = { value: 0.0 };
    velVariable.material.uniforms.uPointerLocalPos = { value: new THREE.Vector3(0, 0, 1) };
    velVariable.material.uniforms.uPointerVelocity = { value: new THREE.Vector3() };
    velVariable.material.uniforms.uPointerActive = { value: 0.0 };
    velVariable.material.uniforms.uBoopShockwave = { value: 0.0 };
    velVariable.material.uniforms.uHitOrigin = { value: new THREE.Vector3(0.0, 0.1, 0.98) };
    velVariable.material.uniforms.uHitOriginNormal = { value: new THREE.Vector3(0.0, 0.1, 0.98) };
    velVariable.material.uniforms.uHitStrength = { value: 0.0 };
    velVariable.material.uniforms.uHitTime = { value: 0.0 };

    // Initialize position uniforms
    posVariable.material.uniforms.uDelta = { value: 0.016 };
    posVariable.material.uniforms.uPointerLocalPos = { value: new THREE.Vector3(0, 0, 1) };
    posVariable.material.uniforms.uPointerActive = { value: 0.0 };

    const error = gpuCompute.init();
    if (error === null) {
      isGPGPUActive = true;
    } else {
      console.warn('GPGPU fallback mode enabled:', error);
    }
  } catch (e) {
    console.warn('GPGPU initialization fell back to analytical shader physics');
  }

  let prevCreatureSpeed = 0.0;

  function step({
    time,
    dt,
    windStrength,
    creatureVelocity,
    creatureAngularVel,
    pointerLocalPos,
    pointerVelocity,
    pointerActive,
    boopShockwave,
    hitOrigin = null,
    hitOriginNormal = null,
    hitStrength = 0.0,
    hitTime = 0.0
  }) {
    if (!isGPGPUActive || !gpuCompute) {
      return fallbackTexture;
    }

    const vUni = velVariable.material.uniforms;
    const pUni = posVariable.material.uniforms;

    // Track sudden creature deceleration for immediate dynamic settle brake
    const curSpeed = creatureVelocity.length() + creatureAngularVel.length() * 0.55;
    const safeDt = Math.max(0.001, dt);
    const rawDecel = Math.max(0.0, (prevCreatureSpeed - curSpeed) / safeDt);
    prevCreatureSpeed = curSpeed;

    vUni.uTime.value = time;
    vUni.uDelta.value = dt;
    vUni.uWindStrength.value = windStrength;
    vUni.uCreatureVelocity.value.copy(creatureVelocity);
    vUni.uCreatureAngularVel.value.copy(creatureAngularVel);
    vUni.uCreatureDecel.value = Math.min(25.0, rawDecel);
    vUni.uPointerLocalPos.value.copy(pointerLocalPos);
    vUni.uPointerVelocity.value.copy(pointerVelocity);
    vUni.uPointerActive.value = pointerActive ? 1.0 : 0.0;
    vUni.uBoopShockwave.value = boopShockwave;
    if (hitOrigin) vUni.uHitOrigin.value.copy(hitOrigin);
    if (hitOriginNormal) vUni.uHitOriginNormal.value.copy(hitOriginNormal);
    vUni.uHitStrength.value = hitStrength;
    vUni.uHitTime.value = hitTime;

    pUni.uDelta.value = dt;
    pUni.uPointerLocalPos.value.copy(pointerLocalPos);
    pUni.uPointerActive.value = pointerActive ? 1.0 : 0.0;

    gpuCompute.compute();
    return gpuCompute.getCurrentRenderTarget(posVariable).texture;
  }

  return {
    step,
    get isGPGPUActive() {
      return isGPGPUActive;
    },
    get fallbackTexture() {
      return fallbackTexture;
    }
  };
}

/**
 * Pure helper for calculating the velocity-dependent dynamic dampening factor.
 * Used for deterministic unit testing and analytical WebGL fallback synchronization.
 */
export function computeDynamicDamping({
  linearSpeed = 0.0,
  angularSpeed = 0.0,
  deceleration = 0.0,
  dispMag = 0.0,
  furSpeed = 0.0,
  baseDamping = 5.2,
  stiffness = 26.0,
  stopThreshold = 0.42
} = {}) {
  const totalCreatureMotion = linearSpeed + angularSpeed * 0.55;
  let dynamicDamping = baseDamping + totalCreatureMotion * 4.5 + deceleration * 3.8;
  const criticalDamping = 2.0 * Math.sqrt(Math.max(1.0, stiffness));

  if (totalCreatureMotion < stopThreshold && (dispMag > 0.003 || furSpeed > 0.005)) {
    const stopRatio = 1.0 - (totalCreatureMotion / stopThreshold);
    const settleBrake = stopRatio * (criticalDamping + dispMag * 12.0 + furSpeed * 3.5);
    dynamicDamping += settleBrake;
  }

  return dynamicDamping;
}


