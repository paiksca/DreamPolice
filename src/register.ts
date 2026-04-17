import type { OpenClawPluginApi } from "../api.js";
import { registerDreamPoliceCli } from "./cli.js";
import { resolveDreamPoliceConfig, type DreamPolicePluginConfig } from "./config.js";
import { registerDreamPoliceGateway } from "./gateway.js";
import { createDreamPoliceService } from "./service.js";

export function registerDreamPolice(api: OpenClawPluginApi): void {
  const pluginConfig = api.pluginConfig as DreamPolicePluginConfig | undefined;
  const resolved = resolveDreamPoliceConfig(pluginConfig);

  const service = createDreamPoliceService({ pluginConfig });
  api.registerService(service);
  registerDreamPoliceGateway(api, () => service.getStatus());

  api.registerCli(
    ({ program }) => {
      registerDreamPoliceCli(program, resolved, api.config);
    },
    {
      descriptors: [
        {
          name: "dream-police",
          description: "Inspect and control the DreamPolice supervisor",
          hasSubcommands: true,
        },
      ],
    },
  );
}
