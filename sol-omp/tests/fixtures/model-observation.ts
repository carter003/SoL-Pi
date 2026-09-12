/** Test-only tools and context logging for a real, user-configured model session. */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TEXT = Array.from({ length: 700 }, (_, index) =>
  `${index.toString().padStart(4, "0")} 观察原文🙂 ${index === 350 ? "MIDDLE_MARKER_中间证据_7351" : "不要丢失这一行原文"}\n`,
).join("");

export default function modelObservation(api: ExtensionAPI): void {
  const { Type } = api.typebox;
  api.registerTool({
    name: "sol_omp_test_observation", label: "Test Observation", approval: "read", loadMode: "essential",
    description: "Test only: return a large Chinese UTF-8 observation containing a middle marker.",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: TEXT }], details: { fixtureBytes: Buffer.byteLength(TEXT) } }; },
  });
  api.registerTool({
    name: "sol_omp_test_tick", label: "Test Tick", approval: "read", loadMode: "essential",
    description: "Test only: return a small observation so the next model request occurs. No commands or edits.",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "Fixture tick: no edits or commands performed." }], details: {} }; },
  });
  // Load AFTER sol-omp so this logs the context it actually receives from the host.
  // This emits evidence, NEVER a MODEL_E2E=PASS verdict.
  api.on("context", event => {
    for (const message of event.messages) {
      if (message.role !== "toolResult" || message.toolName !== "sol_omp_test_observation") continue;
      const text = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      const id = text.match(/^id: (obs_[a-f0-9]{24})$/mu)?.[1];
      console.error("SOL_OMP_MODEL_CONTEXT=" + JSON.stringify({
        toolCallId: message.toolCallId, bytes: Buffer.byteLength(text),
        projection: id ? "placeholder" : "full", id: id ?? null,
      }));
    }
  });
}
