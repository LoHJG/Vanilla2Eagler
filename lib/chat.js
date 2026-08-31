const COLOR_CODES = {
  black: "§0",
  dark_blue: "§1",
  dark_green: "§2",
  dark_aqua: "§3",
  dark_red: "§4",
  dark_purple: "§5",
  gold: "§6",
  gray: "§7",
  dark_gray: "§8",
  blue: "§9",
  green: "§a",
  aqua: "§b",
  red: "§c",
  light_purple: "§d",
  yellow: "§e",
  white: "§f",
  reset: "§r"
};

const FORMAT_CODES = {
  bold: "§l",
  italic: "§o",
  underlined: "§n",
  strikethrough: "§m",
  obfuscated: "§k"
};

function appendComponent(component, parts) {
  if (!component || typeof component !== "object") return;
  let codes = "";
  if (component.color && COLOR_CODES[component.color]) codes += COLOR_CODES[component.color];
  for (const [flag, code] of Object.entries(FORMAT_CODES)) {
    if (component[flag]) codes += code;
  }
  if (typeof component.text === "string" && component.text.length > 0) {
    if (codes) parts.push(codes);
    parts.push(component.text);
  }
  if (typeof component.translate === "string") {
    
    
    if (codes) parts.push(codes);
    parts.push(component.translate);
  }
  if (Array.isArray(component.extra)) {
    for (const extra of component.extra) appendComponent(extra, parts);
  }
}


export function chatComponentToLegacy(input, fallback = "") {
  try {
    const component = typeof input === "string" ? JSON.parse(input) : input;
    if (component && typeof component === "object") {
      const parts = [];
      appendComponent(component, parts);
      const text = parts.join("");
      if (text) return text;
    }
  } catch (_) {}
  if (typeof input === "string" && input) return input;
  return fallback || String(input || "");
}
