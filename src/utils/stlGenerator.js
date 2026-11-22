/**
 * stlGenerator.js — Genera placa 3D (STL binario) con QR en relieve
 * para collar de mascota. 100% Node.js, sin dependencias externas de Python.
 */
import QRCode from 'qrcode';

// ── Parámetros de la placa (mm) ──────────────────────────────────────────────
const PLATE_WIDTH     = 34.0;
const PLATE_HEIGHT    = 50.0;
const PLATE_THICK     = 2.5;
const CORNER_RADIUS   = 4.0;
const HOLE_RADIUS     = 2.5;
const HOLE_OFFSET_Y   = PLATE_HEIGHT / 2 - 5.0;
const QR_RELIEF       = 0.8;
const QR_MARGIN       = 3.0;
const CORNER_SEGMENTS = 16;
const HOLE_SEGMENTS   = 32;

// ── Helpers geométricos ──────────────────────────────────────────────────────

/**
 * Calcula puntos 2D en sentido antihorario para un rectángulo centrado con esquinas redondeadas.
 */
function makeRoundedRectPoints(w, h, r, segs) {
  const hw = w / 2, hh = h / 2;
  const pts = [];
  // Esquinas: inferior-derecha, superior-derecha, superior-izquierda, inferior-izquierda
  const corners = [
    { cx: hw - r, cy: -hh + r, startAngle: -Math.PI / 2 },
    { cx: hw - r, cy:  hh - r, startAngle: 0 },
    { cx: -hw + r, cy: hh - r, startAngle: Math.PI / 2 },
    { cx: -hw + r, cy: -hh + r, startAngle: Math.PI },
  ];
  for (const c of corners) {
    for (let i = 0; i <= segs; i++) {
      const angle = c.startAngle + (Math.PI / 2) * i / segs;
      pts.push([c.cx + r * Math.cos(angle), c.cy + r * Math.sin(angle)]);
    }
  }
  return pts;
}

function makeCirclePoints(cx, cy, r, segs) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const angle = 2 * Math.PI * i / segs;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return pts;
}

// ── Triangulación ────────────────────────────────────────────────────────────

function triangulateFan(pts, z) {
  const tris = [];
  for (let i = 1; i < pts.length - 1; i++) {
    tris.push([
      [pts[0][0], pts[0][1], z],
      [pts[i][0], pts[i][1], z],
      [pts[i + 1][0], pts[i + 1][1], z],
    ]);
  }
  return tris;
}

/**
 * Conecta un contorno exterior con un orificio circular interior formando una cara plana en Z.
 */
function triangulateAnnulus(outerPts, innerPts, cx, cy, z, flipNormal) {
  const tris = [];
  const nOut = outerPts.length;
  const nIn = innerPts.length;

  const outerAngles = outerPts.map(p => {
    let a = Math.atan2(p[1] - cy, p[0] - cx);
    return a < 0 ? a + 2 * Math.PI : a;
  });
  const innerAngles = innerPts.map(p => {
    let a = Math.atan2(p[1] - cy, p[0] - cx);
    return a < 0 ? a + 2 * Math.PI : a;
  });

  // Map cada punto exterior al punto interior más cercano por ángulo
  const mapped = [];
  for (let i = 0; i < nOut; i++) {
    let bestJ = 0, minDiff = Infinity;
    for (let j = 0; j < nIn; j++) {
      let diff = Math.abs(outerAngles[i] - innerAngles[j]);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < minDiff) { minDiff = diff; bestJ = j; }
    }
    mapped.push(bestJ);
  }

  for (let i = 0; i < nOut; i++) {
    const iNext = (i + 1) % nOut;
    const j1 = mapped[i];
    const j2 = mapped[iNext];

    const pO1 = [outerPts[i][0], outerPts[i][1], z];
    const pO2 = [outerPts[iNext][0], outerPts[iNext][1], z];

    let steps = ((j2 - j1) % nIn + nIn) % nIn;
    if (steps > nIn / 2) steps -= nIn;

    let currJ = j1;
    if (steps >= 0) {
      for (let s = 0; s < steps; s++) {
        const nextJ = (currJ + 1) % nIn;
        const pI1 = [innerPts[currJ][0], innerPts[currJ][1], z];
        const pI2 = [innerPts[nextJ][0], innerPts[nextJ][1], z];
        tris.push(flipNormal ? [pO1, pI1, pI2] : [pO1, pI2, pI1]);
        currJ = nextJ;
      }
      const pIF = [innerPts[j2][0], innerPts[j2][1], z];
      tris.push(flipNormal ? [pO1, pIF, pO2] : [pO1, pO2, pIF]);
    } else {
      for (let s = 0; s < -steps; s++) {
        const nextJ = ((currJ - 1) % nIn + nIn) % nIn;
        const pI1 = [innerPts[currJ][0], innerPts[currJ][1], z];
        const pI2 = [innerPts[nextJ][0], innerPts[nextJ][1], z];
        tris.push(flipNormal ? [pO1, pI2, pI1] : [pO1, pI1, pI2]);
        currJ = nextJ;
      }
      const pIF = [innerPts[j2][0], innerPts[j2][1], z];
      tris.push(flipNormal ? [pO1, pIF, pO2] : [pO1, pO2, pIF]);
    }
  }
  return tris;
}

