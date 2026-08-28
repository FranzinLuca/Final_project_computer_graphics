/**
 * environment.js — the ground the instrument stands on. There is no room.
 *
 * PHASE 16: THE ROOM WAS DELETED
 *
 * This file has now built three environments and thrown two away, and the
 * sequence is the argument rather than an embarrassment.
 *
 *   OPEN GROUND     a flat disc dissolving into fog. Rejected because the
 *                   edge was visible when the camera pulled back.
 *   CYCLORAMA       a lathed sweep and wall, then a closed dome. Rejected
 *                   because it is a ROOM, and a room is a box the subject sits
 *                   inside — which is exactly the reading a cartoon still must
 *                   not have.
 *   OPEN GROUND     again, and this time correctly, because the reason it
 *                   failed the first time was a bug in the fog and not a fault
 *                   in the idea.
 *
 * The first attempt put the fog range at 5–12 on a disc of radius 2.4. The
 * disc therefore ended two and a half units before the fog had finished with
 * it, so the edge arrived at full contrast and read as the rim of a plate.
 * Fog does not hide an edge; fog hides an edge that is FURTHER AWAY THAN THE
 * FOG. The floor is now radius 14 against a fog that saturates at 9.5, so the
 * ground reaches the backdrop colour four and a half units before it runs out
 * and there is no edge to see from anywhere the camera can go.
 *
 * That single relationship — `floorR > fogFar` — is the whole of what makes an
 * infinite ground work, and it is checked below rather than assumed.
 *
 * WHAT THIS BUYS BACK. Deleting the dome removed roughly ninety per cent of
 * the environment's geometry, its lathe, its vertex-colour pass and its two
 * tangency derivations, and it removed the constraint that the camera stay
 * inside a shell. The ground plus fog is four meshes' worth of idea in one,
 * and it is the correct one for a subject that is supposed to read as floating
 * in a bright nowhere.
 */

import * as THREE from 'three';
import { PALETTE } from './palette.js';
import {
  concreteMaps,
  paintedWallMaps,
  configureMaps,
  verticalGradientTexture,
  studioEnvironmentTexture,
  radialFalloffTexture,
} from './textures.js';

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * One disc, and the distances the fog is tuned against.
 *
 * `floorR` is generous — 7 units against a 1.5-unit instrument — because the
 * floor now has to reach past the point where the fog has finished hiding it.
 * If the disc ended inside the fog's range its rim would be faintly visible as
 * a slightly-different-coloured arc, which is the exact artefact the cyclorama
 * was built to avoid and which this approach avoids for free ONLY if the
 * geometry outlives the visibility.
 */
export const ROOM = {
  /**
   * The disc, and the constraint that makes the whole approach work:
   *
   *     floorR  >  fogFar  +  MAX_ORBIT
   *
   * The camera may sit anywhere inside a sphere of MAX_ORBIT, so the nearest
   * the floor's rim can ever be is `floorR - MAX_ORBIT`. For the rim to be
   * invisible from every legal position, that distance has to exceed the range
   * at which fog has fully taken over — and it now does, with 1.5 units of
   * margin, where the previous numbers missed it by one and were excused on
   * the grounds that the camera only looks inward. That excuse was worth
   * retiring: a viewer who orbits wide and pans is not doing anything the
   * controls forbid, and an argument that depends on where someone chooses to
   * look is not a constraint.
   */
  /**
   * Retuned as one set, because the three numbers are one decision.
   *
   * The old 12 / 3.2 / 8.0 was inherited from a room with walls, and it broke
   * the wide shots the moment the walls came out. Fog started at 3.2 units,
   * which is INSIDE the scene: the Stage and Beams shots put the camera 3.6
   * from the centre, so the far speaker stack sat at 4.5 and was already a
   * quarter washed towards the background before the viewer had seen it. The
   * subject was being fogged by a term that exists solely to hide the edge of
   * the floor.
   *
   * The constraint is still `floorR > fogFar + MAX_ORBIT`, and it is now
   * satisfied with room to spare rather than missed by a unit: 16 > 9.5 + 5.
   * The rim is therefore fully dissolved from every legal camera position and
   * in every direction, not only when looking inward — which is what lets the
   * fog start far enough out to leave the whole set unfogged.
   *
   * A bigger disc costs one geometry and no fill: the far half of it is
   * hidden behind the fog it was enlarged to reach, which is the entire point.
   * Tile density is derived from the radius below, so the concrete does not
   * stretch when the floor grows.
   */
  floorR: 16.00,
  fogNear: 4.50,
  fogFar: 9.50,

  /**
   * The usable stage: how far from the centre anything may stand.
   *
   * Nothing enforces this geometrically any more — with the walls gone an
   * object at radius 9 would simply be standing in the fog rather than inside
   * the scenery. It is kept because intro.js clamps the mascot's entry against
   * it, and because "the set is three units across" is a composition decision
   * that should live with the set rather than in the file that animates it.
   */
  stageR: 3.00,
};

