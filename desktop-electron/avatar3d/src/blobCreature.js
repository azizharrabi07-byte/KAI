import * as THREE from 'three';

/**
 * Evaluates the anatomical follicle growth mask at a local position on the blob surface.
 * Returns a float in [0.0, 1.25]:
 * - 0.0 inside eye sockets and mouth/nose recess (prevents hair from poking through eyes/mouth)
 * - Smoothly tapers (0.2 -> 1.0) around the eye rims, nose bridge, and base
 * - Refined velvet density on the cheek contours and ear tips
 */
export function evaluateFollicleMask(x, y, z) {
  // Left and right eye centers in local space
  const lx = x + 0.31;
  const rx = x - 0.31;
  const ey = y - 0.16;
  const ez = z - 0.88;

  const distLeftEye = Math.sqrt(lx * lx + ey * ey * 1.1 + ez * ez);
  const distRightEye = Math.sqrt(rx * rx + ey * ey * 1.1 + ez * ez);
  const minEyeDist = Math.min(distLeftEye, distRightEye);

  // Tightly match cornea radius, transitioning into short velvety fuzz so there is no bald ring
  if (minEyeDist < 0.145) {
    return 0.0;
  }
  const eyeMask = 0.28 + 0.72 * smoothstep(0.145, 0.25, minEyeDist);

  // Clean mask surrounding the refined KAI nose node & subtle smile curve
  const mx = x / 1.15;
  const my = (y - 0.04) * 1.35;
  const mz = z - 0.98;
  const distMouth = Math.sqrt(mx * mx + my * my + mz * mz);
  const mouthMask = 0.20 + 0.80 * smoothstep(0.07, 0.18, distMouth);

  // Bottom belly contact pad taper
  const bottomMask = smoothstep(-1.05, -0.72, y);

  // Controlled, soft velvet profile on cheek contours
  const cheekDist = Math.min(
    Math.hypot(x + 0.56, y - 0.02, z - 0.68),
    Math.hypot(x - 0.56, y - 0.02, z - 0.68)
  );
  const cheekFluff = 1.0 + 0.16 * (1.0 - smoothstep(0.0, 0.42, cheekDist));

  return Math.max(0.0, Math.min(1.25, eyeMask * mouthMask * bottomMask * cheekFluff));
}

/**
 * Computes the biological grooming flow tangent vector on the blob surface.
 * Hairs part naturally from a crown whorl at the top of the head, sweep around
 * the eye sockets, and flow downward with a subtle sleek streamline.
 */
