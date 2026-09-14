import type { SolOmpConfig } from "../config.ts";

/** This is a capability guard, NOT an implementation of fused edit/write. */
export const ACTION_FUSION_BLOCKER =
  "Action Fusion is unavailable on the audited OMP 18.1.19 interface: " +
  "ctx.invokeTool delegates only to the same native tool, while pi.exec does not dispatch " +
  "through bash tool approval and tool_call interception. Set actionFusion: false. " +
  "No edit/write override or command has been registered/executed. See docs/action-fusion-blocker.md.";

export function requireSupportedFeatures(config: SolOmpConfig): void {
  if (config.actionFusion) throw new Error(ACTION_FUSION_BLOCKER);
}
