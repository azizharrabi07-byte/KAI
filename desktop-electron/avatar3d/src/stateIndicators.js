import * as THREE from 'three';
import { KAI_STATES } from './kaiState.js';

/**
 * State Indicators for KAI 3D AI Companion
 *
 * Implements:
 * 1. THINKING: A real, charming little 3D fluffy cumulus cloud hovering poised above KAI's head.
 *    Features multiple organic overlapping billowing puffs, soft cotton-white crest with
 *    sky-blue shadow and gentle inner cyan idea luminescence, breathing puff scales, and
 *    tiny dreamy vapor droplets drifting underneath.
 *
 * 2. WORKING: "Collecting ideas flying in the sky together" — A luminous synthesis nexus
 *    core surrounded by quantum orbiting containment rings, actively attracting and
 *    gathering wandering idea sparks that fly in from the sky along converging spiral trajectories.
 *
 * 3. SUCCESS: Restrained mint-cyan crown aura and blossoming star sparkles.
 * 4. ERROR: Warm-colored coral aura expanding gently around the silhouette perimeter.
 * 5. Deterministic lifecycle with clean interruptible hand-offs and zero orphaned objects.
 */

// Volumetric fluffy cloud shader for Thinking state
const CLOUD_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mvPosition.xyz;
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uCloudColor;      // Pure cotton white crest
  uniform vec3 uShadowColor;     // Soft sky-blue underside
  uniform vec3 uIdeaGlowColor;   // Cyan idea self-illumination
  uniform float uOpacity;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewPos);
    vec3 L = normalize(vec3(0.35, 0.85, 0.55)); // Key sunlight angle

    float NdotL = dot(N, L);
    float wrapDiff = smoothstep(-0.25, 0.75, NdotL);

    // Silver-lining Fresnel edge illumination around fluffy cloud lobes
    float fresnel = pow(1.0 - max(0.0, dot(N, V)), 2.0);

    // Organic top-crest highlight vs soft sky-blue belly
    float verticalGrad = N.y * 0.5 + 0.5;
    vec3 col = mix(uShadowColor, uCloudColor, wrapDiff * 0.70 + verticalGrad * 0.30);

    // Internal "ideas brewing" subtle cyan luminescence
    float thoughtPulse = 0.5 + 0.5 * sin(uTime * 2.2 + vWorldPos.x * 4.0);
    col = mix(col, uIdeaGlowColor, thoughtPulse * 0.22);
    col += uCloudColor * (fresnel * 0.42);

    float alpha = uOpacity * (0.90 + 0.10 * fresnel);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

// Glowing spark particle shader for collected idea motes
const SPARK_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 worldCenter = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 mvPos = viewMatrix * worldCenter;
    mvPos.xy += position.xy;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const SPARK_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    float core = exp(-r * r * 8.0);
    float aura = exp(-r * 2.5) * 0.6;
    float alpha = (core * 0.95 + aura * 0.40) * uOpacity;

    vec3 col = mix(uColor, vec3(0.96, 0.99, 1.0), core * 0.90);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

// Subtle sparkle star shader for success confirmation
const SPARKLE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    // 4-point diamond sparkle star
    float star = max(0.0, 1.0 - abs(p.x) * 3.8) * max(0.0, 1.0 - abs(p.y) * 1.2)
               + max(0.0, 1.0 - abs(p.y) * 3.8) * max(0.0, 1.0 - abs(p.x) * 1.2);
    float core = exp(-r * r * 7.0);
    float alpha = clamp(star * 0.85 + core * 0.65, 0.0, 1.0) * uOpacity;

    vec3 col = mix(uColor, vec3(1.0), core);
    gl_FragColor = vec4(col, alpha);
  }
`;

// Warm expanding pulse ring shader for error notification
const PULSE_RING_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uProgress;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    // Expanding soft perimeter corona around silhouette
    float ringCenter = 0.52 + uProgress * 0.42;
    float ringWidth = 0.20 * (1.0 - uProgress * 0.40);
    float d = abs(r - ringCenter);
    float ringAlpha = (1.0 - smoothstep(0.0, ringWidth, d)) * (1.0 - uProgress);

    gl_FragColor = vec4(uColor, clamp(ringAlpha * uOpacity, 0.0, 1.0));
  }
`;

