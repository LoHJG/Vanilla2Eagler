import { EventEmitter } from "events";
import net from "net";
import zlib from "zlib";
import WebSocket from "ws";
import { RTCPeerConnection, RTCIceCandidate } from "werift";
import { writeVarInt, readVarInt } from "./varint.js";

const RELAY_VERSION = 1;
const TYPE_SERVER = 0x01;
const PKT_HANDSHAKE = 0x00;
const PKT_ICE_SERVERS = 0x01;
const PKT_NEW_CLIENT = 0x02;
const PKT_ICE_CANDIDATE = 0x03;
const PKT_DESCRIPTION = 0x04;
const PKT_CLIENT_SUCCESS = 0x05;
const PKT_CLIENT_FAILURE = 0x06;
const PKT_DISCONNECT = 0xfe;
const PKT_ERROR = 0xff;
const FRAGMENT_SIZE = 0xff00 - 1;
const COMPRESSION_THRESHOLD = 1024;

function writeMCString(str) {
  const body = Buffer.from(str || "", "utf8");
  return Buffer.concat([writeVarInt(body.length), body]);
}

function readMCString(buf, off) {
  const len = readVarInt(buf, off);
  off = len.next;
  const end = off + len.value;
  if (end > buf.length) throw new Error("MC string too long");
  return { value: buf.toString("utf8", off, end), next: end };
}

function writeASCII8(str) {
  const body = Buffer.from(str || "", "latin1");
  if (body.length > 255) throw new Error("ASCII8 string too long");
  return Buffer.concat([Buffer.from([body.length]), body]);
}

function readASCII8(buf, off) {
  const len = buf[off++];
  return { value: buf.toString("latin1", off, off + len), next: off + len };
}

function writeASCII16(str) {
  const body = Buffer.from(str || "", "latin1");
  if (body.length > 65535) throw new Error("ASCII16 string too long");
  const h = Buffer.alloc(2);
  h.writeUInt16BE(body.length, 0);
  return Buffer.concat([h, body]);
}

function readASCII16(buf, off) {
  const len = buf.readUInt16BE(off);
  off += 2;
  return { value: buf.toString("latin1", off, off + len), next: off + len };
}

function writeBytes16(data) {
  const body = Buffer.from(data || []);
  const h = Buffer.alloc(2);
  h.writeUInt16BE(body.length, 0);
  return Buffer.concat([h, body]);
}

function readBytes16(buf, off) {
  const len = buf.readUInt16BE(off);
  off += 2;
  return { value: buf.subarray(off, off + len), next: off + len };
}

function packetHandshake(type, version, code) {
  return Buffer.concat([Buffer.from([PKT_HANDSHAKE, type, version]), writeASCII8(code)]);
}

function packetDescription(peerId, desc) {
  return Buffer.concat([Buffer.from([PKT_DESCRIPTION]), writeASCII8(peerId), writeBytes16(Buffer.from(desc, "utf8"))]);
}

function packetIceCandidate(peerId, candidate) {
  return Buffer.concat([Buffer.from([PKT_ICE_CANDIDATE]), writeASCII8(peerId), writeBytes16(Buffer.from(candidate, "utf8"))]);
}

function packetClientSuccess(peerId) {
  return Buffer.concat([Buffer.from([PKT_CLIENT_SUCCESS]), writeASCII8(peerId)]);
}

function packetClientFailure(peerId) {
  return Buffer.concat([Buffer.from([PKT_CLIENT_FAILURE]), writeASCII8(peerId)]);
}

function sanitizeServerboundPacket(raw) {
  try {
    const pkt = readVarInt(raw, 0);
    if (pkt.value !== 0) return raw;
    let off = pkt.next;
    const name = readMCString(raw, off);
    return Buffer.concat([writeVarInt(0), writeMCString(name.value)]);
  } catch (_) {
    return raw;
  }
}

class LanTcpBridge {
  constructor(peer) {
    this.peer = peer;
    this.socket = null;
    this.closed = false;
    this.compressionEnabled = false;
    this.fragments = [];
  }

