import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { qqbotPlugin } from "./src/channel.js";

export default {
  register(api: MoltbotPluginApi) {
    api.registerChannel({ plugin: qqbotPlugin });
  },
};

export { qqbotPlugin } from "./src/channel.js";
export * from "./src/types.js";
export * from "./src/api.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
