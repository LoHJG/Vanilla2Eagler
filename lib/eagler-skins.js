import zlib from "zlib";
import crypto from "crypto";
import { writeVarInt, readVarInt } from "./varint.js";







const CH_V3_SKIN = "EAG|Skins-1.8";
const CH_V3_CAPE = "EAG|Capes-1.8";
const CH_V4 = "EAG|1.8";

export const EAGLER_SKIN_CHANNELS = new Set([CH_V3_SKIN, CH_V3_CAPE, CH_V4]);

export function offlineUuidHex(username) {
  const digest = crypto.createHash("md5").update(Buffer.from("OfflinePlayer:" + username, "utf8")).digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return digest.toString("hex");
}

export function uuidKey(most, least) {
  const b = Buffer.alloc(16);
  b.writeBigInt64BE(BigInt(most), 0);
  b.writeBigInt64BE(BigInt(least), 8);
  return b.toString("hex");
}

export function uuidProfileId(most, least) {
  return uuidKey(most, least);
}

export function uuidDashed(most, least) {
  const hex = uuidKey(most, least);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function readLong(buf, off) {
  return buf.readBigInt64BE(off);
}

function readInt32(buf, off) {
  return buf.readInt32BE(off);
}

function readUnsignedByte(buf, off) {
  return buf[off] & 0xff;
}

export function v4SkinToV3(v4) {
  const v3 = Buffer.alloc(16384);
  for (let i = 0, j = 0, k = 0; i < 4096; i++, j += 3, k += 4) {
    v3[k] = (v4[j + 2] & 0x80) !== 0 ? 0xff : 0x00;
    v3[k + 1] = v4[j];
    v3[k + 2] = v4[j + 1];
    v3[k + 3] = (v4[j + 2] & 0x7f) << 1;
  }
  return v3;
}

export function applyPresetSkin(cache, most, least, preset) {
  cache.set(uuidKey(most, least), { type: "preset", preset: preset >>> 0 });
}

export function applyCustomV3Skin(cache, most, least, model, v3) {
  if (!v3 || v3.length !== 16384) return;
  const copy = Buffer.from(v3);
  cache.set(uuidKey(most, least), { type: "custom", model: model >>> 0, v3: copy });
}

export function applyCustomV4Skin(cache, most, least, model, v4) {
  if (!v4 || v4.length !== 12288) return;
  applyCustomV3Skin(cache, most, least, model, v4SkinToV3(v4));
}

function parseLegacySingle(channel, payload, cache) {
  if (payload.length < 1) return false;
  const id = payload[0];

  if (channel === CH_V3_SKIN) {
    if (id === 0x04 && payload.length >= 21) {
      applyPresetSkin(cache, readLong(payload, 1), readLong(payload, 9), readInt32(payload, 17));
      return true;
    }
    if (id === 0x05 && payload.length >= 18 + 16384) {
      applyCustomV3Skin(cache, readLong(payload, 1), readLong(payload, 9), readUnsignedByte(payload, 17), payload.subarray(18, 18 + 16384));
      return true;
    }
    return false;
  }

  if (channel === CH_V4) {
    if (id === 0xff) {
      let off = 1;
      const count = readVarInt(payload, off);
      off = count.next;
      let parsed = false;
      for (let i = 0; i < count.value; i++) {
        const len = readVarInt(payload, off);
        off = len.next;
        const end = off + len.value;
        if (end > payload.length) break;
        parsed = parseLegacySingle(CH_V4, payload.subarray(off, end), cache) || parsed;
        off = end;
      }
      return parsed;
    }
    if (id === 0x02 && payload.length >= 21) {
      applyPresetSkin(cache, readLong(payload, 1), readLong(payload, 9), readInt32(payload, 17));
      return true;
    }
    if (id === 0x03 && payload.length >= 18 + 12288) {
      applyCustomV4Skin(cache, readLong(payload, 1), readLong(payload, 9), readUnsignedByte(payload, 17), payload.subarray(18, 18 + 12288));
      return true;
    }
    return false;
  }

  return false;
}

export function parseLegacyPluginMessage(channel, payload, cache) {
  if (channel === CH_V3_SKIN || channel === CH_V4) {
    parseLegacySingle(channel, payload, cache);
    return true;
  }
  if (channel === CH_V3_CAPE) {
    return true;
  }
  return false;
}

function parseV5Single(payload, cache, requestMap) {
  if (payload.length < 1) return false;
  const id = payload[0];
  let off = 1;

  if (id === 0xff) {
    const count = readVarInt(payload, off);
    off = count.next;
    let parsed = false;
    for (let i = 0; i < count.value; i++) {
      const len = readVarInt(payload, off);
      off = len.next;
      const end = off + len.value;
      if (end > payload.length) break;
      parsed = parseV5Single(payload.subarray(off, end), cache, requestMap) || parsed;
      off = end;
    }
    return parsed;
  }

  if (id === 0x01) {
    const req = readVarInt(payload, off);
    off = req.next;
    const preset = readVarInt(payload, off);
    const target = requestMap ? requestMap.get(req.value) : null;
    if (target) applyPresetSkin(cache, target.most, target.least, preset.value);
    return true;
  }

  if (id === 0x02) {
    const req = readVarInt(payload, off);
    off = req.next;
    const model = readUnsignedByte(payload, off);
    off += 1;
    const target = requestMap ? requestMap.get(req.value) : null;
    if (target && payload.length >= off + 12288) {
      applyCustomV4Skin(cache, target.most, target.least, model, payload.subarray(off, off + 12288));
    }
    return true;
  }

  if (id === 0x03) return true;
  if (id === 0x04) return true;

  return false;
}

export function parseV5Injected(buf, cache, requestMap) {
  if (!buf || buf.length < 2 || buf[0] !== 0xee) return false;
  parseV5Single(buf.subarray(1), cache, requestMap);
  return true;
}



export function writeMCString(str) {
  const body = Buffer.from(String(str ?? ""), "utf8");
  return Buffer.concat([writeVarInt(body.length), body]);
}

function readMCString(buf, off) {
  const len = readVarInt(buf, off);
  off = len.next;
  const end = off + len.value;
  if (end > buf.length) throw new Error("MC string too long");
  return { value: buf.toString("utf8", off, end), next: end };
}

export function parsePlayerListItemAdds(buf) {
  const out = [];
  try {
    let off = 1;
    const action = readVarInt(buf, off);
    off = action.next;
    if (action.value !== 0) return out;
    const count = readVarInt(buf, off);
    off = count.next;
    for (let i = 0; i < count.value; i++) {
      if (off + 16 > buf.length) break;
      const uuidBytes = buf.subarray(off, off + 16);
      const uuidHex = uuidBytes.toString("hex");
      off += 16;
      const name = readMCString(buf, off);
      off = name.next;
      const propCount = readVarInt(buf, off);
      off = propCount.next;
      for (let p = 0; p < propCount.value; p++) {
        const pName = readMCString(buf, off);
        off = pName.next;
        const pValue = readMCString(buf, off);
        off = pValue.next;
        const hasSig = buf[off++];
        if (hasSig !== 0) {
          const sig = readMCString(buf, off);
          off = sig.next;
        }
      }
      const gm = readVarInt(buf, off);
      off = gm.next;
      const ping = readVarInt(buf, off);
      off = ping.next;
      const hasName = buf[off++];
      if (hasName !== 0) {
        const display = readMCString(buf, off);
        off = display.next;
      }
      out.push({ uuidHex, name: name.value, gamemode: gm.value, ping: ping.value });
    }
  } catch (_) {
  }
  return out;
}

export function buildTexturesValue(profileId, profileName, skinUrl) {
  const json = {
    timestamp: Date.now(),
    profileId,
    profileName: profileName || "",
    textures: {
      SKIN: { url: skinUrl }
    }
  };
  return Buffer.from(JSON.stringify(json), "utf8").toString("base64");
}

export function parsePlayerListItemRemoves(buf) {
  const out = [];
  try {
    let off = 1;
    const action = readVarInt(buf, off);
    off = action.next;
    if (action.value !== 4) return out;
    const count = readVarInt(buf, off);
    off = count.next;
    for (let i = 0; i < count.value; i++) {
      if (off + 16 > buf.length) break;
      out.push(buf.subarray(off, off + 16).toString("hex"));
      off += 16;
    }
  } catch (_) {
  }
  return out;
}

export function rewritePlayerListItem(buf, cache, getSkinProperty, selfMap) {
  let off = 1;
  const action = readVarInt(buf, off);
  off = action.next;
  const count = readVarInt(buf, off);
  off = count.next;

  const pieces = [];
  let touched = false;

  for (let i = 0; i < count.value; i++) {
    if (off + 16 > buf.length) return buf;
    let uuidBytes = buf.subarray(off, off + 16);
    let uuidHex = uuidBytes.toString("hex");
    off += 16;

    const entryStartPieces = [];

    if (action.value === 0) {
      const name = readMCString(buf, off);
      off = name.next;
      let entryName = name.value;

      
      
      if (selfMap && uuidHex === selfMap.fromUuidHex) {
        uuidHex = selfMap.toUuidHex;
        uuidBytes = Buffer.from(selfMap.toUuidHex, "hex");
        entryName = selfMap.toName || entryName;
        touched = true;
      }

      entryStartPieces.push(uuidBytes);
      entryStartPieces.push(writeMCString(entryName));

      const propCount = readVarInt(buf, off);
      off = propCount.next;

      const props = [];
      for (let p = 0; p < propCount.value; p++) {
        const pName = readMCString(buf, off);
        off = pName.next;
        const pValue = readMCString(buf, off);
        off = pValue.next;
        const hasSig = buf[off++];
        let pSig = null;
        if (hasSig !== 0) {
          const sig = readMCString(buf, off);
          off = sig.next;
          pSig = sig.value;
        }
        props.push({ name: pName.value, value: pValue.value, sig: pSig });
      }

      const cached = cache.get(uuidHex);
      const skinProp = cached ? getSkinProperty(uuidHex, entryName) : null;
      if (skinProp && skinProp.value && !props.some((p) => p.name === "textures")) {
        props.push({
          name: "textures",
          value: skinProp.value,
          sig: skinProp.signature || null
        });
        touched = true;
      }

      entryStartPieces.push(writeVarInt(props.length));
      for (const p of props) {
        entryStartPieces.push(writeMCString(p.name));
        entryStartPieces.push(writeMCString(p.value));
        entryStartPieces.push(Buffer.from([p.sig != null ? 1 : 0]));
        if (p.sig != null) entryStartPieces.push(writeMCString(p.sig));
      }

      const gm = readVarInt(buf, off);
      off = gm.next;
      entryStartPieces.push(writeVarInt(gm.value));
      const ping = readVarInt(buf, off);
      off = ping.next;
      entryStartPieces.push(writeVarInt(ping.value));
      const hasName = buf[off++];
      entryStartPieces.push(Buffer.from([hasName]));
      if (hasName !== 0) {
        const display = readMCString(buf, off);
        off = display.next;
        entryStartPieces.push(writeMCString(display.value));
      }
    } else {
      if (selfMap && uuidHex === selfMap.fromUuidHex) {
        uuidBytes = Buffer.from(selfMap.toUuidHex, "hex");
        touched = true;
      }
      entryStartPieces.push(uuidBytes);
      if (action.value === 1) {
        const gm = readVarInt(buf, off);
        off = gm.next;
        entryStartPieces.push(writeVarInt(gm.value));
      } else if (action.value === 2) {
        const ping = readVarInt(buf, off);
        off = ping.next;
        entryStartPieces.push(writeVarInt(ping.value));
      } else if (action.value === 3) {
        const hasName = buf[off++];
        entryStartPieces.push(Buffer.from([hasName]));
        if (hasName !== 0) {
          const display = readMCString(buf, off);
          off = display.next;
          entryStartPieces.push(writeMCString(display.value));
        }
      }
    }

    pieces.push(...entryStartPieces);
  }

  if (!touched) return buf;
  return Buffer.concat([Buffer.from([0x38]), writeVarInt(action.value), writeVarInt(count.value), ...pieces]);
}

export function buildPlayerListItemRemove(uuidHex) {
  return Buffer.concat([
    Buffer.from([0x38]),
    writeVarInt(4), 
    writeVarInt(1), 
    Buffer.from(uuidHex, "hex")
  ]);
}

export function buildPlayerListItemAdd(username, uuidHex, gamemode, ping, cache, getSkinProperty, selfMap) {
  let effectiveUuidHex = uuidHex;
  let effectiveName = username;
  if (selfMap && uuidHex === selfMap.fromUuidHex) {
    effectiveUuidHex = selfMap.toUuidHex;
    effectiveName = selfMap.toName || username;
  }
  const uuidBuf = Buffer.from(effectiveUuidHex, "hex");
  const props = [];
  const cached = cache.get(effectiveUuidHex);
  const skinProp = cached ? getSkinProperty(effectiveUuidHex, effectiveName) : null;
  if (skinProp && skinProp.value) {
    props.push({
      name: "textures",
      value: skinProp.value,
      sig: skinProp.signature || null
    });
  }
  const body = Buffer.concat([
    writeVarInt(0),
    writeVarInt(1),
    uuidBuf,
    writeMCString(effectiveName),
    writeVarInt(props.length)
  ]);
  const propParts = [];
  for (const p of props) {
    propParts.push(writeMCString(p.name));
    propParts.push(writeMCString(p.value));
    propParts.push(Buffer.from([p.sig != null ? 1 : 0]));
    if (p.sig != null) propParts.push(writeMCString(p.sig));
  }
  return Buffer.concat([
    Buffer.from([0x38]),
    body,
    ...propParts,
    writeVarInt(gamemode || 0),
    writeVarInt(ping || 0),
    Buffer.from([0])
  ]);
}



const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePNG(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(scanlines, { level: 6 });
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

export function encodeSkinPNG(v3ABGR, width = 64, height = 64) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < v3ABGR.length; i += 4, j += 4) {
    rgba[j] = v3ABGR[i + 3];
    rgba[j + 1] = v3ABGR[i + 2];
    rgba[j + 2] = v3ABGR[i + 1];
    rgba[j + 3] = v3ABGR[i];
  }
  return encodePNG(rgba, width, height);
}
