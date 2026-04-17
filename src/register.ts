import type { OpenClawPluginApi } from "../api.js";
import type { DreamPolicePluginConfig } from "./config.js";
import { createDreamPoliceService } from "./service.js";

export function registerDreamPolice(api: OpenClawPluginApi): void {
  const pluginConfig = api.pluginConfig as DreamPolicePluginConfig | undefined;
  api.registerService(createDreamPoliceService({ pluginConfig }));
}
