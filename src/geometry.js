/**
  geometry.js — the primitives the art direction needs, generated in code.
*/

import * as THREE from 'three';

// -----------
// Rounded box
// -----------

/**
  A box with every edge and corner filleted to `radius`.
 
  @param {number} width
  @param {number} height
  @param {number} depth
  @param {number} radius   fillet radius, clamped to half the smallest side
  @param {number} segments quads across each quarter turn of a fillet
  @param {number} uvScale  world units per texture tile
  @returns {THREE.BufferGeometry}
*/
export function roundedBoxGeometry(
  width,
  height,
  depth,
  radius = 0.03,
  segments = 3,
  uvScale = 1
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2, depth / 2));

  const half = [width / 2, height / 2, depth / 2];
  const inner = [half[0] - r, half[1] - r, half[2] - r];
  const EPS = 1e-9;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  function vertex(px, py, pz, nx, ny, nz) {
    const index = positions.length / 3;
    positions.push(px, py, pz);
    normals.push(nx, ny, nz);

    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    let u;
    let v;
    if (ax >= ay && ax >= az) { u = pz; v = py; }
    else if (ay >= az) { u = px; v = pz; }
    else { u = px; v = py; }

    uvs.push(u / uvScale, v / uvScale);
    return index;
  }

  /** Two triangles, wound counter-clockwise seen from outside. */
  function quad(a, b, c, d) {
    indices.push(a, b, c, a, c, d);
  }

  // 6 flat faces

  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;

    // A face with no extent left in either in-plane direction is a line, not a
    // quad — the rounded band takes over its job.
    if (inner[i] <= EPS || inner[j] <= EPS) continue;

    for (const s of [1, -1]) {
      const [t1, t2] = s > 0 ? [i, j] : [j, i];

      const normal = [0, 0, 0];
      normal[k] = s;

      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([c1, c2]) => {
        const p = [0, 0, 0];
        p[k] = s * half[k];
        p[t1] = c1 * inner[t1];
        p[t2] = c2 * inner[t2];
        return vertex(p[0], p[1], p[2], normal[0], normal[1], normal[2]);
      });

      quad(corners[0], corners[1], corners[2], corners[3]);
    }
  }

  // 12 edge fillets: quarter cylinders

  for (let k = 0; k < 3; k++) {
    const u = (k + 1) % 3;
    const v = (k + 2) % 3;

    // No radius means no fillet; no length along the edge means no cylinder.
    // Note it is only the *length* that matters here — a fillet whose two
    // cross-axes have collapsed is still a perfectly good quarter round.
    if (r <= EPS || inner[k] <= EPS) continue;

    for (const su of [1, -1]) {
      for (const sv of [1, -1]) {
        const direction = su * sv > 0 ? 1 : -1;
        const rings = [];

        for (let end = 0; end < 2; end++) {
          const along = (end === 0 ? -1 : 1) * direction * inner[k];
          const ring = [];

          for (let i = 0; i <= segments; i++) {
            const phi = (i / segments) * (Math.PI / 2);

            const n = [0, 0, 0];
            n[u] = su * Math.cos(phi);
            n[v] = sv * Math.sin(phi);

            const p = [0, 0, 0];
            p[k] = along;
            p[u] = su * inner[u] + r * n[u];
            p[v] = sv * inner[v] + r * n[v];

            ring.push(vertex(p[0], p[1], p[2], n[0], n[1], n[2]));
          }

          rings.push(ring);
        }

        for (let i = 0; i < segments; i++) {
          quad(rings[0][i], rings[0][i + 1], rings[1][i + 1], rings[1][i]);
        }
      }
    }
  }

  // 8 corner fillets: spherical octants

  for (const sx of [1, -1]) {
    if (r <= EPS) break;

    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        const reversed = sx * sy * sz > 0;
        const grid = [];

        for (let i = 0; i <= segments; i++) {
          const theta = (i / segments) * (Math.PI / 2);
          const row = [];

          for (let j = 0; j <= segments; j++) {
            const psi = ((reversed ? segments - j : j) / segments) * (Math.PI / 2);

            const nx = sx * Math.sin(theta) * Math.cos(psi);
            const ny = sy * Math.cos(theta);
            const nz = sz * Math.sin(theta) * Math.sin(psi);

            row.push(vertex(
              sx * inner[0] + r * nx,
              sy * inner[1] + r * ny,
              sz * inner[2] + r * nz,
              nx, ny, nz
            ));
          }

          grid.push(row);
        }

        for (let i = 0; i < segments; i++) {
          for (let j = 0; j < segments; j++) {
            const a = grid[i][j];
            const b = grid[i + 1][j];
            const c = grid[i + 1][j + 1];
            const d = grid[i][j + 1];

            // The whole first row collapses onto the pole, so the outer
            // triangle of each quad there would be degenerate.
            if (i === 0) indices.push(a, b, c);
            else quad(a, b, c, d);
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// ----------------
// Rounded cylinder
// ----------------

/**
  A cylinder whose top rim is filleted — the knob and pedestal shape.
 
  @param {number} radius
  @param {number} height
  @param {number} corner  fillet radius of the top rim
*/
export function roundedCylinderGeometry(
  radius,
  height,
  corner = 0.01,
  radialSegments = 40,
  cornerSegments = 5
) {
  const cr = Math.max(0, Math.min(corner, radius, height));

  const profile = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(radius, 0),
  ];

  for (let i = 0; i <= cornerSegments; i++) {
    const t = (i / cornerSegments) * (Math.PI / 2);
    profile.push(new THREE.Vector2(
      radius - cr + cr * Math.cos(t),
      height - cr + cr * Math.sin(t)
    ));
  }

  profile.push(new THREE.Vector2(0, height));

  return new THREE.LatheGeometry(profile, radialSegments);
}
