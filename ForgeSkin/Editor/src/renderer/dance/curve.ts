import type { Curve } from './vmd';

/** A MMD Bézier curve worked out once: the x half is monotonic, so finding the parameter for a time is a bisection. */
export function curveAt(c: Curve): (u: number) => number {
  const { x1, y1, x2, y2 } = c;
  if (x1 === y1 && x2 === y2) return (u) => u;
  const x = (t: number) => 3 * x1 * t * (1 - t) * (1 - t) + 3 * x2 * t * t * (1 - t) + t * t * t;
  const y = (t: number) => 3 * y1 * t * (1 - t) * (1 - t) + 3 * y2 * t * t * (1 - t) + t * t * t;
  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (x(mid) < u) lo = mid;
      else hi = mid;
    }
    return y((lo + hi) / 2);
  };
}