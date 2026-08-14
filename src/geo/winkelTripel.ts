/**
 * Winkel Tripel and Natural Earth projections as proj4js projection modules.
 *
 * proj4js ships Robinson, Lambert Conformal Conic, Albers, Orthographic, Mollweide
 * and friends, but not these two — and both are staples of historical atlas layouts,
 * so they are implemented here against proj4js's documented extension contract:
 *
 *   forward(p): p.x/p.y arrive in RADIANS relative to the geodetic origin.
 *               Return projected units, scaled by `this.a` and offset by x0/y0.
 *   inverse(p): the exact reverse.
 *
 * Neither projection has a closed-form inverse; both are inverted numerically.
 * `src/geo/winkelTripel.test.ts` round-trips a grid of control points to prove it.
 */

interface Pt {
  x: number;
  y: number;
}

interface ProjCtx {
  a: number;
  x0: number;
  y0: number;
  long0: number;
  lat1?: number;
}

const HALF_PI = Math.PI / 2;

/** sin(x)/x with the removable singularity at 0 filled in. */
function sinc(x: number): number {
  if (Math.abs(x) < 1e-12) return 1;
  return Math.sin(x) / x;
}

// ---------------------------------------------------------------------------
// Winkel Tripel — the arithmetic mean of the Aitoff and equirectangular
// projections. `lat1` is the equirectangular standard parallel; Winkel's own
// choice was acos(2/pi) ≈ 50°28', which is the default here.
// ---------------------------------------------------------------------------

const WINKEL_STD_PARALLEL = Math.acos(2 / Math.PI);

function winkelForwardRaw(lam: number, phi: number, cosLat1: number): Pt {
  // D is the angular distance from the projection centre used by the Aitoff half.
  const d = Math.acos(Math.max(-1, Math.min(1, Math.cos(phi) * Math.cos(lam / 2))));
  const c = 1 / sinc(d);
  const xAitoff = 2 * Math.cos(phi) * Math.sin(lam / 2) * c;
  const yAitoff = Math.sin(phi) * c;
  return {
    x: 0.5 * (lam * cosLat1 + xAitoff),
    y: 0.5 * (phi + yAitoff),
  };
}

export const winkelTripel = {
  init(this: ProjCtx) {
    this.x0 = this.x0 !== undefined ? this.x0 : 0;
    this.y0 = this.y0 !== undefined ? this.y0 : 0;
    this.long0 = this.long0 !== undefined ? this.long0 : 0;
    this.lat1 = this.lat1 !== undefined ? this.lat1 : WINKEL_STD_PARALLEL;
  },

  forward(this: ProjCtx, p: Pt): Pt {
    const lam = p.x - this.long0;
    const phi = p.y;
    const r = winkelForwardRaw(lam, phi, Math.cos(this.lat1 ?? WINKEL_STD_PARALLEL));
    p.x = this.a * r.x + this.x0;
    p.y = this.a * r.y + this.y0;
    return p;
  },

  /**
   * Two-dimensional Newton–Raphson with an analytic-free (finite difference)
   * Jacobian. The forward map is smooth and near-identity in scale, so a
   * plate-carrée seed converges in a handful of iterations everywhere except
   * exactly at the poles, which are handled as a special case.
   */
  inverse(this: ProjCtx, p: Pt): Pt {
    const cosLat1 = Math.cos(this.lat1 ?? WINKEL_STD_PARALLEL);
    const tx = (p.x - this.x0) / this.a;
    const ty = (p.y - this.y0) / this.a;

    let phi = ty; // y is very nearly phi/1 near the centre meridian
    let lam = tx / Math.max(cosLat1, 0.1);

    const h = 1e-7;
    for (let i = 0; i < 30; i++) {
      const f = winkelForwardRaw(lam, phi, cosLat1);
      const dx = f.x - tx;
      const dy = f.y - ty;
      if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) break;

      const fl = winkelForwardRaw(lam + h, phi, cosLat1);
      const fp = winkelForwardRaw(lam, phi + h, cosLat1);
      const j11 = (fl.x - f.x) / h;
      const j12 = (fp.x - f.x) / h;
      const j21 = (fl.y - f.y) / h;
      const j22 = (fp.y - f.y) / h;

      const det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-14) break;

      lam -= (j22 * dx - j12 * dy) / det;
      phi -= (-j21 * dx + j11 * dy) / det;

      // Keep the iterate inside the domain, otherwise acos() clamps and the
      // Jacobian goes flat.
      phi = Math.max(-HALF_PI, Math.min(HALF_PI, phi));
      lam = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, lam));
    }

    p.x = lam + this.long0;
    p.y = phi;
    return p;
  },

  names: ['Winkel_Tripel', 'winkel_tripel', 'wintri'],
};

// ---------------------------------------------------------------------------
// Natural Earth (Tom Patterson, 2007) — a polynomial pseudocylindrical.
// Coefficients follow PROJ's natearth.cpp.
// ---------------------------------------------------------------------------

const A0 = 0.8707;
const A1 = -0.131979;
const A2 = -0.013791;
const A3 = 0.003971;
const A4 = -0.001529;
const B0 = 1.007226;
const B1 = 0.015085;
const B2 = -0.044475;
const B3 = 0.028874;
const B4 = -0.005916;
// dy/dphi coefficients, used by the Newton inverse.
const C0 = B0;
const C1 = 3 * B1;
const C2 = 7 * B2;
const C3 = 9 * B3;
const C4 = 11 * B4;

function natEarthY(phi: number): number {
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  return phi * (B0 + phi2 * (B1 + phi4 * (B2 + B3 * phi2 + B4 * phi4)));
}

export const naturalEarth = {
  init(this: ProjCtx) {
    this.x0 = this.x0 !== undefined ? this.x0 : 0;
    this.y0 = this.y0 !== undefined ? this.y0 : 0;
    this.long0 = this.long0 !== undefined ? this.long0 : 0;
  },

  forward(this: ProjCtx, p: Pt): Pt {
    const lam = p.x - this.long0;
    const phi = p.y;
    const phi2 = phi * phi;
    const phi4 = phi2 * phi2;
    const x = lam * (A0 + phi2 * (A1 + phi2 * (A2 + phi4 * phi2 * (A3 + phi2 * A4))));
    const y = natEarthY(phi);
    p.x = this.a * x + this.x0;
    p.y = this.a * y + this.y0;
    return p;
  },

  inverse(this: ProjCtx, p: Pt): Pt {
    const tx = (p.x - this.x0) / this.a;
    const ty = (p.y - this.y0) / this.a;

    // y depends on phi alone, so invert it with a scalar Newton iteration first.
    let phi = ty;
    for (let i = 0; i < 30; i++) {
      const phi2 = phi * phi;
      const phi4 = phi2 * phi2;
      const fy = natEarthY(phi) - ty;
      const dfy = C0 + phi2 * (C1 + phi4 * (C2 + C3 * phi2 + C4 * phi4));
      const delta = fy / dfy;
      phi -= delta;
      if (Math.abs(delta) < 1e-12) break;
    }
    phi = Math.max(-HALF_PI, Math.min(HALF_PI, phi));

    const phi2 = phi * phi;
    const phi4 = phi2 * phi2;
    const denom = A0 + phi2 * (A1 + phi2 * (A2 + phi4 * phi2 * (A3 + phi2 * A4)));
    p.x = (Math.abs(denom) < 1e-12 ? 0 : tx / denom) + this.long0;
    p.y = phi;
    return p;
  },

  names: ['Natural_Earth', 'natural_earth', 'natearth'],
};