/**
 * The furthest the camera may orbit.
 *
 * No longer a wall clearance — there is no wall. It is now simply how far back
 * a viewer may usefully get before the instrument is a dot, and it is checked
 * against the floor rather than against a room: past about 5 units the camera
 * is looking at fog with a small object in it.
 */
export const MAX_ORBIT = 5.00;

// ---------------------------------------------------------------------------
// Contact shadows
// ---------------------------------------------------------------------------

/** One falloff texture shared by every patch. Built on first use. */
let falloff = null;

/**
 * A soft dark patch laid on the floor under an object.
 *
 * The key light casts a real shadow map, and it is doing its job — but a
 * shadow map cannot produce a contact shadow, and the two are different
 * phenomena. A shadow map answers "is this point occluded from the light",
 * which for a directional light at 55 degrees puts the slab's shadow off to
 * one side. Contact darkening is ambient occlusion: the ground immediately
 * under an object is occluded from MOST OF THE SKY, no matter where the key
 * happens to be, and that is the cue the eye actually uses to decide whether
 * something rests on a surface or hovers above it. An object with a perfect
 * cast shadow and no contact darkening still reads as floating.
 *
 * Three has no cheap way to compute this — screen-space AO needs a depth
 * prepass and a post chain, and there is no post chain in this project. So it
 * is authored: a disc with a radial alpha ramp, black, laid a millimetre above
 * the floor. It costs one transparent draw per object and it is placed by
 * hand, which is honest and is recorded as such in the limitations.
 *
 * `depthWrite: false` because a transparent patch that writes depth will
 * occlude anything drawn after it at the same depth, and `polygonOffset`
 * rather than a larger Y lift because lifting the patch far enough to clear
 * z-fighting on its own would separate it visibly from the floor at grazing
 * camera angles — which is the one angle this scene is always seen from.
 *
 * @param {number} radius world units
 * @param {number} opacity how dark at the centre
 */