export function evaluateGroomFlow(x, y, z, nx, ny, nz) {
  let fx = x * 0.25;
  let fy = -0.85;
  let fz = (z - 0.15) * 0.25;

  const eyeCenters = [
    [-0.33, 0.17, 0.86],
    [0.33, 0.17, 0.86]
  ];
  for (let i = 0; i < 2; i++) {
    const [ex, ey, ez] = eyeCenters[i];
    const dx = x - ex;
    const dy = y - ey;
    const dz = z - ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5;
    if (d < 0.48) {
      const influence = (1.0 - d / 0.48) * 0.85;
      fx += (dx / d) * influence;
      fy += (dy / d) * influence * 0.6;
      fz += (dz / d) * influence * 0.3;
    }
  }

  // Project onto the tangent plane orthogonal to surface normal N
  const dotFN = fx * nx + fy * ny + fz * nz;
  let tx = fx - dotFN * nx;
  let ty = fy - dotFN * ny;
  let tz = fz - dotFN * nz;
  const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (len > 1e-5) {
    tx /= len;
    ty /= len;
    tz /= len;
  } else {
    tx = 1.0;
    ty = 0.0;
    tz = 0.0;
  }
  return [tx, ty, tz];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

function sculptBlobPosition(u, v, w) {
  let x = u;
  let y = v;
  let z = w;

  const bellyWidth = 1.0 + 0.22 * Math.exp(-Math.pow((y + 0.24) / 0.55, 2.0));
  const cheekPuff = 1.0 + 0.14 * Math.exp(-Math.pow((y + 0.05) / 0.38, 2.0)) * Math.max(0, z);
  x *= bellyWidth * cheekPuff;
  z *= (0.94 + 0.12 * Math.exp(-Math.pow((y + 0.22) / 0.6, 2.0)));
  y *= 0.96;

  if (y < -0.55) {
    const t = (-0.55 - y) / 0.45;
    y = -0.55 - Math.tanh(t * 1.15) * 0.32;
  }

  const leftEarDir = normalize3(-0.46, 0.86, 0.06);
  const rightEarDir = normalize3(0.46, 0.86, 0.06);
  const dotLEar = Math.max(0.0, u * leftEarDir[0] + v * leftEarDir[1] + w * leftEarDir[2]);
  const dotREar = Math.max(0.0, u * rightEarDir[0] + v * rightEarDir[1] + w * rightEarDir[2]);
  const earProfile = Math.pow(Math.max(dotLEar, dotREar), 14.0) * 0.44;
  x += u * earProfile * 0.75;
  y += v * earProfile * 1.15;
  z += w * earProfile * 0.55;

  const leftArmDir = normalize3(-0.94, -0.08, 0.28);
  const rightArmDir = normalize3(0.94, -0.08, 0.28);
  const dotLArm = Math.max(0.0, u * leftArmDir[0] + v * leftArmDir[1] + w * leftArmDir[2]);
  const dotRArm = Math.max(0.0, u * rightArmDir[0] + v * rightArmDir[1] + w * rightArmDir[2]);
  const armProfile = Math.pow(Math.max(dotLArm, dotRArm), 18.0) * 0.24;
  x += u * armProfile * 1.1;
  y += v * armProfile * 0.6;
  z += w * armProfile * 0.9;

  const lx = x + 0.33;
  const rx = x - 0.33;
  const ey = y - 0.17;
  const ez = z - 0.86;
  const dEye = Math.min(
    Math.sqrt(lx * lx + ey * ey + ez * ez),
    Math.sqrt(rx * rx + ey * ey + ez * ez)
  );
  if (dEye < 0.32) {
    const indent = (1.0 - smoothstep(0.0, 0.32, dEye)) * 0.065;
    z -= indent;
  }

  return [x, y, z];
}

function normalize3(x, y, z) {
  const l = Math.sqrt(x * x + y * y + z * z) || 1.0;
  return [x / l, y / l, z / l];
}

export function createOrganicBlobGeometry(widthSegments = 96, heightSegments = 72) {
  const geom = new THREE.SphereGeometry(1.0, widthSegments, heightSegments);
  const posAttr = geom.attributes.position;
  const count = posAttr.count;

  for (let i = 0; i < count; i++) {
    const u = posAttr.getX(i);
    const v = posAttr.getY(i);
    const w = posAttr.getZ(i);
    const [sx, sy, sz] = sculptBlobPosition(u, v, w);
    posAttr.setXYZ(i, sx, sy, sz);
  }

  geom.computeVertexNormals();

  const normAttr = geom.attributes.normal;
  const follicleMaskArray = new Float32Array(count);
  const groomTangentArray = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const nx = normAttr.getX(i);
    const ny = normAttr.getY(i);
    const nz = normAttr.getZ(i);

    follicleMaskArray[i] = evaluateFollicleMask(x, y, z);
    const [tx, ty, tz] = evaluateGroomFlow(x, y, z, nx, ny, nz);
    groomTangentArray[i * 3] = tx;
    groomTangentArray[i * 3 + 1] = ty;
    groomTangentArray[i * 3 + 2] = tz;
  }

  geom.setAttribute('aFollicleMask', new THREE.BufferAttribute(follicleMaskArray, 1));
  geom.setAttribute('aGroomTangent', new THREE.BufferAttribute(groomTangentArray, 3));

  return geom;
}

/**
 * Creates the Official KAI 3D AI Companion with clean hierarchical transforms:
 *
 * placementRoot (World placement & AR surface anchors)
 *   └── orientationRoot (Camera-facing yaw and pitch)
 *         └── motionRoot (Authoritative animation, gestures, breathing & squashes)
 *               ├── bodyMesh (KAIBodyMesh)
 *               ├── faceGroup (eyes, nose, smile)
 *               ├── furSystem.shellMesh
 *               └── furSystem.strandMesh
 */
