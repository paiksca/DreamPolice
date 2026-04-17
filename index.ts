import { definePluginEntry } from "./api.js";
import { dreamPoliceConfigSchema } from "./src/config.js";
import { registerDreamPolice } from "./src/register.js";

export default definePluginEntry({
  id: "dream-police",
  name: "Dream Police",
  description:
    "Supervises dream memory consolidations. Uses an external verifier to fact-check promotions and re-runs the dream with targeted critiques before flagging anything that still fails.",
  configSchema: dreamPoliceConfigSchema,
  register(api) {
    registerDreamPolice(api);
  },
});
