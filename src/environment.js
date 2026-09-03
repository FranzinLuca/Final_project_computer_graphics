/**
  environment.js — the ground the instrument stands on
*/

import * as THREE from 'three';
import { PALETTE } from './palette.js';
import {
  concreteMaps,
  configureMaps,
  studioEnvironmentTexture,
  radialFalloffTexture,
} from './textures.js';

// ----------
// Dimensions
// ----------

/**
  One disc, and the distances the fog is tuned against.
*/
export const ROOM = {
  floorR: 16.00,
  fogNear: 4.50,
  fogFar: 9.50,
  stageR: 3.00,
};
// the further the camera can orbit
export const MAX_ORBIT = 5.00;

// ---------------
// Contact shadows
// ---------------

/** One falloff texture shared by every patch. Built on first use. */
let falloff = null;

/**
  A soft dark patch laid on the floor under an object.
  @param {number} radius world units
  @param {number} opacity how dark at the centre
*/
export function makeContactShadow(radius, opacity = 0.55) {
  if (!falloff) falloff = radialFalloffTexture(128, 3.5);

  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    alphaMap: falloff,
    transparent: true,
    opacity,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.001;
  mesh.renderOrder = 1;
  mesh.name = 'contact-shadow';
  return mesh;
}

/**
  @param {{ scene: THREE.Scene, renderer: THREE.WebGLRenderer }} deps
*/
export function buildEnvironment({ scene, renderer }) {
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  scene.background = new THREE.Color(PALETTE.skyTop);

  // --------------------
  // Image-based lighting
  // --------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const equirect = studioEnvironmentTexture();
  scene.environment = pmrem.fromEquirectangular(equirect).texture;
  scene.environmentIntensity = 0.11;
  equirect.dispose();
  pmrem.dispose();
  scene.fog = new THREE.Fog(PALETTE.skyTop, ROOM.fogNear, ROOM.fogFar);

  // -------------------------
  // Floor — polished concrete
  // -------------------------

  const floorTiles = Math.round(ROOM.floorR * 2 / 0.48);
  const concrete = configureMaps(concreteMaps(512), floorTiles, floorTiles, anisotropy);

  const floorMaterial = new THREE.MeshStandardMaterial({
    ...concrete,
    color: PALETTE.ground,
    metalness: 0.0,
    roughness: 0.42,
    normalScale: new THREE.Vector2(0.30, 0.30),
  });

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ROOM.floorR, 128),
    floorMaterial
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);

  function dispose() {
    for (const value of Object.values(floorMaterial)) {
      if (value && value.isTexture) value.dispose();
    }
    floorMaterial.dispose();
    floor.geometry.dispose();
    scene.remove(floor);
  }

  return { floor, dispose, ROOM, MAX_ORBIT };
}