export function makeContactShadow(radius, opacity = 0.55) {
  if (!falloff) falloff = radialFalloffTexture(128, 3.5);

  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    alphaMap: falloff,
    transparent: true,
    opacity,
    depthWrite: false,
    // Not lit, not fogged, and not tone mapped: this is a compositing element
    // standing in for an integral, not a surface. Letting the fog tint it
    // would wash the far edge of the patch towards the backdrop colour and
    // make the object float again at exactly the distance the fog starts.
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

// ---------------------------------------------------------------------------

/**
 * @param {{ scene: THREE.Scene, renderer: THREE.WebGLRenderer }} deps
 */
export function buildEnvironment({ scene, renderer }) {
  const anisotropy = renderer.capabilities.getMaxAnisotropy();

  // -----------------------------------------------------------------------
  // Backdrop
  //
  // Flat, where it used to be a vertical ramp. The gradient existed so the
  // silhouette had two values to sit against — with a single background value,
  // whichever one is chosen, some part of a monochrome object disappears into
  // it. That argument dies the moment the objects carry saturated colour of
  // their own: they now separate from the ground by HUE, and hue separation
  // does not care what the background's value is.
  //
  // -----------------------------------------------------------------------

  /**
   * A flat colour, not a gradient, and identical to the fog.
   *
   * The two being EQUAL is the whole trick and the only thing this file
   * depends on. Fog blends a surface towards its own colour with distance, so
   * a floor fogged to exactly the background value becomes indistinguishable
   * from the background before it runs out — no horizon, no rim, no edge to
   * find by orbiting. Set them a few percent apart and a faint arc appears
   * exactly where the disc ends, which is the artefact this replaces a whole
   * dome to avoid.
   *
   * `THREE.Color` rather than a texture: there is nothing left to vary across
   * it, and a one-colour texture is a texture upload and a sampler for a value
   * the renderer can clear to for free.
   */
  scene.background = new THREE.Color(PALETTE.skyTop);

  // -----------------------------------------------------------------------
  // Image-based lighting
  //
  // PMREMGenerator turns one equirectangular image into the mip chain that
  // image-based lighting needs: each level is the original convolved with a
  // wider cosine lobe, so a roughness of 0.1 samples a sharp level and a
  // roughness of 0.9 samples a blurred one. Without that prefilter, roughness
  // would have nothing to select between and every roughness map in the
  // project would be doing nothing — including the floor's, which is the one
  // this phase leans on hardest.
  //
  // Both the source texture and the generator are disposed immediately: the
  // result lives on the GPU and neither is needed again.
  // -----------------------------------------------------------------------

  const pmrem = new THREE.PMREMGenerator(renderer);
  const equirect = studioEnvironmentTexture();
  scene.environment = pmrem.fromEquirectangular(equirect).texture;

  /**
   * 0.11, down from 0.50, and the map itself is unchanged.
   *
   * Two jobs were being done by one number and they wanted opposite things.
   * The environment is both an ambient diffuse term — the thing that was
   * flooding the scene and flattening it — and the only thing a metallic
   * surface can reflect, without which the hinge barrels and the yokes render
   * black. Dimming the INTENSITY rather than dulling the MAP keeps the softbox
   * layout intact in the reflection, so metal still catches a bright shape and
   * a legible horizon while contributing almost nothing to the ambient floor.
   *
   * That is also why the map is still drawn bright. A dark environment texture
   * at intensity 0.5 would have given the same average and a dead reflection:
   * the two are not interchangeable, because reflection cares about the
   * distribution and diffuse only cares about the mean.
   */
  /**
   * 0.55, up from the dark stage's 0.11.
   *
   * The environment is doing a different job in each direction. On a dark
   * stage it was dimmed almost to nothing because it was flooding the scene
   * and flattening it, and kept only so metal had something to reflect. Here
   * ambient fill IS the look: a pastel scene wants light arriving from
   * everywhere so that no surface has a dark side, and the image-based term is
   * the cheapest and softest way to get that — it costs one prefiltered
   * texture lookup and casts nothing.
   */
  /**
   * 0.11 again, with the map left bright.
   *
   * Two jobs are done by one number and they want opposite things. The
   * environment is both an ambient diffuse term — the thing that floods a
   * scene and flattens it — and the only thing a metallic surface can reflect,
   * without which the hinge barrels and the bezel render black. Dimming the
   * INTENSITY rather than dulling the MAP keeps the softbox layout intact in
   * the reflection while contributing almost nothing to the ambient floor.
   *
   * A dark environment texture at 0.55 would give the same average and a dead
   * reflection: the two are not interchangeable, because reflection cares
   * about the distribution and diffuse only about the mean.
   */
  scene.environmentIntensity = 0.11;
  equirect.dispose();
  pmrem.dispose();

  /**
   * Fog, retuned for a room that now has an end.
   *
   * It used to run 5 to 12 and existed to dissolve the edge of an infinite
   * ground plane. The cyc hides that edge, so the old range does nothing — the
   * furthest surface in the scene is now about 4.5 units away and never
   * reaches `near`.
   *
   * Pulled in to 2.6–7.0, it becomes aerial perspective instead: the far side
   * of the cyc washes slightly towards the backdrop colour while the near side
   * stays saturated, and a cylinder that would otherwise be uniformly lit
   * acquires depth. The instrument sits inside 1.5 units of the target, so
   * nothing on it is ever fogged.
   */
  /**
   * Retuned again for the closed room, which is now nearly twice the size.
   *
   * The far side of a 4.2-unit dome is up to nine units from the camera, so
   * the old 2.6–7.0 range saturated everything past the middle of the floor
   * and flattened exactly the depth the enclosure was built to create. Pushed
   * out to 4.0–13.0 it goes back to being aerial perspective: the near wall
   * stays saturated, the far one washes slightly towards the backdrop value,
   * and a dome that would otherwise be uniformly lit acquires distance.
   *
   * The instrument sits inside 1.5 units of the target, so nothing on it is
   * ever fogged.
   */
  scene.fog = new THREE.Fog(PALETTE.skyTop, ROOM.fogNear, ROOM.fogFar);

  // -----------------------------------------------------------------------
  // Floor — polished concrete
  // -----------------------------------------------------------------------

  /**
   * Ten repeats across a 4.8-unit disc puts a tile every 480 mm, which is
   * roughly the scale of the aggregate variation the map was generated at.
   *
   * Ten repeats is also visible repetition, and it is worth being honest that
   * it is: at this density the same blotch appears a hundred times on the
   * floor. Three things keep it from reading — the map's contrast is low, the
   * light pools vary far more strongly than the texture does, and the camera
   * never looks straight down. A tiling artefact you can find if you look for
   * it is the correct trade against a 4096-pixel unique floor texture.
   *
   * Anisotropy matters more here than anywhere else in the project. A floor is
   * seen almost edge-on, so its texels are compressed into a fraction of their
   * height on screen; without anisotropic filtering the hardware picks a mip
   * level for the worst axis and the distance blurs to mush.
   */
  /**
   * Repeats scale with the disc so the texel density does not change when the
   * floor is resized. Ten repeats across the old 4.8-unit disc put a tile
   * every 480 mm; the disc is now 14 units across, so the count goes up with
   * it rather than the tiles being stretched to three times their size.
   */
  const floorTiles = Math.round(ROOM.floorR * 2 / 0.48);
  const concrete = configureMaps(concreteMaps(512), floorTiles, floorTiles, anisotropy);

  const floorMaterial = new THREE.MeshStandardMaterial({
    ...concrete,
    color: PALETTE.ground,
    metalness: 0.0,

    /**
     * MATTE, reversing the semi-gloss stage floor exactly.
     *
     * `roughness` multiplies `roughnessMap` rather than replacing it, and that
     * is used here in the opposite direction from last time: the map was
     * authored over 0.34–0.68, a factor of 0.42 took it to a lacquered
     * 0.14–0.29 for the dark stage, and 1.0 now lets the whole authored band
     * through.
     *
     * A gloss floor was doing a specific job — every fixture left a long
     * raking highlight across it, and those highlights were most of what made
     * the lighting read as stage lighting. On a pale ground there is nothing
     * to reflect: the environment is near-white, so the reflection is
     * near-white, so a polished floor is just a slightly brighter pale floor
     * with the mottle washed out of it. The specular buys nothing and costs
     * the only surface detail the ground has.
     */
    /**
     * Semi-gloss again, and this is the change that most repays the room going
     * dark. `roughness` MULTIPLIES `roughnessMap`: the map was authored over
     * 0.34–0.68, and 0.42 carries the whole band down to 0.14–0.29 without
     * flattening it, so the floor becomes lacquered while keeping the mottle
     * that breaks the specular into something that reads as a real surface.
     *
     * On a pale ground this bought nothing — the environment was near-white,
     * so the reflection was near-white, so a polished floor was a slightly
     * brighter pale floor. On a dark one every fixture leaves a long raking
     * highlight across it, and those highlights are most of what makes the
     * lighting read as stage lighting.
     */
    roughness: 0.42,

    /**
     * Almost no relief. The concrete normal map is still bound — it is one of
     * the map kinds the project has to demonstrate — but at 0.15 it does
     * little more than break the flatness under grazing light.
     *
     * That is deliberate rather than a compromise. Cartoon surfacing is about
     * flat fields of colour separated by value, and a floor with visible
     * bumps competes with the objects for the eye's attention. Keeping the map
     * bound at low strength is the honest version: the texture is present and
     * doing a small amount of work, rather than being removed and claimed.
     */
    // Halved with the roughness. A polished surface shows less of its own
    // relief, not more — the specular lobe that would reveal the normal detail
    // is now tight enough to reflect the room instead of the bumps.
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