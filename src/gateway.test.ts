import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerDreamPoliceGateway } from "./gateway.js";
import type { DreamPoliceRuntimeStatus } from "./service.js";

describe("registerDreamPoliceGateway", () => {
  it("registers dreamPolice.status with operator.read scope and responds with live status", () => {
    const registerGatewayMethod = vi.fn();
    const api = {
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;

    const status: DreamPoliceRuntimeStatus = {
      id: "dream-police",
      enabled: true,
      running: false,
      resolved: null,
      workspaceDir: null,
    };

    registerDreamPoliceGateway(api, () => status);

    expect(registerGatewayMethod).toHaveBeenCalledTimes(1);
    const [method, handler, opts] = registerGatewayMethod.mock.calls[0];
    expect(method).toBe("dreamPolice.status");
    expect(opts).toEqual({ scope: "operator.read" });

    const respond = vi.fn();
    handler({ respond });
    expect(respond).toHaveBeenCalledWith(true, status);
  });
});
