/**
 * environment.js — the room the instrument stands in.
 *
 * Everything in this file was previously inlined in main.js: the backdrop
 * gradient, the image-based lighting, the fog and a flat circle standing in
 * for a floor. main.js is supposed to be wiring and a render loop, and roughly
 * forty lines of it had quietly become set dressing. This module takes them.
 *
 * It imports textures.js and palette.js — leaf modules — and nothing else. It
 * does not know the rig exists.
 *
 *
 * WHY A CYCLORAMA AND NOT WALLS
 *
 * The phase 6 plan asked for "a booth: floor, two or three walls". Three flat
 * walls have four problems in this scene, and they compound:
 *
 *   - They have corners, and a corner is a hard line that competes with the
 *     instrument for attention in a frame this simple.
 *   - They have edges, and the camera orbits freely, so any edge will be swung
 *     past and seen to end in mid-air.
 *   - A back wall only exists behind. Orbit ninety degrees and the scene is
 *     open again.
 *   - They contradict the fog: main.js set the fog to the backdrop colour
 *     specifically so the ground would dissolve rather than stop at a visible
 *     rim. A wall reintroduces the rim.
 *
 * A cyclorama solves all four with one surface. It is what a real photographic
 * studio uses and it is the physical thing the phrase "infinite sweep" refers
 * to: the wall curves into the floor on a fillet large enough that no shadow
 * line forms in the join, so the two surfaces read as one continuous ground
 * with no horizon. Built as a full ring rather than a back wall, it also
 * survives being orbited, which is the requirement a three-sided booth cannot
 * meet.
 *
 * The wall takes the backdrop's own colour, deliberately. The gradient behind
 * it is the same scene continuing upward, so where the cyc ends the sky picks
 * up rather than cutting.
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
//
// One place, as everywhere else. The relationships that matter:
//
//   floorR  <  cycStart      the floor's edge is hidden under the cyc's lip
//   cycWall  >  camera max   the camera must never get outside the room
//
// The second is a real constraint on main.js and not a suggestion: put
// controls.maxDistance above cycWall and orbiting far enough out puts the
// camera behind the wall, which — because the cyc is drawn from the inside —
// means it vanishes and the scene turns into a floating slab over nothing.
// ---------------------------------------------------------------------------

export const ROOM = {
  floorR: 2.40,     // flat disc, planar UVs
  cycLip: 2.30,     // where the cyc's flat lip begins, under the floor edge
  cycStart: 2.50,   // where the fillet leaves the ground
  cycWall: 3.30,    // radius of the vertical wall
  fillet: 0.80,     // radius of the curve joining floor to wall
  cycTop: 2.40,     // height the wall stops at
  lipDrop: 0.003,   // how far the lip sits below the floor, to avoid z-fighting
};

/** The furthest the camera may orbit and stay inside the room. */
export const MAX_ORBIT = ROOM.cycWall - 0.55;

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
  // A gradient rather than a flat colour. A flat background gives the
  // silhouette exactly one contrast value to sit against, so whichever value
  // is chosen, part of the object disappears into it. A vertical ramp
  // guarantees the top of the slab reads against a darker band and its shadow
  // side against a lighter one.
  //
  // With the cyc in place this is only visible above the wall, but it is still
  // what the wall's colour is chosen to continue.
  // -----------------------------------------------------------------------

  scene.background = verticalGradientTexture(PALETTE.skyTop, PALETTE.skyBottom);

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
  scene.fog = new THREE.Fog(PALETTE.skyBottom, 2.6, 7.0);

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
  const concrete = configureMaps(concreteMaps(512), 10, 10, anisotropy);

  const floorMaterial = new THREE.MeshStandardMaterial({
    ...concrete,
    color: PALETTE.ground,

    /**
     * Still a dielectric. A polished black stage floor is lacquer over a dark
     * substrate, not metal, and the difference is not pedantry: a metal
     * reflects its own colour and has no diffuse response at all, so
     * `metalness: 1` on a near-black albedo renders a black mirror that shows
     * only the environment. A dielectric keeps a diffuse term for the light
     * pools to land in AND gains a Fresnel-weighted specular that strengthens
     * at grazing angles — which is exactly the effect wanted, because the
     * camera never looks straight down at this floor.
     */
    metalness: 0.0,

    /**
     * `roughness` MULTIPLIES `roughnessMap`, it does not replace it — and here
     * that is used deliberately rather than avoided. The map was authored over
     * 0.34–0.68, the semi-gloss band of sealed concrete. A factor of 0.42
     * carries the whole band down to 0.14–0.29 without flattening it, so the
     * floor becomes lacquered while keeping the mottle that breaks the
     * specular streak into something that reads as a real surface. Replacing
     * the band with a single number would give a clean airbrushed streak, and
     * a clean streak is the giveaway of a floor that is a shader rather than a
     * floor.
     *
     * This is the surface the phase leans on hardest. Every fixture in the
     * room now leaves a long raking highlight across it, and that highlight is
     * most of what makes the lighting read as stage lighting.
     */
    roughness: 0.42,

    // Halved with the roughness. A polished surface shows less of its own
    // relief, not more — the specular lobe that would reveal the normal detail
    // is now tight enough to reflect the room instead of the bumps.
    normalScale: new THREE.Vector2(0.3, 0.3),
  });

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ROOM.floorR, 96),
    floorMaterial
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);

  // -----------------------------------------------------------------------
  // Cyclorama
  // -----------------------------------------------------------------------

  /**
   * The profile, in (radius, height), lathed around Y.
   *
   *   flat lip      cycLip -> cycStart, at -lipDrop
   *   fillet        a quarter arc of radius `fillet`, centred at (cycWall, 0)
   *   wall          straight up to cycTop
   *
   * The arc is generated rather than approximated by hand, because the two
   * tangency conditions are the entire point of a cyc: it has to leave the
   * floor horizontally and meet the wall vertically, or a shadow line forms in
   * the join and the illusion of a continuous ground is gone. A quarter circle
   * centred at (cycWall, 0) satisfies both exactly — at 180 degrees it is
   * horizontal at radius cycStart, at 90 degrees it is vertical at cycWall —
   * which is why the fillet radius and the difference between the two radii
   * are the same number and not two numbers that happen to be close.
   */
  const profile = [
    new THREE.Vector2(ROOM.cycLip, -ROOM.lipDrop),
    new THREE.Vector2(ROOM.cycStart, -ROOM.lipDrop),
  ];

  const ARC_SEGMENTS = 20;
  for (let i = 1; i <= ARC_SEGMENTS; i++) {
    const t = Math.PI - (i / ARC_SEGMENTS) * (Math.PI / 2);
    profile.push(new THREE.Vector2(
      ROOM.cycWall + ROOM.fillet * Math.cos(t),
      ROOM.fillet * Math.sin(t)
    ));
  }

  profile.push(new THREE.Vector2(ROOM.cycWall, ROOM.cycTop));

  /**
   * 21 repeats around and 3 up puts the paint mottle at roughly one tile per
   * world unit on the wall, matching the floor's density closely enough that
   * the two do not read as different scales of the same room.
   *
   * The horizontal density is not actually uniform: LatheGeometry's u runs
   * 0..1 around the axis regardless of radius, so the same texture width
   * covers 14.5 units of circumference at the lip and 20.7 at the top — a 43%
   * stretch through the fillet. On a wall whose entire specification is "no
   * readable detail" this is invisible. On the floor it would not be, which is
   * the other reason the floor is a separate disc with planar UVs rather than
   * part of this lathe: a lathed floor also collapses every u to a single
   * point at the centre, precisely where the instrument sits.
   */
  const paint = configureMaps(paintedWallMaps(256), 21, 3, anisotropy);

  const cycMaterial = new THREE.MeshStandardMaterial({
    ...paint,
    // The wall is the backdrop made physical, so it takes the backdrop's own
    // lower colour. Where the cyc stops, the gradient continues from the same
    // value and the join is not a join.
    color: PALETTE.skyBottom,
    metalness: 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(0.4, 0.4),
    /**
     * Seen from the inside.
     *
     * LatheGeometry winds its faces outward, so from within the ring every
     * triangle is back-facing and would be culled — the room would simply not
     * be there. BackSide flips which face is kept, and the renderer negates
     * the normal for back-facing fragments, so the lighting comes out correct
     * without touching the geometry.
     *
     * The alternative is reversing the profile point order, which flips the
     * winding at the source. Both work. This one is chosen because it keeps
     * the profile in the order it is easiest to read — bottom to top, which is
     * the order it was derived in.
     */
    side: THREE.BackSide,
  });

  const cyc = new THREE.Mesh(new THREE.LatheGeometry(profile, 96), cycMaterial);
  cyc.receiveShadow = true;
  /**
   * It does not cast. Nothing is outside it to cast onto, and the key light's
   * shadow camera is a +/-1.2 frustum around the instrument — a 3.3-unit ring
   * would be entirely outside it, so the only possible outcome is a clipped
   * edge somewhere across the floor.
   */
  cyc.castShadow = false;
  cyc.name = 'cyclorama';
  scene.add(cyc);

  // -----------------------------------------------------------------------

  function dispose() {
    for (const material of [floorMaterial, cycMaterial]) {
      for (const value of Object.values(material)) {
        if (value && value.isTexture) value.dispose();
      }
      material.dispose();
    }
    floor.geometry.dispose();
    cyc.geometry.dispose();
    scene.remove(floor, cyc);
  }

  return { floor, cyc, dispose, ROOM, MAX_ORBIT };
}