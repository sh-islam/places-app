// Shared 4-point perspective / affine-ish math used by the advanced
// image editor AND the per-object warp stored in the room JSON.
//
// computeHomography(src, dst) — 9-element row-major matrix that maps
//   src[i] -> dst[i] (both arrays of 4 [x, y] pairs). Uses Direct
//   Linear Transform with h33 fixed to 1 → 8 unknowns via plain
//   Gaussian elimination. Returns null for degenerate inputs.
//
// invert3x3(m) — returns the inverse of a 9-element row-major matrix,
//   or null if singular.
//
// warpImage(sourceCanvas, corners) — convenience: inverse-sample the
//   source canvas into a new canvas whose 4 corners of the source
//   rect (0,0)-(w,h) end up at `corners` (in source image coords).
//   Returns { canvas, offsetX, offsetY } where (offsetX, offsetY) is
//   the bbox minimum so callers can align the result back to the
//   original center if they want.


export function computeHomography(src, dst) {
  const A = []; // 8 rows × 8 cols
  const b = []; // 8-vector
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([  x,  y,  1,  0,  0,  0, -x * u, -y * u ]);
    b.push(u);
    A.push([  0,  0,  0,  x,  y,  1, -x * v, -y * v ]);
    b.push(v);
  }
  const sol = _solveLinear(A, b);
  if (!sol) return null;
  return [sol[0], sol[1], sol[2], sol[3], sol[4], sol[5], sol[6], sol[7], 1];
}


function _solveLinear(Ain, bin) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const b = bin.slice();
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
    }
    if (Math.abs(A[maxRow][i]) < 1e-10) return null;
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    [b[i], b[maxRow]] = [b[maxRow], b[i]];
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < n; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}


export function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) return null;
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}


// Inverse-sample `srcCanvas` (or HTMLImageElement) into a new canvas
// whose four source-rect corners land at `corners`. Bilinear filtering
// for smooth edges. Skips fully-outside pixels so the output is
// transparent around the warped shape.
export function warpImage(srcLike, corners) {
  const w = srcLike.naturalWidth || srcLike.width;
  const h = srcLike.naturalHeight || srcLike.height;
  const H = computeHomography([[0, 0], [w, 0], [w, h], [0, h]], corners);
  if (!H) return null;
  const Hinv = invert3x3(H);
  if (!Hinv) return null;

  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const outW = Math.max(1, Math.ceil(maxX - minX));
  const outH = Math.max(1, Math.ceil(maxY - minY));

  // Pull source pixels into an ImageData so we can random-access them.
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d").drawImage(srcLike, 0, 0);
  const srcData = src.getContext("2d").getImageData(0, 0, w, h);
  const sd = srcData.data;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext("2d");
  const outImg = outCtx.createImageData(outW, outH);
  const od = outImg.data;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const dx = x + minX;
      const dy = y + minY;
      const wz = Hinv[6] * dx + Hinv[7] * dy + Hinv[8];
      const u = (Hinv[0] * dx + Hinv[1] * dy + Hinv[2]) / wz;
      const v = (Hinv[3] * dx + Hinv[4] * dy + Hinv[5]) / wz;
      if (u < 0 || v < 0 || u >= w - 1 || v >= h - 1) continue;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const x1 = x0 + 1,        y1 = y0 + 1;
      const fx = u - x0,        fy = v - y0;
      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const oi  = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const b = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        od[oi + c] = a * (1 - fy) + b * fy;
      }
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  return { canvas: out, offsetX: minX, offsetY: minY, width: outW, height: outH };
}