// ── Primitivas 3D ────────────────────────────────────────────────────────────

function addBox(tris, cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;

  tris.push(
    // Front (z1)
    [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1]], [[x0,y0,z1],[x1,y1,z1],[x0,y1,z1]],
    // Back (z0)
    [[x1,y0,z0],[x0,y0,z0],[x0,y1,z0]], [[x1,y0,z0],[x0,y1,z0],[x1,y1,z0]],
    // Right (x1)
    [[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]], [[x1,y0,z0],[x1,y1,z1],[x1,y0,z1]],
    // Left (x0)
    [[x0,y1,z0],[x0,y0,z0],[x0,y0,z1]], [[x0,y1,z0],[x0,y0,z1],[x0,y1,z1]],
    // Top (y1)
    [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1]], [[x0,y1,z0],[x1,y1,z1],[x1,y1,z0]],
    // Bottom (y0)
    [[x0,y0,z1],[x0,y0,z0],[x1,y0,z0]], [[x0,y0,z1],[x1,y0,z0],[x1,y0,z1]],
  );
}

function extrudePolygon(tris, pts, z0, z1) {
  const n = pts.length;
  // Base (normal abajo)
  const baseTris = triangulateFan(pts, z0);
  for (const t of baseTris) tris.push([t[2], t[1], t[0]]);
  // Tapa (normal arriba)
  tris.push(...triangulateFan(pts, z1));
  // Laterales
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p0 = [pts[i][0], pts[i][1], z0];
    const p1 = [pts[j][0], pts[j][1], z0];
    const p2 = [pts[j][0], pts[j][1], z1];
    const p3 = [pts[i][0], pts[i][1], z1];
    tris.push([p0, p1, p2], [p0, p2, p3]);
  }
}

/**
 * Extruye la placa base entre z0 y z1 dejando un orificio pasante para la argolla del collar.
 */
function extrudeWithHole(tris, outerPts, holePts, cx, cy, z0, z1) {
  const nO = outerPts.length, nH = holePts.length;
  // Laterales externas
  for (let i = 0; i < nO; i++) {
    const j = (i + 1) % nO;
    tris.push(
      [[outerPts[i][0],outerPts[i][1],z0],[outerPts[j][0],outerPts[j][1],z0],[outerPts[j][0],outerPts[j][1],z1]],
      [[outerPts[i][0],outerPts[i][1],z0],[outerPts[j][0],outerPts[j][1],z1],[outerPts[i][0],outerPts[i][1],z1]],
    );
  }
  // Laterales del orificio (normal hacia adentro)
  for (let i = 0; i < nH; i++) {
    const j = (i + 1) % nH;
    tris.push(
      [[holePts[j][0],holePts[j][1],z0],[holePts[i][0],holePts[i][1],z0],[holePts[i][0],holePts[i][1],z1]],
      [[holePts[j][0],holePts[j][1],z0],[holePts[i][0],holePts[i][1],z1],[holePts[j][0],holePts[j][1],z1]],
    );
  }
  // Tapas trianguladas con anillo
  tris.push(...triangulateAnnulus(outerPts, holePts, cx, cy, z1, false));  // top
  tris.push(...triangulateAnnulus(outerPts, holePts, cx, cy, z0, true));   // bottom
}

// ── Escritor STL binario ─────────────────────────────────────────────────────

/**
 * Empaqueta la lista de triángulos 3D al formato binario estándar STL (encabezado de 80 bytes + 50 bytes/triángulo).
 */
