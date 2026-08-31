import { EventEmitter } from "events";
import net from "net";
import { Vanilla2EaglerProxy } from "./proxy.js";
import { EaglerRelayServer } from "./relay-server.js";

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = () => {
      if (port > start + 500) return reject(new Error("No free port found"));
      const tester = net.createServer();
      tester.unref();
      tester.once("error", (err) => {
        if (err.code === "EADDRINUSE") { port++; tryPort(); }
        else reject(err);
      });
      tester.once("listening", () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, "0.0.0.0");
    };
    tryPort();
  });
}

export class ProxyManager extends EventEmitter {
  constructor(baseConfig) {
    super();
    this.baseConfig = baseConfig;
    this.proxies = new Map();
    this.worlds = new Map();
    this.nextId = 1;
    this.sharedSkinCache = new Map();
    this.sharedSkinProperties = new Map();
    this.sharedSkinPropertyRequests = new Set();
  }

  getProcesses() {
    const proxyRows = [...this.proxies.values()].map((p) => ({
      id: p.id,
      bindHost: p.proxy.config.bindHost || "0.0.0.0",
      bindPort: p.proxy.config.bindPort,
      mode: p.proxy.config.relay?.enabled ? "relay" : "server",
      target: p.proxy.config.relay?.enabled
        ? (p.proxy.config.relay.url + " code=" + (p.proxy.config.relay.code || ""))
        : (p.proxy.config.eaglerServer?.url || ""),
      username: p.proxy.config.forceUsername || null,
      startedAt: p.startedAt
    }));
    const worldRows = [...this.worlds.values()].map((w) => {
      const st = w.getState();
      const codes = st.rooms.map((r) => r.code || "connecting...").join(",");
      return {
        id: w.id,
        bindHost: "relay",
        bindPort: st.targetPort,
        mode: "world",
        target: `${st.relayUrl} room=${st.name} code=${codes}`,
        username: st.name,
        startedAt: w.startedAt,
        worlds: st
      };
    });
    return [...proxyRows, ...worldRows].sort((a, b) => a.startedAt - b.startedAt);
  }

  async startProxy(config) {
    const port = await findFreePort(25565);
    const merged = { ...this.baseConfig, ...config };
    
    if (config.eagler && typeof config.eagler === "object") {
      merged.eaglerServer = { ...(merged.eaglerServer || {}), ...config.eagler };
    }
    const proxy = new Vanilla2EaglerProxy({
      ...merged,
      bindHost: config.bindHost || this.baseConfig.bindHost || "0.0.0.0",
      bindPort: port
    }, {
      skinCache: this.sharedSkinCache,
      skinProperties: this.sharedSkinProperties,
      skinPropertyRequests: this.sharedSkinPropertyRequests
    });
    await proxy.start();
    const id = String(this.nextId++);
    const entry = { id, proxy, startedAt: Date.now() };
    this.proxies.set(id, entry);
    proxy.on("log", (log) => this.emit("log", log));
    proxy.on("state", () => this.emit("processes"));
    proxy.on("players", () => this.emit("processes"));
    this.emit("processes");
    return this.getProcesses();
  }

  async startWorld(config = {}) {
    const cfg = this.baseConfig;
    const world = new EaglerRelayServer({
      relayUrl: config.relayUrl || cfg.relay?.url || "",
      name: config.name || "Shared World",
      hidden: !!config.hidden,
      roomCount: Number(config.roomCount) || 1,
      targetPort: Number(config.targetPort) || 25565,
      rejectUnauthorized: cfg.relay?.rejectUnauthorized !== false
    });
    world.start();
    const id = String(this.nextId++);
    world.id = id;
    world.startedAt = Date.now();
    this.worlds.set(id, world);
    world.on("log", (log) => this.emit("log", log));
    world.on("state", () => this.emit("processes"));
    world.on("peers", () => this.emit("processes"));
    this.emit("processes");
    return this.getProcesses();
  }

  async stopWorld(id) {
    const world = this.worlds.get(String(id));
    if (!world) return false;
    world.stop();
    this.worlds.delete(String(id));
    this.emit("processes");
    return true;
  }

  async stopProxy(id) {
    const entry = this.proxies.get(String(id));
    if (!entry) return false;
    entry.proxy.stop();
    this.proxies.delete(String(id));
    this.emit("processes");
    return true;
  }

  stopAll() {
    for (const entry of this.proxies.values()) {
      try { entry.proxy.stop(); } catch (_) {}
    }
    this.proxies.clear();
    for (const world of this.worlds.values()) {
      try { world.stop(); } catch (_) {}
    }
    this.worlds.clear();
    this.emit("processes");
  }
}
