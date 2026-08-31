

const ENDPOINT = "https://api.mineskin.org/v2/generate";
const USER_AGENT = "Vanilla2Eagler/MineSkinAPI";
const MAX_RETRIES = 5;
const TIMEOUT_MS = 90000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class MineSkinClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.publicBaseUrl = (options.publicBaseUrl || "").replace(/\/$/, "");
    this.variant = options.variant === "slim" ? "slim" : "classic";
    this.visibility = options.secretSkins ? "unlisted" : "public";
    this.nextRequestAt = 0;
    this.debug = !!options.debug;
  }

  isConfigured() {
    return !!this.publicBaseUrl;
  }

  async generateSkin(uuidHex, pngBuffer, modelId) {
    const variant = this.variant === "slim" || modelId === 1 ? "slim" : "classic";
    
    
    const imageUrl = this.publicBaseUrl
      ? `${this.publicBaseUrl}/skin/${uuidHex}.png`
      : `data:image/png;base64,${Buffer.from(pngBuffer).toString("base64")}`;

    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const now = Date.now();
        if (now < this.nextRequestAt) {
          await sleep(this.nextRequestAt - now);
        }

        const headers = {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT
        };
        if (this.apiKey && this.apiKey !== "key") {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const body = { variant, visibility: this.visibility, url: imageUrl };
        const resp = await fetch(ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timer);

        const json = await resp.json().catch(() => ({}));
        if (this.debug) {
          const shortUrl = imageUrl.startsWith("data:") ? imageUrl.slice(0, 80) + "..." : imageUrl;
          console.log(`[MineSkin] ${shortUrl} ->`, JSON.stringify(json).slice(0, 500));
        }

        if (json.rateLimit && json.rateLimit.next && typeof json.rateLimit.next.relative === "number") {
          this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + json.rateLimit.next.relative);
        }

        if (json.success && json.skin && json.skin.texture && json.skin.texture.data) {
          return {
            value: json.skin.texture.data.value,
            signature: json.skin.texture.data.signature
          };
        }

        const errors = json.errors || [];
        for (const error of errors) {
          lastError = new Error(`MineSkin ${error.code || "unknown"}: ${error.message || error.code || "unknown"}`);
          if (this.debug) console.log("[MineSkin] Error:", error);
          if (error.code === "rate_limit") {
            await sleep(1000);
            continue;
          }
          if (error.code === "failed_to_create_id" || error.code === "skin_change_failed") {
            this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + 6000);
            await sleep(1000);
            continue;
          }
          throw lastError;
        }

        lastError = new Error("MineSkin request failed");
        await sleep(1000);
      } catch (err) {
        lastError = err;
        if (err && err.name === "AbortError") {
          lastError = new Error("MineSkin request timed out");
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error("MineSkin request failed");
  }
}