  start() {
    if (this.closed) return;
    const port = this.peer.owner.targetPort || 25565;
    this.socket = net.connect({ host: "127.0.0.1", port }, () => {
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(47),
        writeMCString("localhost"),
        Buffer.from([(port >>> 8) & 0xff, port & 0xff]),
        writeVarInt(2)
      ]);
      this.writeRaw(handshake, false);
      this.readLoop().catch((err) => {
        if (!this.closed) this.peer.owner.emit("log", { level: "warn", message: `World bridge error: ${err.message}` });
        this.close();
        this.peer.disconnect();
      });
    });
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
  }

  writeRaw(raw, compressed) {
    if (this.closed || !this.socket) return;
    const parts = [writeVarInt(compressed ? raw.length + 1 : raw.length)];
    if (compressed) parts.push(writeVarInt(0));
    parts.push(raw);
    this.socket.write(Buffer.concat(parts));
  }

  onClientFrame(frame) {
    if (this.closed || !frame || frame.length < 1) return;
    let raw = null;
    const type = frame[0];
    if (type === 0) {
      if (this.fragments.length === 0) {
        raw = frame.subarray(1);
      } else {
        this.fragments.push(frame);
        raw = Buffer.concat(this.fragments.map((f) => f.subarray(1)));
        this.fragments = [];
      }
    } else if (type === 1) {
      this.fragments.push(frame);
    } else {
      this.fragments = [];
    }
    if (raw) {
      this.writeRaw(sanitizeServerboundPacket(raw), this.compressionEnabled);
    }
  }

  async readLoop() {
    let pending = Buffer.alloc(0);
    while (!this.closed) {
      const chunk = await new Promise((resolve, reject) => {
        this.socket.once("data", resolve);
        this.socket.once("error", reject);
      });
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (!this.closed) {
        if (pending.length < 1) break;
        const first = pending[0];
        let len = 0;
        let off = 1;
        let ok = true;
        for (let i = 0; i < 5; i++) {
          if (off > pending.length) { ok = false; break; }
          const b = pending[off - 1];
          len |= (b & 0x7f) << (i * 7);
          if ((b & 0x80) === 0) break;
          off++;
        }
        if (!ok) break;
        if (pending.length < off + len) break;
        let packet = pending.subarray(off, off + len);
        pending = pending.subarray(off + len);
        if (this.compressionEnabled) {
          const dl = readVarInt(packet, 0);
          const compressed = packet.subarray(dl.next);
          if (dl.value === 0) packet = compressed;
          else packet = zlib.inflateSync(compressed);
        }
        if (!this.compressionEnabled && packet.length > 0 && packet[0] === 0x03) {
          this.compressionEnabled = true;
        }
        this.peer.sendLanPacket(packet);
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.destroy(); } catch (_) {}
    this.socket = null;
  }
}

class WorldPeer {
  constructor(owner, id) {
    this.owner = owner;
    this.id = id;
    this.pc = null;
    this.dc = null;
    this.bridge = null;
    this.disconnected = false;
    this.localCandidates = [];
    this.sentCandidates = false;
    this.flushTimer = null;
    this.flushTrials = 0;
    this.lastSize = 0;
    this.remoteIceReceived = false;
  }

