import { EventEmitter } from "events";
import crypto from "crypto";
import WebSocket from "ws";
import zlib from "zlib";
import { RTCPeerConnection, RTCIceCandidate } from "werift";
import { writeVarInt, readVarInt } from "./varint.js";
import { resolveSkinPackets, resolveCapePacket } from "./skinutil.js";
import { chatComponentToLegacy } from "./chat.js";


const RELAY_VERSION = 1;
const TYPE_JOIN = 0x02;

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

function writeMCString(str) {
  const body = Buffer.from(str || "", "utf8");
  return Buffer.concat([writeVarInt(body.length), body]);
}

function writeByteArray(arr) {
  const body = Buffer.from(arr || []);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function clientBrandUUID() {
  const digest = crypto.createHash("md5").update(Buffer.from("EaglercraftXClient:Vanilla2Eagler", "utf8")).digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return digest;
}

function buildLanLoginStart(username, skinPacket, capePacket) {
  const protocols = Buffer.from([0x00, 0x03, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05]);
  return Buffer.concat([
    writeVarInt(0x00),
    writeMCString(username),
    writeByteArray(skinPacket),
    writeByteArray(capePacket),
    writeByteArray(protocols),
    clientBrandUUID()
  ]);
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

function readMCString(buf, off) {
  const len = readVarInt(buf, off);
  off = len.next;
  const end = off + len.value;
  if (end > buf.length) throw new Error("MC string too long");
  return { value: buf.toString("utf8", off, end), next: end };
}

function packetHandshake(type, version, code) {
  return Buffer.concat([
    Buffer.from([PKT_HANDSHAKE, type, version]),
    writeASCII8(code)
  ]);
}

function packetClientSuccess(clientId) {
  return Buffer.concat([Buffer.from([PKT_CLIENT_SUCCESS]), writeASCII8(clientId)]);
}

function packetDescription(peerId, desc) {
  return Buffer.concat([
    Buffer.from([PKT_DESCRIPTION]),
    writeASCII8(peerId),
    writeBytes16(Buffer.from(desc, "utf8"))
  ]);
}

function packetIceCandidate(peerId, candidate) {
  return Buffer.concat([
    Buffer.from([PKT_ICE_CANDIDATE]),
    writeASCII8(peerId),
    writeBytes16(Buffer.from(candidate, "utf8"))
  ]);
}


export class EaglerRelayClient extends EventEmitter {
  constructor(options) {
    super();
    this.relayUrl = options.relayUrl;
    this.code = options.code || "";
    this.username = options.username || "Steve";
    this.timeout = options.handshakeTimeout || 0; 
    this.debug = !!options.debug;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this.skinPreset = options.skinPreset || 0;
    this.capePreset = options.capePreset || 0;
    this.customSkin = options.customSkin || null;
    this.customCape = options.customCape || null;
    this.customSkinPacket = options.customSkinPacket || null;
    this.customCapePacket = options.customCapePacket || null;
    this.customSkinPacketV3 = options.customSkinPacketV3 || null;
    this.customSkinPacketV4 = options.customSkinPacketV4 || null;

    this.ws = null;
    this.pc = null;
    this.dataChannel = null;
    this.ready = false;
    this.closed = false;
    this.serverProtocol = 5;

    this._frameQueue = [];
    this._waiters = [];
    this._fragments = [];
    this._remotePeerId = "";
    this.loginPhase = false;
    this._loginResolve = null;
    this._loginReject = null;
    this._signalingDone = false;
    this._iceProbeTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.relayUrl, { rejectUnauthorized: this.rejectUnauthorized });
      this.ws = ws;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch (_) {}
        this._cleanupPeer();
        reject(err);
      };

      ws.on("error", (err) => fail(err));

      ws.on("open", async () => {
        try {
          await this._runRelayHandshake();
          if (settled) return;
          settled = true;
          this.ready = true;
          this._flushQueuedPackets();
          resolve(this);
        } catch (err) {
          fail(err);
        }
      });

      ws.on("message", (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const waiter = this._waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(buf);
        } else {
          this._frameQueue.push(buf);
        }
      });

      ws.on("close", (code, reason) => {
        this.closed = true;
        if (!this.ready && !this._signalingDone) {
          const hasReason = reason && reason.length > 0;
          const detail = hasReason ? reason.toString() : `code=${code ?? "unknown"}`;
          const closeError = new Error(`Relay WebSocket closed during handshake (${detail})`);
          
          
          setTimeout(() => {
            if (!settled) fail(closeError);
          }, 0);
        }
      });
    });
  }

  sendRaw(buffer) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") return false;
    const data = Buffer.from(buffer);
    const max = FRAGMENT_SIZE;
    if (data.length <= max) {
      this.dataChannel.send(Buffer.concat([Buffer.from([0]), data]));
    } else {
      let offset = 0;
      while (offset < data.length) {
        const len = Math.min(max, data.length - offset);
        const last = offset + len >= data.length;
        const header = last ? 0 : 1;
        this.dataChannel.send(Buffer.concat([Buffer.from([header]), data.subarray(offset, offset + len)]));
        offset += len;
      }
    }
    return true;
  }

  close() {
    try { if (this.dataChannel) this.dataChannel.close(); } catch (_) {}
    this._cleanupPeer();
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
      const waiter = { resolve, timer: null };
      const effectiveTimeout = timeout || this.timeout;
      if (effectiveTimeout > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
          reject(new Error("Timed out waiting for relay packet"));
        }, effectiveTimeout);
      }
      this._waiters.push(waiter);
    });
  }

  async _runRelayHandshake() {
    if (!this.relayUrl) throw new Error("Relay URL is required");
    if (!this.code) throw new Error("Relay join code is required");
    if (this.debug) console.log(`[EaglerRelay] Joining shared world via ${this.relayUrl} code=${this.code}`);
    this._send(packetHandshake(TYPE_JOIN, RELAY_VERSION, this.code));

    const hs = await this._nextFrame();
    if (this.debug) console.log(`[EaglerRelay] received relay packet 0x${hs[0].toString(16)} (handshake)`);
    if (hs[0] === PKT_ERROR) throw this._parseError(hs);

    let icePkt = hs;
    if (hs[0] === PKT_HANDSHAKE) {
      
      icePkt = await this._nextFrame();
    } else if (hs[0] !== PKT_ICE_SERVERS) {
      throw new Error("Unexpected relay handshake response: 0x" + hs[0].toString(16));
    }

    if (this.debug) console.log(`[EaglerRelay] received relay packet 0x${icePkt[0].toString(16)} (ice servers)`);
    if (icePkt[0] !== PKT_ICE_SERVERS) {
      if (icePkt[0] === PKT_ERROR) throw this._parseError(icePkt);
      throw new Error("Expected relay ICE servers, got 0x" + icePkt[0].toString(16));
    }
    const iceServers = this._parseIceServers(icePkt);

    if (this.debug) {
      console.log(`[EaglerRelay] Connected to ${this.relayUrl}, code=${this.code}, iceServers=${iceServers.length}`);
      for (const s of iceServers) console.log("[EaglerRelay]   ice:", s.urls, s.username ? "(auth)" : "");
    }

    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;

    const dc = pc.createDataChannel("lan");
    this.dataChannel = dc;

    const localCandidates = [];
    let serverDescriptionReceived = false;
    let serverIceReceived = false;
    let signalError = null;
    let sentLocalCandidates = false;
    let candidateTimerStarted = false;
    let candidateStableCount = 0;
    let candidateTrial = 0;
    let localCandidatesReady = false;
    const sendCandidates = () => {
      if (sentLocalCandidates) return;
      sentLocalCandidates = true;
      const payload = JSON.stringify(localCandidates.splice(0, localCandidates.length));
      if (this.debug) {
        const tmp = JSON.parse(payload);
        console.log(`[EaglerRelay] Sending ${tmp.length} local ICE candidate(s)`);
        for (const c of tmp) console.log("[EaglerRelay]   local:", JSON.stringify(c));
      }
      this._send(packetIceCandidate(this._remotePeerId, payload));
    };

    
    
    
    const scheduleCandidateFlush = () => {
      if (candidateTimerStarted) return;
      candidateTimerStarted = true;
      const flush = () => {
        if (sentLocalCandidates) return;
        if (candidateStableCount !== localCandidates.length && candidateStableCount !== 0) {
          candidateStableCount = localCandidates.length;
          if (++candidateTrial < 3) {
            setTimeout(flush, 2000);
            return;
          }
        }
        candidateStableCount = localCandidates.length;
        localCandidatesReady = true;
        if (serverDescriptionReceived) sendCandidates();
      };
      setTimeout(flush, 2000);
    };

    pc.iceConnectionStateChange.subscribe((state) => {
      if (this.debug) console.log(`[EaglerRelay] ICE connection state: ${state}`);
    });
    this._iceProbeTimer = this.debug ? setInterval(() => {
      try {
        const tx = pc.iceTransports && pc.iceTransports[0];
        const pair = tx ? tx.getSelectedCandidatePair() : null;
        if (pair) {
          console.log("[EaglerRelay] ICE selected pair:", pair.local.candidate, "<=>", pair.remote.candidate);
        } else {
          console.log("[EaglerRelay] ICE selected pair: none", tx ? `state=${tx.state}` : "");
        }
      } catch (_) {}
    }, 3000) : null;
    pc.connectionStateChange.subscribe((state) => {
      if (this.debug) console.log(`[EaglerRelay] Peer connection state: ${state}`);
    });

    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        
        if (serverDescriptionReceived) sendCandidates();
      } else {
        localCandidates.push(candidate.toJSON());
        scheduleCandidateFlush();
      }
    });

    dc.onMessage.subscribe((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this._handleDataChannelMessage(buf);
    });

    dc.stateChanged.subscribe((state) => {
      if (state === "closed" || state === "failed") {
        if (this.loginPhase && this._loginReject) {
          this._loginReject(new Error("LAN data channel closed"));
        }
      }
    });

    if (this.debug) {
      dc.stateChanged.subscribe((state) => {
        console.log(`[EaglerRelay] Data channel state: ${state}`);
      });
    }

    let channelOpened = false;
    let channelFailed = false;
    const channelOpenPromise = new Promise((resolve, reject) => {
      const timer = this.timeout > 0
        ? setTimeout(() => reject(new Error("Timed out waiting for LAN data channel")), this.timeout)
        : null;
      const onState = (state) => {
        if (state === "open") {
          channelOpened = true;
          if (timer) clearTimeout(timer);
          stateSub.unSubscribe();
          resolve();
        } else if (state === "closed" || state === "failed") {
          channelFailed = true;
          if (timer) clearTimeout(timer);
          stateSub.unSubscribe();
          reject(new Error("LAN data channel closed before opening"));
        }
      };
      const stateSub = this.dataChannel.stateChanged.subscribe(onState);
      
      if (this.dataChannel.readyState === "open") {
        channelOpened = true;
      } else if (this.dataChannel.readyState === "closed" || this.dataChannel.readyState === "failed") {
        channelFailed = true;
      }
    });
    channelOpenPromise.catch(() => {});

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    
    const localDesc = this.pc && this.pc.localDescription ? this.pc.localDescription : null;
    this._send(packetDescription("", JSON.stringify({
      type: localDesc?.type || offer.type,
      sdp: localDesc?.sdp || offer.sdp
    })));

    const signalLoop = (async () => {
      while (true) {
        const frame = await this._nextFrame();
        const pkt = this._parseRelayPacket(frame);
        if (this.debug) console.log(`[EaglerRelay] received relay packet 0x${pkt.id.toString(16)} (signaling)`);
        if (pkt.id === PKT_DESCRIPTION) {
          if (pkt.peerId) this._remotePeerId = pkt.peerId;
          const desc = JSON.parse(pkt.data.toString("utf8"));
          if (this.debug) console.log(`[EaglerRelay] Remote description type=${desc.type} sdpLen=${desc.sdp ? desc.sdp.length : 0}`);
          await pc.setRemoteDescription(desc);
          serverDescriptionReceived = true;
          
          
          
          if (!sentLocalCandidates) {
            sendCandidates();
          }
        } else if (pkt.id === PKT_ICE_CANDIDATE) {
          if (pkt.peerId) this._remotePeerId = pkt.peerId;
          serverIceReceived = true;
          
          
          if (this.dataChannel && this.dataChannel.readyState === "open") {
            if (this.debug) console.log("[EaglerRelay] Ignoring late server ICE candidates (data channel already open)");
            continue;
          }
          const candidates = JSON.parse(pkt.data.toString("utf8"));
          
          
          
          const usable = (Array.isArray(candidates) ? candidates : [])
            .filter((c) => c && typeof c.candidate === "string" && !c.candidate.includes(".local"));
          if (this.debug) {
            console.log(`[EaglerRelay] Received ${candidates.length} server ICE candidate(s), using ${usable.length}`);
            for (const c of usable) console.log("[EaglerRelay]   server:", JSON.stringify(c));
          }
          for (const raw of usable) {
            try {
              
              
              
              const c = {
                ...raw,
                sdpMid: raw.sdpMid != null ? String(raw.sdpMid) : "0",
                sdpMLineIndex: raw.sdpMLineIndex != null ? Number(raw.sdpMLineIndex) : 0
              };
              if (!Number.isInteger(c.sdpMLineIndex)) c.sdpMLineIndex = 0;
              await pc.addIceCandidate(new RTCIceCandidate(c));
              if (this.debug) console.log("[EaglerRelay] Added server ICE candidate");
            } catch (err) {
              if (this.debug) console.log("[EaglerRelay] Failed to add server ICE candidate:", err.message);
            }
          }
        } else if (pkt.id === PKT_ERROR) {
          throw this._parseError(frame);
        } else if (pkt.id === PKT_DISCONNECT) {
          if (pkt.code === 0) {
            
            
            this._signalingDone = true;
            if (this.debug) console.log("[EaglerRelay] Relay signaled successful connection");
            return;
          } else {
            const disconnectError = new Error(`Relay disconnected: ${pkt.reason || "no reason"} (code ${pkt.code ?? "unknown"})`);
            if (this.debug) console.error("[EaglerRelay]", disconnectError.message);
            throw disconnectError;
          }
        }
      }
    })();

    signalLoop.catch((err) => {
      signalError = err;
    });

    
    
    while (!channelOpened && !channelFailed && !this.closed) {
      const state = this.dataChannel ? this.dataChannel.readyState : "closed";
      if (state === "open") {
        channelOpened = true;
        break;
      }
      if (state === "closed" || state === "failed") {
        channelFailed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (!channelOpened) {
      if (signalError) throw signalError;
      throw new Error("LAN data channel closed before opening");
    }

    
    
    
    this._signalingDone = true;

    
    
    
    try {
      
      
      if (!serverIceReceived) {
        for (let i = 0; i < 500 && !serverIceReceived && !this.closed; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      try {
        this._send(packetClientSuccess(this._remotePeerId || ""));
      } catch (_) {}
    } catch (_) {}

    
    
    

    
    
    this.loginPhase = true;
    const loginPromise = new Promise((resolve, reject) => {
      this._loginResolve = resolve;
      this._loginReject = reject;
    });
    
    
    const { v3: skinPacket } = resolveSkinPackets({
      customSkinPacket: this.customSkinPacket,
      customSkinPacketV3: this.customSkinPacketV3,
      customSkinPacketV4: this.customSkinPacketV4,
      skinPreset: this.skinPreset
    });
    const capePacket = resolveCapePacket({
      customCapePacket: this.customCapePacket,
      capePreset: this.capePreset
    });
    const lanLoginPacket = buildLanLoginStart(this.username, skinPacket, capePacket);
    if (this.debug) console.log(`[EaglerRelay] Sending LAN login (${lanLoginPacket.length} bytes, data channel ${this.dataChannel ? this.dataChannel.readyState : "null"})`);
    this.sendRaw(lanLoginPacket);

    const loginTimer = this.timeout > 0
      ? setTimeout(() => {
          this._loginReject?.(new Error("Timed out waiting for LAN login success"));
        }, this.timeout)
      : null;

    try {
      await loginPromise;
    } finally {
      if (loginTimer) clearTimeout(loginTimer);
      this._loginResolve = null;
      this._loginReject = null;
    }

    this.ready = true;
  }

  _handleDataChannelMessage(data) {
    if (!data || data.length === 0) return;
    const header = data[0];

    if (header === 1) {
      this._fragments.push(data);
      return;
    }

    let fullData;
    let wasFragmented = false;
    if (this._fragments.length === 0) {
      fullData = data;
    } else {
      this._fragments.push(data);
      const total = this._fragments.reduce((sum, f) => sum + f.length - 1, 0);
      fullData = Buffer.alloc(total);
      let off = 0;
      for (const f of this._fragments) {
        const len = f.length - 1;
        f.copy(fullData, off, 1);
        off += len;
      }
      this._fragments = [];
      wasFragmented = true;
    }

    let payload = wasFragmented ? fullData : fullData.subarray(1);
    if (header === 2) {
      if (payload.length < 4) return;
      const expected = payload.readUInt32BE(0);
      try {
        const inflated = zlib.inflateSync(payload.subarray(4));
        if (inflated.length !== expected) {
          if (this.debug) console.log(`[EaglerRelay] Inflated size ${inflated.length} != expected ${expected}`);
        }
        payload = inflated;
      } catch (err) {
        if (this.debug) console.error("[EaglerRelay] Failed to inflate LAN packet", err);
        return;
      }
    }

    if (this.loginPhase) {
      const pktInfo = readVarInt(payload);
      const pktId = pktInfo.value;
      if (this.debug) console.log(`[EaglerRelay] LAN login received packet id 0x${pktId.toString(16)} (len ${payload.length})`);
      if (pktId === 0x00) {
        
        let reason = "unknown";
        try {
          const str = readMCString(payload, pktInfo.next);
          if (this.debug) console.log("[EaglerRelay] Raw disconnect payload:", str.value);
          reason = chatComponentToLegacy(str.value, str.value);
          if (this.debug) console.log("[EaglerRelay] Formatted disconnect reason:", reason);
        } catch (_) {}
        this._loginReject?.(new Error(reason));
      } else if (pktId === 0x02) {
        
        
        try {
          let off = pktInfo.next;
          const uuidStr = readMCString(payload, off); off = uuidStr.next;
          const usernameStr = readMCString(payload, off); off = usernameStr.next;
          if (payload.length - off >= 2) {
            this.serverProtocol = payload.readUInt16BE(off);
          } else {
            this.serverProtocol = 3;
          }
          if (this.debug) {
            console.log(`[EaglerRelay] Shared world selected protocol v${this.serverProtocol}`);
          }
        } catch (err) {
          if (this.debug) console.error("[EaglerRelay] Failed to parse LAN login success protocol", err);
          this.serverProtocol = 3;
        }
        this.loginPhase = false;
        this._loginResolve?.();
      }
      
      return;
    }

    this.emit("packet", payload);
  }

  _parseIceServers(buf) {
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

  _parseRelayPacket(buf) {
    const id = buf[0];
    let off = 1;
    if (id === PKT_DESCRIPTION || id === PKT_ICE_CANDIDATE) {
      const peer = readASCII8(buf, off); off = peer.next;
      const data = readBytes16(buf, off);
      return { id, peerId: peer.value, data: data.value };
    }
    if (id === PKT_ERROR) {
      const code = buf[off++];
      const desc = readASCII16(buf, off);
      return { id, code, desc: desc.value };
    }
    if (id === PKT_DISCONNECT) {
      const peer = readASCII8(buf, off); off = peer.next;
      const code = buf[off++];
      const reason = readASCII16(buf, off);
      return { id, peerId: peer.value, code, reason: reason.value };
    }
    return { id };
  }

  _parseError(buf) {
    const pkt = this._parseRelayPacket(buf);
    return new Error(`Relay error ${pkt.code}: ${pkt.desc}`);
  }

  _send(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
      return true;
    }
    return false;
  }

  _flushQueuedPackets() {
    while (this._frameQueue.length > 0) {
      const buf = this._frameQueue.shift();
      this.emit("packet", buf);
    }
  }

  _cleanupPeer() {
    if (this._iceProbeTimer) {
      clearInterval(this._iceProbeTimer);
      this._iceProbeTimer = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (_) {}
      this.pc = null;
    }
    this.dataChannel = null;
  }
}
