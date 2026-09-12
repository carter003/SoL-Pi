import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { requireSupportedFeatures } from "./omp/action-fusion.ts";
import { registerObservationPack } from "./omp/observation-pack.ts";

/** OMP injects its public SDK and schema builder. No original Pi runtime is imported. */
export default async function solOmp(api: ExtensionAPI): Promise<void> {
  if (typeof api.pi?.getAgentDir !== "function" || !api.typebox?.Type) {
    throw new Error("sol-omp requires OMP's injected getAgentDir and TypeBox APIs");
  }
  const { config, path } = await loadConfig(api.pi.getAgentDir());
  // Reject an unsupported request before registering ANY tool or event handler.
  requireSupportedFeatures(config);
  registerObservationPack(api, config.observationPack);
  api.on("session_start", () => {
    console.error(`[sol-omp] loaded observationPack=${config.observationPack} actionFusion=false config=${path}`);
  });
}
