import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

const defaultConfig = {
  bindHost: "0.0.0.0",
  bindPort: 25565,
  motd: "Vanilla2Eagler Proxy",
  maxPlayers: 20,

  servers: [],

  eaglerServer: {
    url: "",
    
    host: "127.0.0.1",
    port: 8080,
    path: "/",
    tls: false
  },

  relay: {
    enabled: false,
    url: "wss://mc.smgoro.com/relay",
    code: "",
    username: null,
    rejectUnauthorized: true,
    retryCount: 3
  },

  forceUsername: null,
  skinPreset: 0,
  capePreset: 0,
  skinModel: 0,
  customSkin: null,
  customCape: null,
  customSkinPacket: null,
  customCapePacket: null,
  customSkinPacketV3: null,
  customSkinPacketV4: null,
  skinPacketFormat: 2,
  skinPacketABGR: false,
  handshakeTimeout: 60000,
  debug: false,

  webui: {
    enabled: true,
    host: "0.0.0.0",
    port: 3000,
    randomPort: true,
    exitOnUiClose: true,
    exitGraceMs: 3000
  },

  mineskin: {
    enabled: true,
    apiKey: "",
    publicBaseUrl: "",
    secretSkins: false
  }
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

let config = structuredClone(defaultConfig);

try {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const loaded = JSON.parse(raw);
  config = deepMerge(defaultConfig, loaded);
} catch (_) {
  
}

export function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

export { config };
