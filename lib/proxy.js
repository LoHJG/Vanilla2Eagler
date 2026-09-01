import { EventEmitter } from "events";
import { createServer } from "minecraft-protocol";
import WebSocket from "ws";
import { readFile, readdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeVarInt, readVarInt } from "./varint.js";
import { EaglerClient } from "./eagler.js";
import { EaglerRelayClient } from "./relay.js";
import {
  parseLegacyPluginMessage,
  parseV5Injected,
  parsePlayerListItemAdds,
  parsePlayerListItemRemoves,
  rewritePlayerListItem,
  buildPlayerListItemAdd,
  buildPlayerListItemRemove,
  buildTexturesValue,
  applyPresetSkin,
  applyCustomV3Skin,
  offlineUuidHex
} from "./eagler-skins.js";
import { resolveSkinPackets } from "./skinutil.js";
import { MineSkinClient } from "./mineskin.js";
import { encodeSkinPNG, encodePNG } from "./eagler-skins.js";

const WEBUI_ROOT = globalThis.__WEBUI_ROOT__ || join(dirname(fileURLToPath(import.meta.url)), "..", "webui-dist");
const WEBUI_EMBED = globalThis.__WEBUI_EMBED__ || null;
function readEmbeddedFile(rel) {
  const key = String(rel).split("\\").join("/");
  const f = WEBUI_EMBED && WEBUI_EMBED.find((x) => String(x.rel).split("\\").join("/") === key);
  return f ? Buffer.from(f.data, "base64") : null;
}

export class Vanilla2EaglerProxy extends EventEmitter {
  constructor(config, shared = {}) {
    super();
    this.config = config;
    this.server = null;
    this.players = new Map();
    this.skinCache = shared.skinCache || new Map();
    this.skinProperties = shared.skinProperties || new Map();
    this.skinPropertyRequests = shared.skinPropertyRequests || new Set();
    this.running = false;
  }

