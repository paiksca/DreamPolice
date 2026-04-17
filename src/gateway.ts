import type { OpenClawPluginApi } from "../api.js";
import type { DreamPoliceRuntimeStatus } from "./service.js";

type GatewayContext = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];

export function registerDreamPoliceGateway(
  api: OpenClawPluginApi,
  getStatus: () => DreamPoliceRuntimeStatus,
): void {
  api.registerGatewayMethod(
    "dreamPolice.status",
    async (ctx: GatewayContext) => {
      ctx.respond(true, getStatus());
    },
    { scope: "operator.read" },
  );
}