  create(iceServers) {
    if (this.disconnected) return;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.onDataChannel.subscribe((dc) => {
      if (this.dc) { try { dc.close(); } catch (_) {} return; }
      this.dc = dc;
      dc.onMessage.subscribe((data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.bridge?.onClientFrame(buf);
      });
      dc.stateChanged.subscribe((state) => {
        if (state === "open") {
          if (!this.bridge) {
            this.bridge = new LanTcpBridge(this);
            this.bridge.start();
          }
        } else if (state === "closed" || state === "failed") {
          this.disconnect();
        }
      });
    });
    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        if (this.remoteIceReceived) this.scheduleFlush();
      } else {
        this.localCandidates.push(candidate.toJSON());
        this.scheduleFlush();
      }
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") this.disconnect();
    });
  }

  scheduleFlush() {
    if (this.flushTimer || this.sentCandidates || this.disconnected) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.sentCandidates || this.disconnected) return;
      if (this.localCandidates.length !== this.lastSize && this.flushTrials < 5) {
        this.lastSize = this.localCandidates.length;
        this.flushTrials++;
        this.scheduleFlush();
        return;
      }
      this.sendCandidates();
    }, 2000);
  }

  sendCandidates() {
    if (this.sentCandidates || this.disconnected) return;
    this.sentCandidates = true;
    const payload = JSON.stringify(this.localCandidates.splice(0, this.localCandidates.length));
    this.owner.send(packetIceCandidate(this.id, payload));
  }

  async handleDescription(desc) {
    if (this.disconnected || !this.pc) return;
    try {
      const parsed = JSON.parse(desc);
      await this.pc.setRemoteDescription(parsed);
      if (parsed.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.owner.send(packetDescription(this.id, JSON.stringify({ type: answer.type, sdp: answer.sdp })));
        if (this.remoteIceReceived) this.scheduleFlush();
      }
    } catch (err) {
      this.disconnect();
    }
  }

  async handleIceCandidate(candidatesJson) {
    if (this.disconnected || !this.pc) return;
    try {
      const candidates = JSON.parse(candidatesJson);
      const usable = (Array.isArray(candidates) ? candidates : [])
        .filter((c) => c && typeof c.candidate === "string" && !c.candidate.includes(".local"));
      for (const raw of usable) {
        const c = {
          ...raw,
          sdpMid: raw.sdpMid != null ? String(raw.sdpMid) : "0",
          sdpMLineIndex: raw.sdpMLineIndex != null ? Number(raw.sdpMLineIndex) : 0
        };
        if (!Number.isInteger(c.sdpMLineIndex)) c.sdpMLineIndex = 0;
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      }
      this.remoteIceReceived = true;
      this.scheduleFlush();
    } catch (_) {
      this.disconnect();
    }
  }

  sendLanPacket(raw) {
    if (this.disconnected || !this.dc || this.dc.readyState !== "open") return;
    const frame = raw.length > COMPRESSION_THRESHOLD ? this.buildCompressedFrame(raw) : Buffer.concat([Buffer.from([0]), raw]);
    let off = 1;
    while (off < frame.length) {
      const len = Math.min(FRAGMENT_SIZE, frame.length - off);
      const last = off + len >= frame.length;
      this.dc.send(Buffer.concat([Buffer.from([last ? frame[0] : 1]), frame.subarray(off, off + len)]));
      off += len;
    }
  }

  buildCompressedFrame(raw) {
    const cmp = zlib.deflateSync(raw);
    const head = Buffer.alloc(5);
    head[0] = 2;
    head.writeUInt32BE(raw.length, 1);
    return Buffer.concat([head, cmp]);
  }

  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.bridge?.close();
    this.bridge = null;
    try { this.dc?.close(); } catch (_) {}
    try { this.pc?.close(); } catch (_) {}
    this.owner.peers.delete(this.id);
    this.owner.emit("peers");
  }
}

class WorldRoom {
  constructor(server, index) {
    this.server = server;
    this.index = index;
    this.name = server.roomCount > 1 ? `${server.name} #${index + 1}` : server.name;
    this.ws = null;
    this.code = null;
    this.ready = false;
    this.closed = true;
    this.iceServers = [];
    this.peers = new Map();
    this.retry = null;
  }

