import { EventEmitter } from "events";
import crypto from "crypto";
import WebSocket from "ws";
import { readVarInt, writeShort, writeASCII, readASCII, bitCount } from "./varint.js";
import { resolveSkinPackets, resolveCapePacket } from "./skinutil.js";
import { chatComponentToLegacy } from "./chat.js";


const PKT_CLIENT_VERSION = 0x01;
const PKT_SERVER_VERSION = 0x02;
const PKT_VERSION_MISMATCH = 0x03;
const PKT_CLIENT_REQUEST_LOGIN = 0x04;
const PKT_SERVER_ALLOW_LOGIN = 0x05;
const PKT_SERVER_DENY_LOGIN = 0x06;
const PKT_CLIENT_PROFILE_DATA = 0x07;
const PKT_CLIENT_FINISH_LOGIN = 0x08;
const PKT_SERVER_FINISH_LOGIN = 0x09;
const PKT_SERVER_REDIRECT_TO = 0x0a;
const PKT_SERVER_ERROR = 0xff;

const CLIENT_BRAND = "Vanilla2Eagler";
const CLIENT_VERSION = "1.0.0";

function clientBrandUUID() {
  const digest = crypto.createHash("md5").update(Buffer.from("EaglercraftXClient:" + CLIENT_BRAND, "utf8")).digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return digest;
}

export class EaglerClient extends EventEmitter {
  constructor(url, username, options = {}) {
    super();
    this.url = url;
    this.username = username;
    this.timeout = options.handshakeTimeout || 0; 
    this.debug = !!options.debug;
    this.skinPreset = options.skinPreset || 0;
    this.capePreset = options.capePreset || 0;
    this.customSkin = options.customSkin || null;
    this.customCape = options.customCape || null;
    this.customSkinPacket = options.customSkinPacket || null;
    this.customCapePacket = options.customCapePacket || null;
    this.customSkinPacketV3 = options.customSkinPacketV3 || null;
    this.customSkinPacketV4 = options.customSkinPacketV4 || null;

    this.ws = null;
    this.ready = false;
    this.closed = false;

    this._frameQueue = [];
    this._waiters = [];
    this._handshakeError = null;
    this._packetHandler = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);

