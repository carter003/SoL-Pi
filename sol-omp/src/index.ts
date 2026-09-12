import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { requireSupportedFeatures } from "./omp/action-fusion.ts";
import { registerObservationPack } from "./omp/observation-pack.ts";
import { registerEvidencePreservingReducer } from "./omp/evidence-preserving-reducer.ts";
/** OMP injects its public SDK and schema builder. No original Pi runtime is imported. */
export default async function solOmp(api: ExtensionAPI): Promise<void> {
  if (typeof api.pi?.getAgentDir !== "function" || !api.typebox?.Type) {
    throw new Error("sol-omp requires OMP's injected getAgentDir and TypeBox APIs");
  }
  const { config, path } = await loadConfig(api.pi.getAgentDir());
  // Reject an unsupported request before registering ANY tool or event handler.
  requireSupportedFeatures(config);
  const reducer = registerEvidencePreservingReducer(api, config);
  registerObservationPack(api, config.observationPack, reducer);
  api.on("session_start", (_event, ctx) => {
    const loaded = `[sol-omp] loaded observationPack=${config.observationPack} actionFusion=false config=${path}`;
    if (ctx.hasUI) ctx.ui.notify(loaded, "info");
    else console.error(loaded);
    if (reducer) {
      const warning = `[sol-omp] EPR enabled route=${config.evidencePreservingReducerProvider}/${config.evidencePreservingReducerModel}; diagnostic logs leave this host; additional provider usage applies; runs at session_stop`;
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      else console.error(warning);
    }
  });
}