export function createStateIndicators(stateController) {
  const root = new THREE.Group();
  root.name = 'KAIStateIndicators';

  // -------------------------------------------------------------------------
  // 1. THINKING: One Big Fluffy Cloud on Top Left Emanating from Brain (No Rain)
  // -------------------------------------------------------------------------
  const thinkingGroup = new THREE.Group();
  thinkingGroup.name = 'ThinkingCloud';
  thinkingGroup.visible = false;
  root.add(thinkingGroup);

  // Position: poise on KAI's top-left
  const cloudBaseAnchor = new THREE.Vector3(-0.48, 1.66, 0.22);
  thinkingGroup.position.copy(cloudBaseAnchor);

  const cloudMaterial = new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERTEX_SHADER,
    fragmentShader: CLOUD_FRAGMENT_SHADER,
    uniforms: {
      uCloudColor: { value: new THREE.Color('#ffffff') },
      uShadowColor: { value: new THREE.Color('#bae6fd') },
      uIdeaGlowColor: { value: new THREE.Color('#38bdf8') },
      uOpacity: { value: 0.0 },
      uTime: { value: 0.0 }
    },
    transparent: true,
    depthTest: true,
    depthWrite: false
  });

  // Cluster forming ONE BIG cohesive, billowing thought cloud
  const puffSpecs = [
    { radius: 0.225, offset: [0.0, 0.04, 0.0], scale: [1.18, 0.96, 0.98], phase: 0.0 },
    { radius: 0.185, offset: [-0.18, 0.01, 0.02], scale: [1.08, 0.90, 0.92], phase: 1.1 },
    { radius: 0.190, offset: [0.18, -0.01, 0.01], scale: [1.10, 0.92, 0.94], phase: 2.2 },
    { radius: 0.170, offset: [-0.04, 0.14, -0.02], scale: [1.02, 0.88, 0.90], phase: 3.3 },
    { radius: 0.155, offset: [0.03, -0.07, 0.09], scale: [1.15, 0.78, 0.88], phase: 4.4 },
    { radius: 0.160, offset: [-0.08, 0.06, -0.09], scale: [1.06, 0.84, 0.90], phase: 5.5 },
    { radius: 0.145, offset: [0.08, 0.10, 0.04], scale: [0.98, 0.92, 0.88], phase: 1.8 }
  ];

  const cloudPuffs = [];
  puffSpecs.forEach((spec) => {
    const geo = new THREE.SphereGeometry(spec.radius, 22, 16);
    geo.scale(spec.scale[0], spec.scale[1], spec.scale[2]);
    const mesh = new THREE.Mesh(geo, cloudMaterial);
    mesh.position.set(spec.offset[0], spec.offset[1], spec.offset[2]);
    mesh.renderOrder = 100;
    thinkingGroup.add(mesh);
    cloudPuffs.push({ mesh, baseScale: mesh.scale.clone(), phase: spec.phase });
  });

  // Thought bubbles connecting KAI's head/brain to the big cloud
  // Emanating from his left temple region up into the underside of the cloud
  const bubbleSpecs = [
    { size: 0.046, offset: [0.24, -0.48, 0.18], phase: 0.4 }, // Lowest, near brain
    { size: 0.072, offset: [0.15, -0.30, 0.12], phase: 1.6 }, // Mid-ascent
    { size: 0.105, offset: [0.08, -0.15, 0.06], phase: 2.8 }  // Upper expansion into cloud
  ];
  const thoughtBubbles = [];
  bubbleSpecs.forEach((spec) => {
    const bGeo = new THREE.SphereGeometry(spec.size, 18, 14);
    const bMesh = new THREE.Mesh(bGeo, cloudMaterial);
    bMesh.position.set(spec.offset[0], spec.offset[1], spec.offset[2]);
    bMesh.renderOrder = 100;
    thinkingGroup.add(bMesh);
    thoughtBubbles.push({
      mesh: bMesh,
      basePos: bMesh.position.clone(),
      baseScale: bMesh.scale.clone(),
      phase: spec.phase,
      size: spec.size
    });
  });

  // -------------------------------------------------------------------------
  // 2. WORKING: Collecting Ideas Flying in Front of Him (Occluded from Behind)
  // -------------------------------------------------------------------------
  const workingGroup = new THREE.Group();
  workingGroup.name = 'WorkingCollectingIdeas';
  workingGroup.visible = false;
  root.add(workingGroup);

  // Position: directly in front of him (chest / face space)
  const nexusAnchor = new THREE.Vector3(0.0, 0.98, 0.86);
  workingGroup.position.copy(nexusAnchor);

  // A. Synthesis Core (where ideas converge and condense into work)
  const nexusCoreMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#38bdf8'),
    transparent: true,
    opacity: 0.0,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const nexusCoreGeo = new THREE.SphereGeometry(0.082, 18, 14);
  const nexusCoreMesh = new THREE.Mesh(nexusCoreGeo, nexusCoreMat);
  nexusCoreMesh.renderOrder = 105;
  workingGroup.add(nexusCoreMesh);

  // B. Orbiting Quantum Energy Containment Rings
  const ringMat1 = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#00e5ff'),
    transparent: true,
    opacity: 0.0,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const ringMat2 = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#7dd3fc'),
    transparent: true,
    opacity: 0.0,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  const ringGeo1 = new THREE.TorusGeometry(0.18, 0.011, 8, 36);
  const ringMesh1 = new THREE.Mesh(ringGeo1, ringMat1);
  ringMesh1.rotation.x = Math.PI * 0.35;
  ringMesh1.renderOrder = 104;
  workingGroup.add(ringMesh1);

  const ringGeo2 = new THREE.TorusGeometry(0.13, 0.009, 8, 32);
  const ringMesh2 = new THREE.Mesh(ringGeo2, ringMat2);
  ringMesh2.rotation.y = Math.PI * 0.42;
  ringMesh2.renderOrder = 104;
  workingGroup.add(ringMesh2);

  // C. 10 Idea Motes Flying in from the Sky to be Collected
  const IDEA_COUNT = 10;
  const sparkGeo = new THREE.PlaneGeometry(0.14, 0.14);
  const ideaMotes = [];

  // Sky origin positions scattered around KAI's ambient space
  const skyOrigins = [
    new THREE.Vector3(-0.95, 0.75, 0.25),
    new THREE.Vector3(-0.55, 1.15, -0.15),
    new THREE.Vector3(0.15, 1.35, 0.35),
    new THREE.Vector3(0.65, 1.25, -0.20),
    new THREE.Vector3(1.15, 0.85, 0.20),
    new THREE.Vector3(-0.80, 0.35, 0.45),
    new THREE.Vector3(-0.25, 0.95, 0.55),
    new THREE.Vector3(0.45, 1.10, 0.45),
    new THREE.Vector3(0.95, 0.45, -0.10),
    new THREE.Vector3(-0.45, 0.65, -0.30)
  ];

  for (let i = 0; i < IDEA_COUNT; i++) {
    const sMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERTEX_SHADER,
      fragmentShader: SPARK_FRAGMENT_SHADER,
      uniforms: {
        uColor: { value: new THREE.Color(i % 2 === 0 ? '#38bdf8' : '#67e8f9') },
        uOpacity: { value: 0.0 }
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    const sMesh = new THREE.Mesh(sparkGeo, sMat);
    sMesh.renderOrder = 105;
    workingGroup.add(sMesh);

    ideaMotes.push({
      mesh: sMesh,
      mat: sMat,
      skyOrigin: skyOrigins[i % skyOrigins.length],
      // Staggered travel phase so motes continuously arrive in sequence
      progress: (i / IDEA_COUNT),
      speed: 0.38 + (i % 3) * 0.08,
      spiralAngle: (i / IDEA_COUNT) * Math.PI * 2.0,
      scale: 0.75 + (i % 3) * 0.22
    });
  }

  // -------------------------------------------------------------------------
  // 3. SUCCESS: Restrained Crown Confirmation Halo + 2 Delicate Star Sparkles
  // -------------------------------------------------------------------------
  const successGroup = new THREE.Group();
  successGroup.name = 'SuccessConfirmation';
  successGroup.visible = false;
  root.add(successGroup);

  const successAnchor = new THREE.Vector3(0.0, 1.54, 0.40);
  successGroup.position.copy(successAnchor);

  const haloMat = new THREE.ShaderMaterial({
    vertexShader: SPARK_VERTEX_SHADER,
    fragmentShader: SPARK_FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: new THREE.Color('#34d399') },
      uOpacity: { value: 0.0 }
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const haloMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.58), haloMat);
  haloMesh.renderOrder = 100;
  successGroup.add(haloMesh);

  const sparkleMat1 = new THREE.ShaderMaterial({
    vertexShader: SPARK_VERTEX_SHADER,
    fragmentShader: SPARKLE_FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: new THREE.Color('#a7f3d0') },
      uOpacity: { value: 0.0 }
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const sparkleMat2 = sparkleMat1.clone();
  sparkleMat2.uniforms.uColor.value.set('#6ee7b7');

  const sparkle1 = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28), sparkleMat1);
  sparkle1.renderOrder = 100;
  const sparkle2 = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), sparkleMat2);
  sparkle2.renderOrder = 100;
  sparkle1.position.set(-0.16, 0.08, 0.0);
  sparkle2.position.set(0.18, 0.04, 0.0);
  successGroup.add(sparkle1);
  successGroup.add(sparkle2);

  // -------------------------------------------------------------------------
  // 4. ERROR: Dignified Warm Coral Aura Expanding Outward around Silhouette
  // -------------------------------------------------------------------------
  const errorGroup = new THREE.Group();
  errorGroup.name = 'ErrorPulse';
  errorGroup.visible = false;
  root.add(errorGroup);

  const errorMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: PULSE_RING_FRAGMENT_SHADER,
    uniforms: {
      uColor: { value: new THREE.Color('#f87171') },
      uOpacity: { value: 0.0 },
      uProgress: { value: 0.0 }
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  const errorPlane = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), errorMat);
  errorPlane.position.set(0.0, 0.15, -0.15);
  errorPlane.renderOrder = 5;
  errorGroup.add(errorPlane);

  // -------------------------------------------------------------------------
  // Lifecycle & State Transition State
  // -------------------------------------------------------------------------
  let thinkingAlpha = 0.0;
  let workingAlpha = 0.0;
  let successTimer = 0.0;
  let errorTimer = 0.0;
  let activeState = stateController ? stateController.getState() : KAI_STATES.IDLE;
  let time = 0.0;

  if (stateController) {
    stateController.subscribe((payload) => {
      const newState = payload.state;
      activeState = newState;

      if (newState === KAI_STATES.SUCCESS) {
        successTimer = 1.35;
        errorTimer = 0.0;
      } else if (newState === KAI_STATES.BLOCKED_OR_ERROR) {
        errorTimer = 1.05;
        successTimer = 0.0;
      } else {
        successTimer = 0.0;
        errorTimer = 0.0;
      }
    });
  }

  /**
   * Per-frame deterministic update
   * Accepts camera to compute view-angle occlusion for working indicator
   */
  function update(dt, motion = null, camera = null) {
    time += dt;

    const currentState = stateController ? stateController.getState() : activeState;
    const isThinking = currentState === KAI_STATES.THINKING;
    const isWorking = currentState === KAI_STATES.WORKING;

    // Follow character head/posture lag smoothly
    const headOffsetY = motion ? motion.liftY * 0.75 : 0.0;
    const headOffsetZ = motion ? motion.offsetZ * 0.75 : 0.0;

    // -----------------------------------------------------------------------
    // A. THINKING: Big Thought Cloud on Top Left Emanating from Brain
    // -----------------------------------------------------------------------
    const thinkingTarget = isThinking ? 1.0 : 0.0;
    const thinkingEaseSpeed = isThinking ? 3.8 : 8.5;
    thinkingAlpha += (thinkingTarget - thinkingAlpha) * Math.min(1.0, dt * thinkingEaseSpeed);

    if (thinkingAlpha > 0.005) {
      thinkingGroup.visible = true;

      // Buoyant floating bobbing motion on his top-left
      const bobY = Math.sin(time * 1.6) * 0.028;
      const swayX = Math.cos(time * 1.1) * 0.018;
      thinkingGroup.position.set(
        cloudBaseAnchor.x + swayX,
        cloudBaseAnchor.y + headOffsetY + bobY,
        cloudBaseAnchor.z + headOffsetZ
      );

      // Cloud scale-up ease in [0.7 -> 1.0]
      const cloudScale = THREE.MathUtils.lerp(0.70, 1.0, thinkingAlpha);
      thinkingGroup.scale.setScalar(cloudScale);

      cloudMaterial.uniforms.uOpacity.value = thinkingAlpha * 0.94;
      cloudMaterial.uniforms.uTime.value = time;

      // Billowing respiration across the big cumulus cloud lobes
      cloudPuffs.forEach((puff) => {
        const puffBreath = 1.0 + Math.sin(time * 1.8 + puff.phase) * 0.045;
        puff.mesh.scale.set(
          puff.baseScale.x * puffBreath,
          puff.baseScale.y * puffBreath,
          puff.baseScale.z * puffBreath
        );
      });

      // Ascending thought-puff progression: pulses rising from the brain into the cloud
      thoughtBubbles.forEach((bubble, i) => {
        const ascendPhase = time * 2.8 - i * 0.85;
        const bubbleBreath = 1.0 + Math.sin(ascendPhase) * 0.12;
        const bubbleHopY = Math.sin(ascendPhase) * 0.016;
        bubble.mesh.position.y = bubble.basePos.y + bubbleHopY;
        bubble.mesh.scale.set(
          bubble.baseScale.x * bubbleBreath,
          bubble.baseScale.y * bubbleBreath,
          bubble.baseScale.z * bubbleBreath
        );
      });
    } else {
      thinkingAlpha = 0.0;
      thinkingGroup.visible = false;
    }

    // -----------------------------------------------------------------------
    // B. WORKING: Collecting Ideas in Front of Him (Invisible from Back)
    // -----------------------------------------------------------------------
    const workingTarget = isWorking ? 1.0 : 0.0;
    const workingEaseSpeed = isWorking ? 4.2 : 9.0;
    workingAlpha += (workingTarget - workingAlpha) * Math.min(1.0, dt * workingEaseSpeed);

    // Compute view angle relative to camera: when viewing from behind KAI,
    // the working nexus and ideas cannot be seen (smoothly occluded)
    let frontFacingFactor = 1.0;
    if (camera && camera.position) {
      const camZ = camera.position.z;
      // When camera orbits behind KAI (camZ <= 0.0), frontFacingFactor is 0.0
      frontFacingFactor = THREE.MathUtils.smoothstep(camZ, -0.15, 0.75);
    }

    const effectiveWorkingAlpha = workingAlpha * frontFacingFactor;

    if (effectiveWorkingAlpha > 0.005) {
      workingGroup.visible = true;

      const nexusBobY = Math.sin(time * 2.2) * 0.02;
      workingGroup.position.set(
        nexusAnchor.x,
        nexusAnchor.y + headOffsetY + nexusBobY,
        nexusAnchor.z + headOffsetZ
      );

      const nexusScale = THREE.MathUtils.lerp(0.70, 1.0, effectiveWorkingAlpha);
      workingGroup.scale.setScalar(nexusScale);

      // Real task progress check
      const realProgress = stateController && typeof stateController.getProgress === 'function'
        ? stateController.getProgress()
        : null;
      const hasRealProgress = realProgress !== null && Number.isFinite(realProgress);

      // 1. Central Synthesis Core Pulse
      const corePulse = 0.75 + 0.25 * Math.sin(time * 4.5);
      const progressBoost = hasRealProgress ? (0.2 + 0.8 * realProgress) : 0.6;
      nexusCoreMat.opacity = effectiveWorkingAlpha * corePulse * (0.65 + 0.35 * progressBoost);
      const coreSize = 1.0 + (hasRealProgress ? realProgress * 0.4 : 0.15 * Math.sin(time * 3.0));
      nexusCoreMesh.scale.setScalar(coreSize);

      // 2. Quantum Orbiting Containment Rings
      const ringSpinSpeed = hasRealProgress ? (2.0 + realProgress * 3.5) : 2.8;
      ringMesh1.rotation.z += dt * ringSpinSpeed;
      ringMesh2.rotation.x += dt * (ringSpinSpeed * 0.85);
      ringMat1.opacity = effectiveWorkingAlpha * 0.80;
      ringMat2.opacity = effectiveWorkingAlpha * 0.65;

      // 3. Idea Motes Swirling and Converging Inward into Front Core
      ideaMotes.forEach((mote, i) => {
        mote.progress = (mote.progress + dt * mote.speed) % 1.0;
        const p = mote.progress;

        const invP = 1.0 - p;
        const spiralRot = p * Math.PI * 4.0 + mote.spiralAngle;
        const spiralRadius = invP * 0.65;

        const posX = (mote.skyOrigin.x - nexusAnchor.x) * (invP * invP) + Math.cos(spiralRot) * spiralRadius;
        const posY = (mote.skyOrigin.y - nexusAnchor.y) * (invP * invP) + Math.sin(spiralRot) * spiralRadius;
        const posZ = (mote.skyOrigin.z - nexusAnchor.z) * (invP * invP) + Math.sin(spiralRot * 0.5) * (spiralRadius * 0.4);

        mote.mesh.position.set(posX, posY, posZ);

        const moteAlpha = Math.sin(p * Math.PI) * effectiveWorkingAlpha * 0.95;
        mote.mat.uniforms.uOpacity.value = moteAlpha;

        const moteSize = (mote.scale * (0.6 + 0.4 * Math.sin(p * Math.PI))) * (0.8 + 0.2 * Math.sin(time * 5.0 + i));
        mote.mesh.scale.setScalar(moteSize);
      });
    } else {
      workingGroup.visible = false;
    }

    // -----------------------------------------------------------------------
    // C. SUCCESS CONFIRMATION UPDATE
    // -----------------------------------------------------------------------
    if (successTimer > 0) {
      successTimer = Math.max(0, successTimer - dt);
      const p = 1.0 - (successTimer / 1.35);
      successGroup.visible = true;
      successGroup.position.set(
        successAnchor.x,
        successAnchor.y + headOffsetY,
        successAnchor.z + headOffsetZ
      );

      const haloProgress = Math.sin(p * Math.PI);
      haloMat.uniforms.uOpacity.value = Math.pow(haloProgress, 1.2) * 0.75;
      haloMesh.scale.setScalar(0.75 + p * 0.55);

      const sparkleAlpha = Math.sin(p * Math.PI) * 0.90;
      sparkleMat1.uniforms.uOpacity.value = sparkleAlpha;
      sparkleMat2.uniforms.uOpacity.value = sparkleAlpha * 0.95;

      sparkle1.rotation.z = p * 0.8;
      sparkle2.rotation.z = -p * 0.9;
      sparkle1.scale.setScalar(0.6 + p * 0.7);
      sparkle2.scale.setScalar(0.5 + p * 0.6);
    } else {
      successGroup.visible = false;
    }

    // -----------------------------------------------------------------------
    // D. ERROR PULSE UPDATE
    // -----------------------------------------------------------------------
    if (errorTimer > 0) {
      errorTimer = Math.max(0, errorTimer - dt);
      const p = 1.0 - (errorTimer / 1.05);
      errorGroup.visible = true;

      errorMat.uniforms.uProgress.value = p;
      const pulseFade = Math.sin(p * Math.PI * 0.9);
      errorMat.uniforms.uOpacity.value = pulseFade * 0.80;
      errorPlane.scale.setScalar(0.85 + p * 0.65);
    } else {
      errorGroup.visible = false;
    }
  }

  return {
    root,
    thinkingGroup,
    workingGroup,
    successGroup,
    errorGroup,
    cloudPuffs,
    thoughtBubbles,
    cloudDroplets: thoughtBubbles,
    vaporDroplets: thoughtBubbles,
    nexusCoreMesh,
    nexusMesh: nexusCoreMesh,
    ringMesh1,
    ringMesh2,
    ideaMotes,
    ideaSparks: ideaMotes,
    cloudBaseAnchor,
    nexusAnchor,
    getThinkingAlpha: () => thinkingAlpha,
    getWorkingAlpha: () => workingAlpha,
    isThinkingActive: () => thinkingAlpha > 0.01,
    isWorkingActive: () => workingAlpha > 0.01,
    triggerSuccess: () => { successTimer = 1.35; },
    triggerError: () => { errorTimer = 1.05; },
    update
  };
}
