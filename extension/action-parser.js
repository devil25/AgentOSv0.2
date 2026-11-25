(() => {
  "use strict";

  const SUPPORTED_ACTIONS = new Set([
    "runtime.status", "skills.list", "plugins.list", "mcp.list", "mcp.tools",
    "mcp.call", "skills.read", "plugins.call", "workspace.list",
    "workspace.read_file", "workspace.create_file", "browser.open_url"
  ]);
  const REQUIRED_KEYS = ["action", "arguments", "protocol", "type"];

  function parseActionObject(candidate) {
    let value;
    try {
      value = JSON.parse(candidate.trim());
    } catch (_) {
      return null;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.length !== REQUIRED_KEYS.length ||
        !REQUIRED_KEYS.every((key, index) => keys[index] === key)) return null;
    if (value.protocol !== "agentos.v1" || value.type !== "action") return null;
    if (typeof value.action !== "string" || !SUPPORTED_ACTIONS.has(value.action)) return null;
    if (!value.arguments || typeof value.arguments !== "object" ||
        Array.isArray(value.arguments)) return null;
    return value;
  }

  function extractBalancedActions(text) {
    for (let start = 0; start < text.length; start += 1) {
      if (text[start] !== "{") continue;

      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let end = start; end < text.length; end += 1) {
        const character = text[end];

        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }

        if (character === '"') inString = true;
        else if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            const action = parseActionObject(text.slice(start, end + 1));
            if (action) return action;
            break;
          }
        }
      }
    }
    return null;
  }

  function extractAction(text) {
    if (typeof text !== "string" || !text.trim()) return null;

    const fence = String.fromCharCode(96).repeat(3);
    const fencedPattern = new RegExp(fence + "(?:json)?\\s*([\\s\\S]*?)" + fence, "gi");
    for (const match of text.matchAll(fencedPattern)) {
      const action = parseActionObject(match[1]);
      if (action) return action;
    }

    // Recover a valid action when an AI site adds a prefix such as "text"
    // or explanatory prose before/after the JSON envelope.
    return extractBalancedActions(text);
  }

  const api = Object.freeze({ extractAction });
  globalThis.AgentOSActionParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