  connect() {
    this.closed = false;
    const handshakeName = `${this.name}${this.server.hidden ? ";1" : ";0"}`;
    const ws = new WebSocket(this.server.relayUrl, {
      rejectUnauthorized: this.server.rejectUnauthorized !== false,
      headers: { "User-Agent": "Vanilla2Eagler/1.0" }
    });
    this.ws = ws;
    ws.on("open", () => {
      ws.send(packetHandshake(TYPE_SERVER, RELAY_VERSION, handshakeName));
    });
    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length === 2 && buf[0] === 0xfc) return;
      try { this.handlePacket(buf); }
      catch (_) { this.scheduleRetry(); }
    });
    ws.on("close", () => {
      if (!this.closed) this.scheduleRetry();
    });
    ws.on("error", () => {
      if (!this.closed) this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.closed || this.retry) return;
    this.ws = null;
    this.ready = false;
    this.code = null;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.closed) this.connect();
    }, 5000);
  }

  handlePacket(buf) {
    const id = buf[0];
    if (id === PKT_HANDSHAKE) {
      const code = readASCII8(buf, 3);
      this.code = code.value;
      this.server.emit("log", { level: "info", message: `World ${this.name} published with code ${this.code}` });
      return;
    }
    if (id === PKT_ICE_SERVERS) {
      this.iceServers = this.parseIceServers(buf);
      this.ready = true;
      this.server.emit("state");
      return;
    }
    let off = 1;
    if (id === PKT_NEW_CLIENT) {
      const peerId = readASCII8(buf, off);
      this.createPeer(peerId.value);
      return;
    }
    if (id === PKT_ICE_CANDIDATE || id === PKT_DESCRIPTION) {
      const peer = readASCII8(buf, off); off = peer.next;
      const data = readBytes16(buf, off);
      const p = this.peers.get(peer.value);
      if (p) {
        if (id === PKT_DESCRIPTION) p.handleDescription(data.value.toString("utf8"));
        else p.handleIceCandidate(data.value.toString("utf8"));
      }
      return;
    }
    if (id === PKT_CLIENT_SUCCESS) {
      const peer = readASCII8(buf, off);
      this.peers.get(peer.value)?.handleSuccess?.();
      return;
    }
    if (id === PKT_CLIENT_FAILURE) {
      const peer = readASCII8(buf, off);
      this.peers.get(peer.value)?.disconnect();
      return;
    }
    if (id === PKT_DISCONNECT) {
      const peer = readASCII8(buf, off); off = peer.next;
      this.peers.get(peer.value)?.disconnect();
      return;
    }
    if (id === PKT_ERROR) {
      const code = buf[off++];
      const desc = readASCII16(buf, off);
      this.server.emit("log", { level: "warn", message: `Relay error ${code}: ${desc.value}` });
      return;
    }
  }

  parseIceServers(buf) {
    let off = 1;
    const count = buf.readUInt16BE(off); off += 2;
    const servers = [];
    for (let i = 0; i < count; i++) {
      const type = String.fromCharCode(buf[off++]);
      const address = readASCII16(buf, off); off = address.next;
      const username = readASCII8(buf, off); off = username.next;
      const password = readASCII8(buf, off); off = password.next;
      const server = { urls: address.value };
      if (type === "T") {
        server.username = username.value;
        server.credential = password.value;
      }
      servers.push(server);
    }
    return servers;
  }

  createPeer(id) {
    const peer = new WorldPeer(this, id);
    this.peers.set(id, peer);
    peer.create(this.iceServers);
    this.server.emit("peers");
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(payload);
  }

  stop() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    for (const peer of [...this.peers.values()]) peer.disconnect();
    this.peers.clear();
    try { this.ws?.close(); } catch (_) {}
    this.ws = null;
    this.ready = false;
    this.code = null;
  }
}

export class EaglerRelayServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.relayUrl = options.relayUrl || "";
    this.name = options.name || "§eVanilla2Eagler Network §c[1.8.9/1.12.2/1.20.6]";
    this.hidden = !!options.hidden;
    this.roomCount = Math.min(Math.max(Number(options.roomCount) || 1, 1), 64);
    this.targetPort = Number(options.targetPort) || 25565;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this.rooms = [];
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.roomCount; i++) {
      const room = new WorldRoom(this, i);
      this.rooms.push(room);
      room.connect();
    }
  }

  getState() {
    return {
      relayUrl: this.relayUrl,
      name: this.name,
      hidden: this.hidden,
      roomCount: this.roomCount,
      targetPort: this.targetPort,
      rooms: this.rooms.map((r) => ({
        name: r.name,
        code: r.code,
        ready: r.ready,
        peers: r.peers.size
      }))
    };
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const room of this.rooms) room.stop();
    this.rooms = [];
    this.emit("state");
  }
}