  async start() {
    if (this.running) return;
    const cfg = this.config;
    const eagler = cfg.eaglerServer || {};

    this.eaglerUrl = this._buildEaglerUrl(eagler);

    const isRelay = !!cfg.relay?.enabled;
    const displayMaxPlayers = cfg.forceUsername ? 1 : (isRelay ? 0 : 100);
    this.server = createServer({
      host: cfg.bindHost || "0.0.0.0",
      port: cfg.bindPort || 25565,
      version: "1.8.9",
      "online-mode": false,
      keepAlive: false,
      motd: cfg.motd || "Vanilla2Eagler Proxy",
      maxPlayers: displayMaxPlayers,
      hideErrors: true,
      beforePing: (response, client, answerToPing) => {
        this._handleBeforePing(response, answerToPing);
      }
    });

    this.server.on("connection", (client) => this._handleConnection(client));
    this.server.on("login", (client) => {
      if (cfg.forceUsername && this.players.size >= 1) {
        client.end("此代理已设置固定游戏内用户名，仅允许一个玩家同时在线");
        return;
      }
      this._handleLogin(client).catch((err) => {
        const message = err && err.message ? err.message : "Unknown login error";
        this.log("error", message);
        if (!client.ended) client.end(message);
      });
    });
    this.server.on("error", (err) => {
      this.log("error", `Server error: ${err.stack || err}`);
    });

    await new Promise((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });

    this.running = true;
    this.log("info", `Listening on ${cfg.bindHost || "0.0.0.0"}:${cfg.bindPort || 25565}`);
    this.log("info", `Forwarding to Eaglercraft server ${this.eaglerUrl}`);
    this.emit("state");
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const player of [...this.players.values()]) {
      try { player.client.end("Proxy stopped"); } catch (_) {}
    }
    this.players.clear();
    if (this.server) {
      try { this.server.close(); } catch (_) {}
      this.server = null;
    }
    this.log("info", "Proxy stopped");
    this.emit("state");
  }

  restart() {
    this.stop();
    return this.start();
  }

  getState() {
    const cfg = this.config;
    return {
      running: this.running,
      bindHost: cfg.bindHost,
      bindPort: cfg.bindPort,
      motd: cfg.motd,
      maxPlayers: cfg.maxPlayers,
      forceUsername: cfg.forceUsername,
      skinPreset: cfg.skinPreset ?? 0,
      capePreset: cfg.capePreset ?? 0,
      skinModel: cfg.skinModel ?? 0,
      customSkin: cfg.customSkin ?? null,
      customCape: cfg.customCape ?? null,
      customSkinPacket: cfg.customSkinPacket ?? null,
      customCapePacket: cfg.customCapePacket ?? null,
      customSkinPacketV3: cfg.customSkinPacketV3 ?? null,
      customSkinPacketV4: cfg.customSkinPacketV4 ?? null,
      skinPacketFormat: cfg.skinPacketFormat ?? 2,
      skinPacketABGR: !!cfg.skinPacketABGR,
      debug: !!cfg.debug,
      handshakeTimeout: cfg.handshakeTimeout,
      eagler: {
        url: cfg.eaglerServer.url || this._legacyEaglerUrl(cfg.eaglerServer)
      },
      relay: {
        enabled: !!cfg.relay?.enabled,
        url: cfg.relay?.url || "",
        code: cfg.relay?.code || "",
        username: cfg.relay?.username || null,
        rejectUnauthorized: cfg.relay?.rejectUnauthorized !== false,
        retryCount: cfg.relay?.retryCount ?? 3
      },
      mineskin: {
        enabled: !!cfg.mineskin?.enabled,
        apiKey: cfg.mineskin?.apiKey || "",
        publicBaseUrl: cfg.mineskin?.publicBaseUrl || "",
        secretSkins: !!cfg.mineskin?.secretSkins
      },
      players: [...this.players.values()].map((p) => ({
        username: p.username,
        uuid: p.uuid,
        address: p.address,
        connectedAt: p.connectedAt
      }))
    };
  }

  applyConfig(patch = {}) {
    const cfg = this.config;
    const changed = [];

    if (patch.relay) {
      const r = patch.relay;
      if (typeof r.enabled === "boolean") cfg.relay.enabled = r.enabled;
      if (typeof r.url === "string" && r.url.length > 0) cfg.relay.url = r.url;
      if (typeof r.code === "string") cfg.relay.code = r.code;
      if (typeof r.username === "string") cfg.relay.username = r.username.trim() || null;
      if (typeof r.rejectUnauthorized === "boolean") cfg.relay.rejectUnauthorized = r.rejectUnauthorized;
      if (Number.isInteger(r.retryCount) && r.retryCount >= 1) cfg.relay.retryCount = r.retryCount;
      changed.push("relay");
    }
    if (patch.eagler) {
      const e = patch.eagler;
      if (typeof e.url === "string" && e.url.trim().length > 0) cfg.eaglerServer.url = e.url.trim();
      changed.push("eagler");
    }
    if (patch.mineskin) {
      const m = patch.mineskin;
      if (typeof m.enabled === "boolean") cfg.mineskin.enabled = m.enabled;
      if (typeof m.apiKey === "string") cfg.mineskin.apiKey = m.apiKey.trim();
      if (typeof m.publicBaseUrl === "string") cfg.mineskin.publicBaseUrl = m.publicBaseUrl.trim().replace(/\/$/, "");
      if (typeof m.secretSkins === "boolean") cfg.mineskin.secretSkins = m.secretSkins;
      changed.push("mineskin");
    }
    if (typeof patch.forceUsername === "string" && patch.forceUsername.trim().length > 0) {
      cfg.forceUsername = patch.forceUsername.trim();
      changed.push("forceUsername");
    } else if (patch.forceUsername === "") {
      cfg.forceUsername = null;
      changed.push("forceUsername");
    }
    if (Number.isInteger(patch.skinPreset) && patch.skinPreset >= 0) {
      cfg.skinPreset = patch.skinPreset;
      changed.push("skinPreset");
    }
    if (Number.isInteger(patch.capePreset) && patch.capePreset >= 0) {
      cfg.capePreset = patch.capePreset;
      changed.push("capePreset");
    }
    if (Number.isInteger(patch.skinModel) && patch.skinModel >= 0 && patch.skinModel <= 1) {
      cfg.skinModel = patch.skinModel;
      changed.push("skinModel");
    }
    if (typeof patch.customSkin === "string" || patch.customSkin === null) {
      cfg.customSkin = patch.customSkin;
      changed.push("customSkin");
    }
    if (typeof patch.customCape === "string" || patch.customCape === null) {
      cfg.customCape = patch.customCape;
      changed.push("customCape");
    }
    if (typeof patch.customSkinPacket === "string" || patch.customSkinPacket === null) {
      cfg.customSkinPacket = patch.customSkinPacket;
      changed.push("customSkinPacket");
    }
    if (typeof patch.customSkinPacketV3 === "string" || patch.customSkinPacketV3 === null) {
      cfg.customSkinPacketV3 = patch.customSkinPacketV3;
      changed.push("customSkinPacketV3");
    }
    if (typeof patch.customSkinPacketV4 === "string" || patch.customSkinPacketV4 === null) {
      cfg.customSkinPacketV4 = patch.customSkinPacketV4;
      changed.push("customSkinPacketV4");
    }
    if (Number.isInteger(patch.skinPacketFormat) && patch.skinPacketFormat >= 1) {
      cfg.skinPacketFormat = patch.skinPacketFormat;
      changed.push("skinPacketFormat");
    }
    if (typeof patch.skinPacketABGR === "boolean") {
      cfg.skinPacketABGR = patch.skinPacketABGR;
      changed.push("skinPacketABGR");
    }
    if (typeof patch.customCapePacket === "string" || patch.customCapePacket === null) {
      cfg.customCapePacket = patch.customCapePacket;
      changed.push("customCapePacket");
    }
    if (typeof patch.debug === "boolean") {
      cfg.debug = patch.debug;
      changed.push("debug");
    }
    if (Number.isInteger(patch.maxPlayers) && patch.maxPlayers > 0) {
      cfg.maxPlayers = patch.maxPlayers;
      if (this.server) this.server.maxPlayers = patch.maxPlayers;
      changed.push("maxPlayers");
    }
    if (typeof patch.motd === "string" && patch.motd.length > 0) {
      cfg.motd = patch.motd;
      if (this.server) this.server.motd = patch.motd;
      changed.push("motd");
    }

    this.eaglerUrl = this._buildEaglerUrl(cfg.eaglerServer);

    if (changed.length > 0) {
      this.log("info", `Config updated: ${changed.join(", ")}`);
      this.emit("state");
    }
    return this.getState();
  }

  disconnectPlayer(username) {
    const player = this.players.get(username);
    if (!player) return false;
    this.players.delete(username);
    try {
      player.client.end("Disconnected from WebUI");
    } catch (_) {}
    this.log("info", `Player ${username} disconnected by WebUI`);
    this.emit("players");
    this.emit("state");
    return true;
  }

  _legacyEaglerUrl(eagler) {
    const scheme = eagler.tls ? "wss" : "ws";
    const host = eagler.host || "127.0.0.1";
    const port = eagler.port || 8080;
    const path = eagler.path || "/";
    return `${scheme}://${host}:${port}${path}`;
  }

  _buildEaglerUrl(eagler) {
    const url = (eagler.url || "").trim();
    if (!url) return this._legacyEaglerUrl(eagler);
    if (url.includes("://")) return url;
    
    if (!url.includes(":")) return `wss://${url}`;
    return `ws://${url}`;
  }

  _mineskinEnabled() {
    return !!(this.config.mineskin && this.config.mineskin.enabled);
  }

  _getMineskinClient() {
    const cfg = this.config.mineskin || {};
    if (!this._mineskinClient || this._mineskinClient.apiKey !== (cfg.apiKey || "")
        || this._mineskinClient.publicBaseUrl !== (cfg.publicBaseUrl || "")
        || this._mineskinClient.debug !== !!this.config.debug) {
      this._mineskinClient = new MineSkinClient({
        apiKey: cfg.apiKey || "",
        publicBaseUrl: cfg.publicBaseUrl || "",
        secretSkins: !!cfg.secretSkins,
        debug: !!this.config.debug
      });
    }
    return this._mineskinClient;
  }

  _getSkinProperty(client, uuidHex, name) {
    if (this._mineskinEnabled()) {
      const prop = this.skinProperties.get(uuidHex);
      if (prop && prop.value) return prop;
      return null;
    }

    
    if (!this.skinCache.has(uuidHex)) return null;
    return {
      value: buildTexturesValue(uuidHex, name, this._skinUrlFor(client, uuidHex)),
      signature: null
    };
  }

  async _getSkinPNG(uuidHex) {
    const entry = this.skinCache.get(uuidHex);
    if (!entry) return null;
    if (entry.type === "custom" && entry.v3) {
      return encodeSkinPNG(entry.v3);
    }
    if (entry.type === "preset") {
      try {
        let files = [];
        if (WEBUI_EMBED) {
          files = WEBUI_EMBED
            .map((x) => String(x.rel).split("\\").join("/"))
            .filter((r) => r.startsWith("skins/") && r.toLowerCase().endsWith(".png"))
            .map((r) => r.slice("skins/".length))
            .sort();
        } else {
          const dir = join(WEBUI_ROOT, "skins");
          files = (await readdir(dir))
            .filter((f) => f.toLowerCase().endsWith(".png"))
            .sort();
        }
        if (files.length > 0 && entry.preset >= 0 && entry.preset < files.length) {
          const rel = `skins/${files[entry.preset]}`;
          return readEmbeddedFile(rel) || await readFile(join(WEBUI_ROOT, "skins", files[entry.preset]));
        }
      } catch (_) {}
    }
    return null;
  }

  async _fetchSkinProperty(client, uuidHex) {
    if (!this._mineskinEnabled() || !this.skinCache.has(uuidHex)) return;
    if (this.skinProperties.has(uuidHex) || this.skinPropertyRequests.has(uuidHex)) return;

    this.skinPropertyRequests.add(uuidHex);
    try {
      const png = await this._getSkinPNG(uuidHex);
      if (!png) {
        this.log("warn", `MineSkin: no PNG available for ${uuidHex}`);
        return;
      }
      const entry = this.skinCache.get(uuidHex);
      const mineskin = this._getMineskinClient();
      const prop = await mineskin.generateSkin(uuidHex, png, entry.model || 0);
      this.skinProperties.set(uuidHex, prop);
      this.log("info", `MineSkin property ready for ${uuidHex}`);
      this._refreshSkinForAllClients(uuidHex);
    } catch (err) {
      this.log("error", `MineSkin request failed for ${uuidHex}: ${err.message}`);
    } finally {
      this.skinPropertyRequests.delete(uuidHex);
    }
  }

  _refreshSkinForAllClients(uuidHex) {
    for (const player of this.players.values()) {
      this._refreshTabSkinForClient(player.client, uuidHex);
    }
  }

  _refreshTabSkinForClient(client, uuidHex) {
    if (!client || !client._tabEntries || client.ended || client.state !== "play") return;
    const entry = client._tabEntries.get(uuidHex);
    if (!entry || entry.skinSent) return;
    const prop = this._getSkinProperty(client, uuidHex, entry.name);
    if (!prop || !prop.value) return;
    entry.skinSent = true;
    try {
      client.writeRaw(buildPlayerListItemAdd(
        entry.name,
        uuidHex,
        entry.gamemode,
        entry.ping,
        this.skinCache,
        (uuid, name) => this._getSkinProperty(client, uuid, name),
        client._selfMap || null
      ));
      if (this.config.debug) {
        this.log("debug", `Sent skin refresh for ${entry.name} (${uuidHex})`);
      }
    } catch (err) {
      this.log("error", `Failed to send skin refresh for ${entry.name}: ${err.message}`);
    }
  }

  _selfMapFor(client, username) {
    try {
      const clientUuid = String(client.uuid || "").replace(/-/g, "").toLowerCase();
      const eaglerUuid = offlineUuidHex(username);
      if (!/^[0-9a-f]{32}$/.test(clientUuid) || clientUuid === eaglerUuid) return null;
      return {
        fromUuidHex: eaglerUuid,
        toUuidHex: clientUuid,
        toName: username || client.username
      };
    } catch (_) {
      return null;
    }
  }

  _webuiBase(client) {
    const cfg = this.config;
    const webuiPort = cfg.webui?.port || 3000;
    let host = cfg.webui?.host || "127.0.0.1";
    if (host === "0.0.0.0" || host === "::") {
      host = (client.socket && client.socket.localAddress) || "127.0.0.1";
    }
    if (host.startsWith("::ffff:")) host = host.slice(7);
    if (host.includes(":")) host = `[${host}]`;
    return `http://${host}:${webuiPort}`;
  }

  _skinUrlFor(client, uuidHex) {
    return `${this._webuiBase(client)}/skin/${uuidHex}.png`;
  }

  _readMCStringAt(buf, off) {
    const len = readVarInt(buf, off);
    off = len.next;
    const end = off + len.value;
    if (end > buf.length) throw new Error("MC string too long");
    return { value: buf.toString("utf8", off, end), next: end };
  }

  _sendEaglerPluginMessage(eagler, channel, data) {
    if (!eagler.ready) return;
    const body = Buffer.concat([this._writeMCString(channel), data]);
    eagler.sendRaw(Buffer.concat([writeVarInt(0x17), body]));
  }

  _requestSkinFor(client, eagler, entry) {
    const uuidHex = entry.uuidHex;
    if (this.skinCache.has(uuidHex) || client._skinRequested.has(uuidHex)) return;
    client._skinRequested.add(uuidHex);
    const uuidBuf = Buffer.from(uuidHex, "hex");
    const most = uuidBuf.readBigInt64BE(0);
    const least = uuidBuf.readBigInt64BE(8);
    try {
      if (eagler.serverProtocol >= 5) {
        const requestId = ++client._skinRequestSeq;
        client._v5SkinRequests.set(requestId, { most, least });
        eagler.sendRaw(Buffer.concat([
          Buffer.from([0xee, 0x01]),
          writeVarInt(requestId),
          uuidBuf
        ]));
      } else if (eagler.serverProtocol === 4) {
        this._sendEaglerPluginMessage(eagler, "EAG|1.8", Buffer.concat([Buffer.from([0x01]), uuidBuf]));
      } else {
        this._sendEaglerPluginMessage(eagler, "EAG|Skins-1.8", Buffer.concat([Buffer.from([0x03]), uuidBuf]));
      }
      if (this.config.debug) {
        this.log("debug", `Requested skin for ${uuidHex} (protocol ${eagler.serverProtocol || 3})`);
      }
    } catch (err) {
      if (this.config.debug) this.log("debug", `Skin request failed for ${uuidHex}: ${err.message}`);
      client._skinRequested.delete(uuidHex);
    }
  }

  _refreshTabSkins(client, eagler) {
    if (!client._tabEntries || client.ended || client.state !== "play") return;
    for (const [uuidHex, entry] of client._tabEntries) {
      if (entry.skinSent) continue;
      if (!this.skinCache.has(uuidHex)) continue;
      const prop = this._getSkinProperty(client, uuidHex, entry.name);
      if (prop && prop.value) {
        entry.skinSent = true;
        try {
          client.writeRaw(buildPlayerListItemAdd(
            entry.name,
            uuidHex,
            entry.gamemode,
            entry.ping,
            this.skinCache,
            (uuid, name) => this._getSkinProperty(client, uuid, name),
            client._selfMap || null
          ));
          if (this.config.debug) {
            this.log("debug", `Sent skin refresh for ${entry.name} (${uuidHex})`);
          }
        } catch (err) {
          this.log("error", `Failed to send skin refresh for ${entry.name}: ${err.message}`);
        }
      } else if (this._mineskinEnabled()) {
        this._fetchSkinProperty(client, uuidHex);
      }
    }
  }

  _handleTabListPacket(client, eagler, buf) {
    let rewritten = buf;
    try {
      rewritten = rewritePlayerListItem(
        buf,
        this.skinCache,
        (uuid, name) => this._getSkinProperty(client, uuid, name),
        client._selfMap || null
      );
    } catch (err) {
      if (this.config.debug) this.log("debug", `PlayerListItem rewrite error: ${err.message}`);
    }

    try {
      for (const uuidHex of parsePlayerListItemRemoves(buf)) {
        client._tabEntries.delete(uuidHex);
      }
      for (const entry of parsePlayerListItemAdds(buf)) {
        const cur = client._tabEntries.get(entry.uuidHex);
        const prop = this.skinCache.has(entry.uuidHex)
          ? this._getSkinProperty(client, entry.uuidHex, entry.name)
          : null;
        if (!cur) {
          client._tabEntries.set(entry.uuidHex, {
            name: entry.name,
            gamemode: entry.gamemode,
            ping: entry.ping,
            skinSent: !!(prop && prop.value)
          });
        } else {
          cur.name = entry.name;
          cur.gamemode = entry.gamemode;
          cur.ping = entry.ping;
          if (!cur.skinSent && prop && prop.value) {
            cur.skinSent = true;
          }
        }
        if (!this.skinCache.has(entry.uuidHex)) {
          this._requestSkinFor(client, eagler, entry);
        } else if (this._mineskinEnabled() && !(prop && prop.value)) {
          this._fetchSkinProperty(client, entry.uuidHex);
        }
      }
    } catch (err) {
      if (this.config.debug) this.log("debug", `PlayerListItem parse error: ${err.message}`);
    }

    return rewritten;
  }

  _handleEaglerSkinPacket(client, eagler, buf) {
    if (buf.length > 0 && buf[0] === 0xee) {
      const before = this.skinCache.size;
      parseV5Injected(buf, this.skinCache, client._v5SkinRequests);
      if (this.config.debug && this.skinCache.size !== before) {
        this.log("debug", `Parsed v5 Eaglercraft skin packet (cache ${before} -> ${this.skinCache.size})`);
      }
      this._refreshTabSkins(client, eagler);
      return true;
    }

    if (buf.length > 0 && buf[0] === 0x3f) {
      try {
        const ch = this._readMCStringAt(buf, 1);
        const payload = buf.subarray(ch.next);
        if (parseLegacyPluginMessage(ch.value, payload, this.skinCache)) {
          if (this.config.debug) this.log("debug", `Parsed Eaglercraft plugin message on channel ${ch.value}`);
          this._refreshTabSkins(client, eagler);
          return true;
        }
      } catch (err) {
        if (this.config.debug) this.log("debug", `Plugin message parse error: ${err.message}`);
      }
    }

    return false;
  }

  _handleConnection(client) {
    

    client.on("end", () => {
      
      
      const username = client._vanillaUsername || client.username;
      if (username && this.players.has(username)) {
        this.players.delete(username);
        this.log("info", `Player ${username} disconnected`);
        this.emit("players");
        this.emit("state");
      }
      if (client.eagler) {
        client.eagler.close();
      }
    });

    client.on("error", (err) => {
      if (client.eagler) client.eagler.close();
    });
  }

  _setupEaglerPacketHandler(client, eagler, username) {
    eagler.on("packet", (buf) => {
      if (client.ended || client.state !== "play") return;
      try {
        if (buf.length > 0 && buf[0] === 0xee) {
          if (eagler.serverProtocol >= 5) {
            this._handleEaglerSkinPacket(client, eagler, buf);
          }
          return; 
        }

        if (buf.length > 0 && buf[0] === 0x3f) {
          if (this._handleEaglerSkinPacket(client, eagler, buf)) {
            return; 
          }
        }

        
        
        
        if (buf.length > 0 && buf[0] === 0x03) {
          return;
        }

        let out = buf;
        if (buf.length > 0 && buf[0] === 0x38) {
          out = this._handleTabListPacket(client, eagler, buf);
        }
        if (buf.length > 0 && buf[0] === 0x40) {
          
          
          
          client._serverKickForwarded = true;
        }
        client.writeRaw(out);
      } catch (err) {
        this.log("error", `Failed to write to vanilla client ${username}: ${err.message}`);
        client.end("Vanilla2Eagler write error");
      }
    });

    eagler.on("close", () => {
      if (!client.ended) {
        if (client._serverKickForwarded) {
          
          client.end();
        } else {
          client.end("Eagler server closed the connection");
        }
      }
    });
  }

  _handleBeforePing(response, answerToPing) {
    (async () => {
      const cfg = this.config;
      if (cfg.relay?.enabled) {
        response.description = cfg.motd || "Vanilla2Eagler Relay";
        response.players.max = 0;
        response.players.online = 0;
        answerToPing(null, response);
        return;
      }
      try {
        const info = await this._queryEaglerMOTD();
        if (info) {
          if (info.motd) response.description = info.motd;
          if (Number.isInteger(info.online)) response.players.online = info.online;
          if (Number.isInteger(info.max)) response.players.max = info.max;
          if (info.favicon) response.favicon = info.favicon;
        }
      } catch (_) {
        
      }
      answerToPing(null, response);
    })();
  }

  async _queryEaglerMOTD() {
    const now = Date.now();
    if (this._motdCache && now - this._motdCache.time < 30000) {
      return this._motdCache.value;
    }
    const url = this.eaglerUrl;
    if (!url) return null;
    const result = await new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url, { rejectUnauthorized: false });
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch (_) {}
        reject(new Error("MOTD query timed out"));
      }, 5000);
      let info = null;
      let gotJson = false;

      ws.on("open", () => {
        ws.send("accept:motd");
      });
      ws.on("message", (data, isBinary) => {
        try {
          if (!gotJson) {
            gotJson = true;
            const json = JSON.parse(data.toString());
            
            const body = json.data && typeof json.data === "object" ? json.data : json;
            const motdArr = Array.isArray(body.motd) ? body.motd : [];
            const motd = motdArr.join("\n") || undefined;
            info = {
              motd,
              online: Number.isInteger(body.online) ? body.online : undefined,
              max: Number.isInteger(body.max) ? body.max : undefined,
              favicon: undefined
            };
            if (body.icon) {
              
              return;
            }
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            resolve(info);
          } else if (isBinary && info) {
            const buf = Buffer.from(data);
            if (buf.length >= 16384) {
              const rgba = buf.subarray(0, 16384);
              const png = encodePNG(rgba, 64, 64);
              info.favicon = `data:image/png;base64,${png.toString("base64")}`;
            }
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            resolve(info);
          }
        } catch (err) {
          clearTimeout(timer);
          try { ws.terminate(); } catch (_) {}
          reject(err);
        }
      });
      ws.on("message", (data, isBinary) => {
        try {
          if (!gotJson) {
            gotJson = true;
            const json = JSON.parse(data.toString());
            const motdArr = Array.isArray(json.motd) ? json.motd : [];
            const motd = motdArr.join("\n") || undefined;
            const info = {
              motd,
              online: Number.isInteger(json.online) ? json.online : undefined,
              max: Number.isInteger(json.max) ? json.max : undefined,
              favicon: undefined
            };
            if (json.icon) {
              
            } else {
              clearTimeout(timer);
              try { ws.close(); } catch (_) {}
              resolve(info);
            }
          } else if (isBinary) {
            const buf = Buffer.from(data);
            if (buf.length >= 16384) {
              const rgba = buf.subarray(0, 16384);
              const png = encodePNG(rgba, 64, 64);
              info.favicon = `data:image/png;base64,${png.toString("base64")}`;
            }
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            resolve(info);
          }
        } catch (err) {
          clearTimeout(timer);
          try { ws.terminate(); } catch (_) {}
          reject(err);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("close", () => {
        clearTimeout(timer);
        if (!gotJson) reject(new Error("MOTD query closed"));
      });
    });
    this._motdCache = { time: now, value: result };
    return result;
  }

  async _handleLogin(client) {
    const cfg = this.config;
    const username = cfg.forceUsername || client.username;
    client._vanillaUsername = username;

    if (cfg.debug) {
      this.log("debug", `Vanilla client ${username} is logging in, connecting to Eagler...`);
    }

    client.eagler = null;
    client._pendingToEagler = [];
    client._toEaglerQueue = [];
    client._toEaglerFlushing = false;
    client._tabEntries = new Map();
    client._v5SkinRequests = new Map();
    client._skinRequested = new Set();
    client._skinRequestSeq = 0;
    this._cacheSelfSkin(client, username);
    client._selfMap = this._selfMapFor(client, username);

    client.on("raw", (buf, meta) => {
      
      
      
      if (meta && (meta.state === "login" || meta.state === "handshaking" || meta.name === "login_start" || meta.name === "handshake")) {
        return;
      }
      if (this.config.debug && buf.length > 0) {
        this.log("debug", `vanilla -> eagler ${meta?.name || "?"} id=0x${buf[0].toString(16)} len=${buf.length}`);
      }
      if (client.eagler && client.eagler.ready) {
        client._toEaglerQueue.push(buf);
        this._scheduleEaglerFlush(client);
      } else {
        client._pendingToEagler.push(buf);
      }
    });

    let eagler;
    if (cfg.relay?.enabled) {
      eagler = await this._connectRelay(cfg, username, client);
    } else {
      eagler = new EaglerClient(this.eaglerUrl, username, {
        handshakeTimeout: cfg.handshakeTimeout || 0,
        debug: cfg.debug,
        skinPreset: cfg.skinPreset ?? 0,
        capePreset: cfg.capePreset ?? 0,
        customSkin: cfg.customSkin ?? null,
        customCape: cfg.customCape ?? null,
        customSkinPacket: cfg.customSkinPacket ?? null,
        customCapePacket: cfg.customCapePacket ?? null,
        customSkinPacketV3: cfg.customSkinPacketV3 ?? null,
        customSkinPacketV4: cfg.customSkinPacketV4 ?? null
      });
      client.eagler = eagler;
      this._setupEaglerPacketHandler(client, eagler, username);
      await eagler.connect();
    }

    if (client.ended) {
      eagler.close();
      return;
    }

    await this._ensureSelfSkinProperties(client, username);

    const player = {
      username,
      uuid: client.uuid || "",
      address: client.socket ? client.socket.remoteAddress : "unknown",
      connectedAt: Date.now(),
      client
    };
    this.players.set(username, player);
    this.log("info", `${username} connected to Eagler server, relaying packets`);
    this.emit("players");
    this.emit("state");

    for (const buf of client._pendingToEagler) {
      client._toEaglerQueue.push(buf);
    }
    client._pendingToEagler = [];
    this._scheduleEaglerFlush(client);
  }

  _scheduleEaglerFlush(client) {
    if (!client || client._toEaglerFlushing) return;
    client._toEaglerFlushing = true;
    const pump = () => {
      const queue = client._toEaglerQueue;
      const eagler = client.eagler;
      if (!eagler || !eagler.ready || client.ended || !Array.isArray(queue)) {
        client._toEaglerFlushing = false;
        return;
      }
      const batch = queue.splice(0, 256);
      for (const buf of batch) {
        try {
          eagler.sendRaw(buf);
        } catch (_) {}
      }
      if (queue.length > 0) {
        setImmediate(pump);
      } else {
        client._toEaglerFlushing = false;
      }
    };
    setImmediate(pump);
  }

  _buildClientSettingsPacket() {
    return Buffer.concat([
      writeVarInt(0x15), 
      this._writeMCString("en_US"),
      Buffer.from([8, 0, 1, 0x7f]) 
    ]);
  }

  _buildBrandPluginMessagePacket() {
    return Buffer.concat([
      writeVarInt(0x17), 
      this._writeMCString("MC|Brand"),
      this._writeMCString("vanilla")
    ]);
  }

  async _ensureSelfSkinProperties(client, username) {
    if (!this._mineskinEnabled()) return;
    const uuids = new Set();
    const clientUuid = String(client.uuid || "").replace(/-/g, "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(clientUuid)) uuids.add(clientUuid);
    try {
      uuids.add(offlineUuidHex(username));
    } catch (_) {}
    for (const uuidHex of uuids) {
      if (!this.skinCache.has(uuidHex) || this.skinProperties.has(uuidHex)) continue;
      await this._fetchSkinProperty(client, uuidHex);
    }
  }

  async _connectRelay(cfg, username, client) {
    
    
    
    const eagler = new EaglerRelayClient({
      relayUrl: cfg.relay.url,
      code: cfg.relay.code,
      username: cfg.relay.username || username,
      handshakeTimeout: 0, 
      debug: cfg.debug,
      rejectUnauthorized: cfg.relay.rejectUnauthorized !== false,
      skinPreset: cfg.skinPreset ?? 0,
      capePreset: cfg.capePreset ?? 0,
      customSkin: cfg.customSkin ?? null,
      customCape: cfg.customCape ?? null,
      customSkinPacket: cfg.customSkinPacket ?? null,
      customCapePacket: cfg.customCapePacket ?? null,
      customSkinPacketV3: cfg.customSkinPacketV3 ?? null,
      customSkinPacketV4: cfg.customSkinPacketV4 ?? null
    });
    client.eagler = eagler;
    this._setupEaglerPacketHandler(client, eagler, username);
    await eagler.connect();
    return eagler;
  }

  _cacheSelfSkin(client, username) {
    try {
      const cfg = this.config;
      const { v3 } = resolveSkinPackets({
        customSkinPacket: cfg.customSkinPacket,
        customSkinPacketV3: cfg.customSkinPacketV3,
        customSkinPacketV4: cfg.customSkinPacketV4,
        skinPreset: cfg.skinPreset
      });
      const uuids = new Set();
      const uuidStr = String(client.uuid || "");
      const uuidHex = uuidStr.replace(/-/g, "").toLowerCase();
      if (/^[0-9a-f]{32}$/.test(uuidHex)) uuids.add(uuidHex);
      try {
        uuids.add(offlineUuidHex(username));
      } catch (_) {}

      for (const hex of uuids) {
        const uuidBuf = Buffer.from(hex, "hex");
        const most = uuidBuf.readBigInt64BE(0);
        const least = uuidBuf.readBigInt64BE(8);
        if (v3.length === 16386 && v3[0] === 0x02) {
          applyCustomV3Skin(this.skinCache, most, least, v3[1], v3.subarray(2));
        } else if (v3.length === 5 && v3[0] === 0x01) {
          applyPresetSkin(this.skinCache, most, least, v3.readInt32BE(1) >>> 0);
        }
      }
      if (this.config.debug) this.log("debug", `Cached self skin for ${[...uuids].join(", ")}`);
    } catch (err) {
      if (this.config.debug) this.log("debug", `Self skin cache failed: ${err.message}`);
    }
  }

  _sendSelfPlayerListItem(client, username) {
    try {
      const uuidStr = String(client.uuid || "");
      const uuidHex = uuidStr.replace(/-/g, "").toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(uuidHex)) return;
      if (!this.skinCache.has(uuidHex)) return;
      client.writeRaw(buildPlayerListItemAdd(
        username,
        uuidHex,
        0,
        0,
        this.skinCache,
        (uuid, name) => this._getSkinProperty(client, uuid, name)
      ));
    } catch (err) {
      if (this.config.debug) this.log("debug", `Self PlayerListItem failed: ${err.message}`);
    }
  }

  _buildTexturesProperties(client) {
    const cfg = this.config;
    const base = this._webuiBase(client);
    const textures = {};

    if (cfg.customSkin || (cfg.skinPreset || 0) >= 0) {
      textures.SKIN = { url: `${base}/player-skin.png` };
    }
    if (cfg.customCape || (cfg.capePreset || 0) > 0) {
      textures.CAPE = { url: `${base}/player-cape.png` };
    }

    if (Object.keys(textures).length === 0) return [];

    const texValue = {
      timestamp: Date.now(),
      profileId: client.uuid || "",
      profileName: client.username || "",
      textures
    };
    const value = Buffer.from(JSON.stringify(texValue), "utf8").toString("base64");
    return [{ name: "textures", value, signature: "" }];
  }

  _writeLoginSuccess(client, uuid, username, properties) {
    const parts = [writeVarInt(0x02), this._writeMCString(uuid), this._writeMCString(username)];
    parts.push(writeVarInt(properties.length));
    for (const prop of properties) {
      parts.push(this._writeMCString(prop.name));
      parts.push(this._writeMCString(prop.value));
      if (prop.signature) {
        parts.push(Buffer.from([1]));
        parts.push(this._writeMCString(prop.signature));
      } else {
        parts.push(Buffer.from([0]));
      }
    }
    const body = Buffer.concat(parts);
    client.writeRaw(body);
  }

  _writeMCString(str) {
    const buf = Buffer.from(String(str ?? ""), "utf8");
    return Buffer.concat([writeVarInt(buf.length), buf]);
  }

  log(level, message) {
    const line = { level, message, time: Date.now() };
    const prefix = `[Vanilla2Eagler] ${message}
`;
    if (level === "error") {
      process.stderr.write(prefix);
    } else if (level === "debug") {
      if (this.config.debug) process.stdout.write(prefix);
    } else {
      process.stdout.write(prefix);
    }
    this.emit("log", line);
  }
}