export function createBlobCreature(stateController = null) {
  // 1. Hierarchical Root Architecture: completely isolates placement, orientation & animation
  const placementRoot = new THREE.Group();
  placementRoot.name = 'KAIPlacementRoot';

  const orientationRoot = new THREE.Group();
  orientationRoot.name = 'KAIOrientationRoot';
  placementRoot.add(orientationRoot);

  const motionRoot = new THREE.Group();
  motionRoot.name = 'KAIMotionRoot';
  orientationRoot.add(motionRoot);

  // Backward-compatibility alias
  const root = placementRoot;

  const bodyGeometry = createOrganicBlobGeometry(96, 72);

  const skinMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#0a1324'),
    roughness: 0.82,
    metalness: 0.04
  });

  const bodyMesh = new THREE.Mesh(bodyGeometry, skinMaterial);
  bodyMesh.name = 'KAIBodyMesh';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  motionRoot.add(bodyMesh);

  // Facial features container
  const faceGroup = new THREE.Group();
  faceGroup.name = 'FacialFeatures';
  motionRoot.add(faceGroup);

  const eyeMaterial = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#060b15'),
    roughness: 0.04,
    metalness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    reflectivity: 1.0
  });

  const irisMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#09233e')
  });

  const irisAccentMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#38bdf8'),
    transparent: true,
    opacity: 0.70
  });

  const highlightMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#ffffff')
  });

  const skyHighlightMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#bae6fd')
  });

  const eyes = [];
  const eyeSides = [-1, 1];

  for (const side of eyeSides) {
    const eyePivot = new THREE.Group();
    eyePivot.position.set(side * 0.31, 0.16, 0.94);
    eyePivot.rotation.y = side * 0.22;
    eyePivot.rotation.x = -0.06;

    const eyeballGeo = new THREE.SphereGeometry(0.17, 32, 24);
    eyeballGeo.scale(0.96, 1.08, 0.68);
    const eyeball = new THREE.Mesh(eyeballGeo, eyeMaterial);
    eyePivot.add(eyeball);

    const irisGeo = new THREE.SphereGeometry(0.12, 24, 16);
    irisGeo.scale(0.92, 0.95, 0.38);
    const iris = new THREE.Mesh(irisGeo, irisMaterial);
    iris.position.set(0, -0.02, 0.086);
    eyePivot.add(iris);

    const irisAccentGeo = new THREE.SphereGeometry(0.085, 20, 12);
    irisAccentGeo.scale(1.0, 0.45, 0.3);
    const irisAccent = new THREE.Mesh(irisAccentGeo, irisAccentMat);
    irisAccent.position.set(0, -0.045, 0.092);
    eyePivot.add(irisAccent);

    const catchlightMainGeo = new THREE.SphereGeometry(0.042, 16, 12);
    catchlightMainGeo.scale(1.0, 1.15, 0.32);
    const catchlightMain = new THREE.Mesh(catchlightMainGeo, highlightMat);
    catchlightMain.position.set(-side * 0.040, 0.052, 0.112);
    eyePivot.add(catchlightMain);

    const catchlightSubGeo = new THREE.SphereGeometry(0.022, 14, 10);
    catchlightSubGeo.scale(1.0, 1.0, 0.32);
    const catchlightSub = new THREE.Mesh(catchlightSubGeo, skyHighlightMat);
    catchlightSub.position.set(side * 0.045, -0.050, 0.11);
    eyePivot.add(catchlightSub);

    faceGroup.add(eyePivot);
    eyes.push({
      pivot: eyePivot,
      basePos: eyePivot.position.clone(),
      catchlightMain,
      catchlightSub,
      irisAccent,
      side
    });
  }

  // Understated nose node in sleek slate-navy (#16233B)
  const noseMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#16233b')
  });
  const noseGeo = new THREE.SphereGeometry(0.034, 18, 14);
  noseGeo.scale(1.2, 0.72, 0.55);
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.position.set(0, 0.068, 1.042);
  faceGroup.add(nose);

  // Gentle, observant smile curve in sleek slate-navy (#16233B)
  const mouthMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#16233b')
  });
  const mouthArcGeo = new THREE.TorusGeometry(0.062, 0.0085, 10, 24, Math.PI * 0.58);
  mouthArcGeo.rotateZ(-Math.PI * 0.5 - (Math.PI * 0.58) * 0.5);
  const mouth = new THREE.Mesh(mouthArcGeo, mouthMat);
  mouth.position.set(0, 0.072, 1.042);
  mouth.rotation.x = -0.16;
  faceGroup.add(mouth);

  // Animation & Physics Tracking State
  const animState = {
    time: 0,
    baseScale: 1.0,
    baseX: 0.0,
    baseY: 0.0,
    baseZ: 0.0,
    blinkTimer: 0,
    nextBlink: 3.2,
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    targetLook: new THREE.Vector2(0, 0),
    currentLook: new THREE.Vector2(0, 0)
  };

  const _currentWorldPos = new THREE.Vector3();
  const _prevWorldPos = new THREE.Vector3();
  let prevRotY = 0.0;
  let prevRotX = 0.0;

  // Spatial anchor position & orientation for AR / framing
  const anchorPos = new THREE.Vector3(0, 0, 0);
  const targetAnchorPos = new THREE.Vector3(0, 0, 0);
  const startAnchorPos = new THREE.Vector3(0, 0, 0);
  let isPlaced = false;
  let isPlacing = false;
  let placeProgress = 1.0;
  let placeHopHeight = 0.0;
  let facingYaw = 0.0;
  let facingPitch = 0.0;
  let targetFacingYaw = 0.0;
  let targetFacingPitch = 0.0;
  let faceViewerHoldTimer = 0.0;

  function placeAt(targetWorldPos, normal, animate = true, cameraPos = null) {
    if (!targetWorldPos) return;
    isPlaced = true;
    const s = animState.baseScale;
    const targetCenterY = targetWorldPos.y + 0.94 * s;

    animState.targetLook.set(0, 0);
    animState.currentLook.set(0, 0);
    faceViewerHoldTimer = 1.4;

    if (cameraPos) {
      const dx = cameraPos.x - targetWorldPos.x;
      const dy = cameraPos.y - targetCenterY;
      const dz = cameraPos.z - targetWorldPos.z;
      const horizDist = Math.max(0.001, Math.hypot(dx, dz));
      targetFacingYaw = Math.atan2(dx, dz);
      targetFacingPitch = -Math.atan2(dy, horizDist) * 0.72;
      if (!animate) {
        facingYaw = targetFacingYaw;
        facingPitch = targetFacingPitch;
      }
    }

    if (animate) {
      startAnchorPos.copy(anchorPos);
      targetAnchorPos.set(targetWorldPos.x, targetCenterY, targetWorldPos.z);
      placeProgress = 0.0;
      isPlacing = true;
      placeHopHeight = Math.min(0.65, Math.max(0.18, startAnchorPos.distanceTo(targetAnchorPos) * 0.22));
    } else {
      anchorPos.set(targetWorldPos.x, targetCenterY, targetWorldPos.z);
      targetAnchorPos.copy(anchorPos);
      isPlacing = false;
      placeProgress = 1.0;
    }
  }

  function resetPlacement(animate = true) {
    isPlaced = false;
    targetFacingYaw = 0.0;
    targetFacingPitch = 0.0;
    faceViewerHoldTimer = 0.0;
    animState.targetLook.set(0, 0);
    animState.currentLook.set(0, 0);
    const s = animState.baseScale;
    const ox = animState.baseX || 0.0;
    const oz = animState.baseZ || 0.0;
    const targetY = -0.94 + 0.94 * s;
    if (animate) {
      startAnchorPos.copy(anchorPos);
      targetAnchorPos.set(ox, targetY, oz);
      placeProgress = 0.0;
      isPlacing = true;
      placeHopHeight = Math.min(0.55, Math.max(0.18, startAnchorPos.distanceTo(targetAnchorPos) * 0.22));
    } else {
      anchorPos.set(ox, targetY, oz);
      targetAnchorPos.set(ox, targetY, oz);
      startAnchorPos.set(ox, targetY, oz);
      facingYaw = 0.0;
      facingPitch = 0.0;
      isPlacing = false;
      placeProgress = 1.0;
    }
  }

  function setEnvironmentScale(scale, offsetX = 0.0, offsetZ = 0.0) {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1.0;
    const ox = Number.isFinite(offsetX) ? offsetX : 0.0;
    const oz = Number.isFinite(offsetZ) ? offsetZ : 0.0;
    animState.baseScale = s;
    animState.baseX = ox;
    animState.baseY = -0.94 * (1.0 - s);
    animState.baseZ = oz;
    if (!isPlaced) {
      anchorPos.set(ox, -0.94 + 0.94 * s, oz);
      targetAnchorPos.copy(anchorPos);
      startAnchorPos.copy(anchorPos);
      facingYaw = 0.0;
      facingPitch = 0.0;
      targetFacingYaw = 0.0;
      targetFacingPitch = 0.0;
    }
  }

  function triggerBoop() {
    if (stateController) {
      stateController.playAction('boop_reaction', { priority: 60, force: true });
    }
  }

  function update(dt, pointerNDC, cameraPos = null, isARMode = false, prefersReducedMotion = false) {
    const safeDt = Math.min(Math.max(dt, 0.001), 0.05);
    animState.time += safeDt;

    // Advance centralized state and motion composition
    if (stateController) {
      stateController.update(safeDt);
    }
    const motion = stateController ? stateController.currentMotion : null;

    if (faceViewerHoldTimer > 0) {
      faceViewerHoldTimer = Math.max(0, faceViewerHoldTimer - safeDt);
    }

    // 1. Pointer Look Tracking with state bias
    const biasX = motion ? motion.lookBiasX : 0.0;
    const biasY = motion ? motion.lookBiasY : 0.0;
    if (pointerNDC && faceViewerHoldTimer <= 0) {
      animState.targetLook.set(pointerNDC.x * 0.32 + biasX, pointerNDC.y * 0.22 + biasY);
    } else {
      animState.targetLook.set(biasX, biasY);
    }
    animState.currentLook.lerp(animState.targetLook, Math.min(1.0, safeDt * 7.5));

    // 2. Parabolic Placement Leap for AR
    let hop = 0.0;
    if (isPlacing) {
      placeProgress += safeDt * 3.4;
      if (placeProgress >= 1.0) {
        placeProgress = 1.0;
        isPlacing = false;
        anchorPos.copy(targetAnchorPos);
        triggerBoop();
      } else {
        const p = placeProgress;
        anchorPos.lerpVectors(startAnchorPos, targetAnchorPos, p);
        hop = Math.sin(p * Math.PI) * placeHopHeight;
      }
    }

    // 3. Placement Root: Only positions the world-space anchor & AR surface hop
    placementRoot.position.set(anchorPos.x, anchorPos.y + hop, anchorPos.z);

    // 4. Orientation Root: Smooth viewer-facing camera orientation
    if ((isPlaced || isARMode) && cameraPos) {
      const dx = cameraPos.x - anchorPos.x;
      const dy = cameraPos.y - anchorPos.y;
      const dz = cameraPos.z - anchorPos.z;
      const horizDist = Math.max(0.001, Math.hypot(dx, dz));
      targetFacingYaw = Math.atan2(dx, dz);
      targetFacingPitch = -Math.atan2(dy, horizDist) * 0.72;
    } else if (!isPlaced) {
      targetFacingYaw = 0.0;
      targetFacingPitch = 0.0;
    }

    const yawDiff = Math.atan2(Math.sin(targetFacingYaw - facingYaw), Math.cos(targetFacingYaw - facingYaw));
    facingYaw += yawDiff * Math.min(1.0, safeDt * 10.0);
    facingPitch += (targetFacingPitch - facingPitch) * Math.min(1.0, safeDt * 10.0);

    orientationRoot.rotation.y = facingYaw;
    orientationRoot.rotation.x = facingPitch;

    // 5. Motion Root: Composes all state animations, breathing, gestures, squashes & tilts
    const s = animState.baseScale;
    const motionDamp = prefersReducedMotion ? 0.35 : 1.0;

    const liftY = (motion ? motion.liftY : 0.0) * s * motionDamp;
    const offsetZ = (motion ? motion.offsetZ : 0.0) * s * motionDamp;
    motionRoot.position.set(0.0, liftY, offsetZ);

    const sq = motion ? motion.squash : 1.0;
    const invSq = 1.0 / Math.sqrt(Math.max(0.2, sq));
    motionRoot.scale.set(invSq * s, sq * s, invSq * s);

    const tiltPitch = (motion ? motion.tiltPitch : 0.0) * motionDamp;
    const tiltYaw = (motion ? motion.tiltYaw : 0.0) * motionDamp;
    const tiltRoll = (motion ? motion.tiltRoll : 0.0) * motionDamp;

    const bodyLookScale = (isPlaced || isARMode) ? (faceViewerHoldTimer > 0 ? 0.0 : 0.08) : 0.35;
    motionRoot.rotation.x = tiltPitch - animState.currentLook.y * 0.16 * bodyLookScale;
    motionRoot.rotation.y = tiltYaw + animState.currentLook.x * 0.24 * bodyLookScale;
    motionRoot.rotation.z = tiltRoll;

    // 6. Smooth Velocity Calculation for GPU Fur Physics (Low-pass filtered, Zero Jitter)
    motionRoot.getWorldPosition(_currentWorldPos);
    if (_prevWorldPos.lengthSq() > 0.0001) {
      const rawVx = (_currentWorldPos.x - _prevWorldPos.x) / (safeDt * s);
      const rawVy = (_currentWorldPos.y - _prevWorldPos.y) / (safeDt * s);
      const rawVz = (_currentWorldPos.z - _prevWorldPos.z) / (safeDt * s);

      // Low-pass exponential filter prevents single-frame spikes
      const velFilter = Math.min(1.0, safeDt * 14.0);
      animState.velocity.x += (rawVx - animState.velocity.x) * velFilter;
      animState.velocity.y += (rawVy - animState.velocity.y) * velFilter;
      animState.velocity.z += (rawVz - animState.velocity.z) * velFilter;
    }
    _prevWorldPos.copy(_currentWorldPos);

    const curRotY = orientationRoot.rotation.y + motionRoot.rotation.y;
    const curRotX = orientationRoot.rotation.x + motionRoot.rotation.x;
    animState.angularVelocity.set(
      (curRotX - prevRotX) / safeDt,
      (curRotY - prevRotY) / safeDt,
      0
    );
    prevRotX = curRotX;
    prevRotY = curRotY;

    // 7. Natural Blinking & Gaze tracking
    animState.blinkTimer += safeDt;
    let blinkScaleY = 1.0;
    if (animState.blinkTimer > animState.nextBlink) {
      const blinkProgress = (animState.blinkTimer - animState.nextBlink) / 0.14;
      if (blinkProgress < 1.0) {
        blinkScaleY = Math.max(0.06, Math.abs(Math.cos(blinkProgress * Math.PI)));
      } else {
        animState.blinkTimer = 0;
        animState.nextBlink = 3.2 + Math.random() * 3.8;
      }
    }

    const stateSquint = motion ? motion.eyeSquint : 1.0;
    const effectiveBlinkY = blinkScaleY * stateSquint;

    // Tint iris accent according to dynamic state colors
    if (stateController) {
      irisAccentMat.color.copy(stateController.currentColors.tipColor);
      irisAccentMat.opacity = 0.50 + stateController.currentColors.specular * 0.40;
    }

    for (const eye of eyes) {
      eye.pivot.scale.y = effectiveBlinkY;
      eye.catchlightMain.position.x = -eye.side * 0.040 + animState.currentLook.x * 0.022;
      eye.catchlightMain.position.y = 0.052 + animState.currentLook.y * 0.020;
    }
  }

  return {
    root: placementRoot,
    placementRoot,
    orientationRoot,
    motionRoot,
    bodyMesh,
    bodyGeometry,
    skinMaterial,
    animState,
    eyes,
    nose,
    mouth,
    setEnvironmentScale,
    triggerBoop,
    placeAt,
    resetPlacement,
    isPlaced: () => isPlaced,
    getAnchorPosition: () => anchorPos,
    update
  };
}
