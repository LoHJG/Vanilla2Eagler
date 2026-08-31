import { spawn } from "child_process";
import { config } from "./config.js";
import { ProxyManager } from "./lib/proxy-manager.js";
import { WebUI } from "./lib/webui.js";

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (_) {}
}

async function main() {
  const manager = new ProxyManager(config);

  let webui = null;
  function shutdown() {
    try { webui?.close(); } catch (_) {}
    try { manager.stopAll(); } catch (_) {}
    process.exit(0);
  }

  if (config.webui?.enabled) {
    webui = new WebUI(manager, config.webui);
    await webui.start();
    openBrowser(`http://127.0.0.1:${webui.port || 3000}`);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
