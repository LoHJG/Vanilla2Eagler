export function presetSkinPacket(id) {
  const b = Buffer.alloc(5);
  b[0] = 0x01;
  b.writeInt32BE((id || 0) >>> 0, 1);
  return b;
}

export function presetCapePacket(id) {
  const b = Buffer.alloc(5);
  b[0] = 0x01;
  b.writeInt32BE((id || 0) >>> 0, 1);
  return b;
}

function b64ToBuffer(b64) {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    return Buffer.from(b64, "base64");
  } catch (_) {
    return null;
  }
}

function pickPacket(candidates, expectedLength) {
  for (const b64 of candidates) {
    if (b64 == null) continue;
    const b = b64ToBuffer(b64);
    
    if (b && b.length === expectedLength && b[0] === 0x02) return b;
  }
  return null;
}


export function resolveSkinPackets(opts = {}) {
  const preset = presetSkinPacket(opts.skinPreset || 0);
  const v3 = pickPacket([opts.customSkinPacketV3, opts.customSkinPacket], 16386) || preset;
  const v4 = pickPacket([opts.customSkinPacketV4, opts.customSkinPacket], 12290) || preset;
  return { v3, v4 };
}


export function resolveCapePacket(opts = {}) {
  const preset = presetCapePacket(opts.capePreset || 0);
  const custom = pickPacket([opts.customCapePacket], 1174);
  return custom || preset;
}
