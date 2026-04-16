const fs = require('fs');
const zlib = require('zlib');
const W = 128, H = 128;

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  for (let x = 0; x < W; x++) {
    const offset = y * (1 + W * 4) + 1 + x * 4;
    const t = y / H;
    let r = Math.floor(30 + 78 * (1 - t));
    let g = Math.floor(15 + 48 * (1 - t));
    let b = Math.floor(60 + 132 * (1 - t));
    let a = 255;

    // Rounded rectangle background
    const margin = 8, radius = 16;
    const inX = x >= margin && x < W - margin;
    const inY = y >= margin && y < H - margin;
    if (!(inX && inY)) {
      // Check corner rounding
      const corners = [[margin+radius, margin+radius], [W-margin-radius-1, margin+radius], 
                       [margin+radius, H-margin-radius-1], [W-margin-radius-1, H-margin-radius-1]];
      let inside = false;
      if (inX || inY) inside = true;
      for (const [cx, cy] of corners) {
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy <= radius*radius) inside = true;
      }
      if (!inside) { a = 0; r = 0; g = 0; b = 0; }
    }

    if (a > 0) {
      // Bridge arch
      const cx = 64, archW = 44;
      const dx = (x - cx) / archW;
      if (Math.abs(dx) <= 1) {
        const archY = 32 + 28 * dx * dx;
        if (Math.abs(y - archY) < 3.5) { r = 255; g = 200; b = 60; }
      }

      // Pillars
      if (((x >= 22 && x <= 27) || (x >= 101 && x <= 106)) && y >= 32 && y <= 90) {
        r = 255; g = 200; b = 60;
      }

      // Road deck
      if (y >= 62 && y <= 70 && x >= 18 && x <= 110) {
        r = 255; g = 210; b = 80;
      }

      // Cable lines from arch down to road  
      if (x >= 28 && x <= 100) {
        const archYc = 32 + 28 * ((x - 64) / 44) * ((x - 64) / 44);
        if (x % 12 < 2 && y > archYc && y < 62) {
          r = 220; g = 180; b = 50;
        }
      }

      // "KB" text in gold
      const textY = 78, textH = 16;
      if (y >= textY && y <= textY + textH) {
        const ly = y - textY;
        // K
        const kx = 38;
        if (x >= kx && x <= kx + 16) {
          const lx = x - kx;
          const kLine = lx <= 3 || 
            (lx >= 6 && lx <= 9 && Math.abs(ly - 8) <= (14 - lx)) ||
            (lx >= 10 && lx <= 16 && (ly <= lx - 6 || ly >= 22 - lx));
          if (kLine) { r = 255; g = 255; b = 255; }
        }
        // B
        const bx = 68;
        if (x >= bx && x <= bx + 16) {
          const lx = x - bx;
          const bLine = lx <= 3 || 
            ly <= 2 || (ly >= 7 && ly <= 9) || ly >= textH - 2 ||
            (lx >= 12 && lx <= 16 && ly >= 1 && ly < 8) ||
            (lx >= 12 && lx <= 16 && ly > 8 && ly < textH - 1);
          if (bLine) { r = 255; g = 255; b = 255; }
        }
      }
    }

    raw[offset] = r;
    raw[offset + 1] = g;
    raw[offset + 2] = b;
    raw[offset + 3] = a;
  }
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xEDB88320 ^ (v >>> 1) : v >>> 1;
    table[n] = v;
  }
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crcData = Buffer.concat([t, data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(crcData));
  return Buffer.concat([len, t, data, crcBuf]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6;
const deflated = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync('media/icon.png', png);
console.log('Icon created: media/icon.png (' + png.length + ' bytes)');
