


export function writeVarInt(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

export function readVarInt(buf, offset = 0) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buf.length) {
    const b = buf[index++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: value >>> 0, size: index - offset, next: index };
    }
    shift += 7;
    if (shift >= 35) throw new Error("VarInt is too big");
  }
  throw new Error("Incomplete VarInt");
}

export function writeShort(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value & 0xffff, 0);
  return b;
}

export function readUInt16BE(buf, offset) {
  return buf.readUInt16BE(offset);
}

export function writeASCII(str) {
  const body = Buffer.from(str, "latin1");
  if (body.length > 255) throw new Error("ASCII string too long: " + body.length);
  return Buffer.concat([Buffer.from([body.length]), body]);
}

export function readASCII(buf, offset, len) {
  return buf.toString("latin1", offset, offset + len);
}

export function bitCount(x) {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