      this.ws = ws;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch (_) {}
        reject(err);
      };

      ws.on("error", (err) => fail(err));

      ws.on("open", async () => {
        try {
          await this._runHandshake();
          if (settled) return;
          settled = true;
          this.ready = true;
          this._flushQueuedPackets();
          resolve(this);
        } catch (err) {
          fail(err);
        }
      });

      ws.on("message", (data, isBinary) => {
        let buf;
        if (Buffer.isBuffer(data)) {
          buf = data;
        } else if (data instanceof ArrayBuffer) {
          buf = Buffer.from(data);
        } else if (Array.isArray(data)) {
          buf = Buffer.from(data);
        } else {
          return; 
        }

        if (!this.ready) {
          const waiter = this._waiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(buf);
          } else {
            this._frameQueue.push(buf);
          }
        } else {
          this.emit("packet", buf);
        }
      });

      ws.on("close", () => {
        this.closed = true;
        if (!this.ready) {
          fail(new Error("Eagler WebSocket closed during handshake"));
        } else {
          this.emit("close");
        }
      });
    });
  }

  sendRaw(buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
      return true;
    }
    return false;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }

  _nextFrame(timeout) {
    return new Promise((resolve, reject) => {
      if (this._frameQueue.length > 0) {
        resolve(this._frameQueue.shift());
        return;
      }
      const waiter = {
        resolve,
        timer: null
      };
      const effectiveTimeout = timeout || this.timeout;
      if (effectiveTimeout > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
          reject(new Error("Timed out waiting for Eagler handshake packet"));
        }, effectiveTimeout);
      }
      this._waiters.push(waiter);
    });
  }

  async _runHandshake() {
    
    const clientVersion = Buffer.concat([
      Buffer.from([PKT_CLIENT_VERSION, 0x02]),
      writeShort(3), 
      writeShort(3), 
      writeShort(4), 
      writeShort(5), 
      writeShort(1), 
      writeShort(47), 
      writeASCII(CLIENT_BRAND),
      writeASCII(CLIENT_VERSION),
      Buffer.from([0]), 
      writeASCII(this.username)
    ]);
    this._send(clientVersion);

    const versionPacket = await this._nextFrame();
    let protocolVersion;
    if (versionPacket[0] === PKT_VERSION_MISMATCH) {
      throw new Error("Eagler server version mismatch");
    } else if (versionPacket[0] === PKT_SERVER_ERROR) {
      throw this._parseServerError(versionPacket, false);
    } else if (versionPacket[0] !== PKT_SERVER_VERSION) {
      throw new Error("Unexpected Eagler handshake packet id: 0x" + versionPacket[0].toString(16));
    }

    let off = 1;
    protocolVersion = versionPacket.readUInt16BE(off); off += 2;
    const gameVersion = versionPacket.readUInt16BE(off); off += 2;
    if (gameVersion !== 47) {
      throw new Error("Eagler server does not support Minecraft 1.8 (protocol " + gameVersion + ")");
    }
    if (protocolVersion !== 3 && protocolVersion !== 4 && protocolVersion !== 5) {
      throw new Error("Unsupported Eagler protocol version: " + protocolVersion);
    }

    const brandLen = versionPacket[off++];
    const brand = readASCII(versionPacket, off, brandLen); off += brandLen;
    const serverVersionLen = versionPacket[off++];
    const serverVersion = readASCII(versionPacket, off, serverVersionLen); off += serverVersionLen;
    const authType = versionPacket[off++];
    const saltLen = versionPacket.readUInt16BE(off); off += 2;
    off += saltLen;
    let nicknameSelection = true;
    if (protocolVersion >= 5) {
      nicknameSelection = versionPacket[off++] !== 0;
    }

    if (this.debug) {
      console.log(`[EaglerClient] server protocol v${protocolVersion}, brand=${brand}, version=${serverVersion}, authType=${authType}`);
    }

    
    const requestLogin = [Buffer.from([PKT_CLIENT_REQUEST_LOGIN])];
    if (protocolVersion >= 5 && !nicknameSelection) {
      requestLogin.push(Buffer.from([0]));
    } else {
      requestLogin.push(writeASCII(this.username));
    }
    requestLogin.push(writeASCII("default"));
    requestLogin.push(Buffer.from([0])); 
    if (protocolVersion >= 4) {
      requestLogin.push(Buffer.from([0])); 
      requestLogin.push(Buffer.from([0])); 
    }
    if (protocolVersion >= 5) {
      requestLogin.push(Buffer.from([0])); 
      requestLogin.push(Buffer.from([0])); 
    }
    this._send(Buffer.concat(requestLogin));

    
    const allowPacket = await this._nextFrame();
    if (allowPacket[0] === PKT_SERVER_DENY_LOGIN) {
      throw this._parseDeny(allowPacket);
    } else if (allowPacket[0] === PKT_SERVER_ERROR) {
      throw this._parseServerError(allowPacket, true);
    } else if (allowPacket[0] !== PKT_SERVER_ALLOW_LOGIN) {
      throw new Error("Unexpected Eagler login response: 0x" + allowPacket[0].toString(16));
    }

    
    off = 1;
    const serverUsernameLen = allowPacket[off++];
    const serverUsername = readASCII(allowPacket, off, serverUsernameLen); off += serverUsernameLen;
    off += 16; 
    if (protocolVersion >= 5) {
      const caps = readVarInt(allowPacket, off);
      off = caps.next;
      off += bitCount(caps.value); 
      const extCount = allowPacket[off++];
      off += extCount * 17; 
    }
    this.username = serverUsername || this.username;
    this.serverProtocol = protocolVersion;

    
    
    
    const { v3: skinV3Packet, v4: skinV4Packet } = resolveSkinPackets({
      customSkinPacket: this.customSkinPacket,
      customSkinPacketV3: this.customSkinPacketV3,
      customSkinPacketV4: this.customSkinPacketV4,
      skinPreset: this.skinPreset
    });
    const capePacket = resolveCapePacket({
      customCapePacket: this.customCapePacket,
      capePreset: this.capePreset
    });
    if (protocolVersion >= 4) {
      const entries = [
        ["brand_uuid_v1", clientBrandUUID()],
        ["skin_v1", skinV3Packet],
        ["skin_v2", skinV4Packet],
        ["cape_v1", capePacket]
      ];
      const parts = [Buffer.from([PKT_CLIENT_PROFILE_DATA, entries.length])];
      for (const [type, data] of entries) {
        parts.push(writeASCII(type));
        parts.push(writeShort(data.length));
        parts.push(data);
      }
      this._send(Buffer.concat(parts));
    } else {
      this._send(this._profileEntry("skin_v1", skinV3Packet));
      this._send(this._profileEntry("cape_v1", capePacket));
    }

    
    this._send(Buffer.from([PKT_CLIENT_FINISH_LOGIN]));

    
    const finishPacket = await this._nextFrame();
    if (finishPacket[0] === PKT_SERVER_DENY_LOGIN) {
      throw this._parseDeny(finishPacket);
    } else if (finishPacket[0] === PKT_SERVER_ERROR) {
      throw this._parseServerError(finishPacket, true);
    } else if (finishPacket[0] === PKT_SERVER_REDIRECT_TO) {
      throw new Error("Eagler server requested a redirect, which is not supported by this proxy");
    } else if (finishPacket[0] !== PKT_SERVER_FINISH_LOGIN) {
      throw new Error("Unexpected Eagler finish response: 0x" + finishPacket[0].toString(16));
    }

    if (this.debug) {
      console.log("[EaglerClient] handshake complete, entering PLAY relay mode");
    }
  }

  _profileEntry(type, data) {
    return Buffer.concat([
      Buffer.from([PKT_CLIENT_PROFILE_DATA]),
      writeASCII(type),
      writeShort(data.length),
      data
    ]);
  }

  _parseDeny(packet) {
    let off = 1;
    const len = packet.readUInt16BE(off); off += 2;
    const reason = packet.toString("utf8", off, off + len);
    return new Error("Eagler server denied login: " + chatComponentToLegacy(reason, reason));
  }

  _parseServerError(packet, v3Style) {
    let off = 1;
    const code = packet[off++];
    let len;
    if (v3Style) {
      len = packet.readUInt16BE(off); off += 2;
    } else {
      len = packet[off++];
    }
    const msg = packet.toString("utf8", off, off + len);
    return new Error(`Eagler server error ${code}: ${chatComponentToLegacy(msg, msg)}`);
  }

  _send(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
    } else {
      throw new Error("Eagler WebSocket is not open");
    }
  }

  _flushQueuedPackets() {
    while (this._frameQueue.length > 0) {
      const buf = this._frameQueue.shift();
      this.emit("packet", buf);
    }
  }
}