function buildSTLBuffer(triangles) {
  const headerSize = 80;
  const countSize = 4;
  const triSize = 50; // 12 normal + 36 vertices + 2 attribute
  const buf = Buffer.alloc(headerSize + countSize + triangles.length * triSize);

  // Header
  buf.write('PetCare Manager - Placa QR 3D', 0, 'ascii');
  // Triangle count
  buf.writeUInt32LE(triangles.length, 80);

  let offset = 84;
  for (const tri of triangles) {
    const [v0, v1, v2] = tri;
    // Normal
    const ux = v1[0]-v0[0], uy = v1[1]-v0[1], uz = v1[2]-v0[2];
    const vx = v2[0]-v0[0], vy = v2[1]-v0[1], vz = v2[2]-v0[2];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    buf.writeFloatLE(nx, offset); offset += 4;
    buf.writeFloatLE(ny, offset); offset += 4;
    buf.writeFloatLE(nz, offset); offset += 4;
    // Vertices
    for (const v of [v0, v1, v2]) {
      buf.writeFloatLE(v[0], offset); offset += 4;
      buf.writeFloatLE(v[1], offset); offset += 4;
      buf.writeFloatLE(v[2], offset); offset += 4;
    }
    // Attribute byte count
    buf.writeUInt16LE(0, offset); offset += 2;
  }
  return buf;
}

// ── Generador principal ──────────────────────────────────────────────────────

/**
 * Genera el Buffer STL completo de la placa física con el código QR de emergencia en relieve.
 *
 * @param {string} qrUrl - URL pública del carnet de emergencia de la mascota
 * @returns {Promise<Buffer>} Archivo binario STL listo para descarga o impresión 3D
 */
export async function generatePlateSTL(qrUrl) {
  const triangles = [];

  // 1. Placa base con orificio
  const outerPts = makeRoundedRectPoints(PLATE_WIDTH, PLATE_HEIGHT, CORNER_RADIUS, CORNER_SEGMENTS);
  const holePts = makeCirclePoints(0, HOLE_OFFSET_Y, HOLE_RADIUS, HOLE_SEGMENTS);
  extrudeWithHole(triangles, outerPts, holePts, 0, HOLE_OFFSET_Y, 0, PLATE_THICK);

  // 2. Generar matriz QR
  const qrData = await QRCode.create(qrUrl, { errorCorrectionLevel: 'H' });
  const modules = qrData.modules;
  const qrSize = modules.size;
  const qrArea = PLATE_WIDTH - QR_MARGIN * 2;
  const cellSize = qrArea / qrSize;
  const maxQrTop = HOLE_OFFSET_Y - HOLE_RADIUS - 2;
  const qrOriginX = -qrArea / 2;
  const qrOriginY = -PLATE_HEIGHT / 2 + QR_MARGIN;

  // 3. Módulos QR como relieve (agrupados horizontalmente)
  for (let row = 0; row < qrSize; row++) {
    const y = qrOriginY + (qrSize - 1 - row) * cellSize;
    if (y + cellSize / 2 > maxQrTop) continue;

    let col = 0;
    while (col < qrSize) {
      if (modules.get(row, col)) {
        const startCol = col;
        while (col < qrSize && modules.get(row, col)) col++;
        const segW = (col - startCol) * cellSize;
        const cx = qrOriginX + startCol * cellSize + segW / 2;
        const cy = y + cellSize / 2;
        addBox(triangles, cx, cy, PLATE_THICK + QR_RELIEF / 2, segW, cellSize, QR_RELIEF);
      } else {
        col++;
      }
    }
  }

  // 4. Borde decorativo alrededor del QR
  const borderT = 0.6;
  const borderH = QR_RELIEF * 0.5;
  const bz = PLATE_THICK + borderH / 2;
  const qrEndY = qrOriginY + qrArea;
  addBox(triangles, 0, qrOriginY - borderT/2, bz, qrArea + borderT*2, borderT, borderH);
  if (qrEndY + borderT < maxQrTop) {
    addBox(triangles, 0, qrEndY + borderT/2, bz, qrArea + borderT*2, borderT, borderH);
  }
  const sideH = Math.min(qrEndY, maxQrTop) - qrOriginY;
  const sideY = (qrOriginY + Math.min(qrEndY, maxQrTop)) / 2;
  addBox(triangles, qrOriginX - borderT/2, sideY, bz, borderT, sideH, borderH);
  addBox(triangles, -qrOriginX + borderT/2, sideY, bz, borderT, sideH, borderH);

  // 5. Puntos indicadores "SCAN ME"
  const dotY = Math.min(qrEndY + 2.5, maxQrTop - 1);
  if (dotY > qrEndY + 1) {
    for (const dx of [-3, 0, 3]) {
      const dotPts = makeCirclePoints(dx, dotY, 0.4, 8);
      extrudePolygon(triangles, dotPts, PLATE_THICK, PLATE_THICK + QR_RELIEF * 0.6);
    }
  }

  return buildSTLBuffer(triangles);
}
