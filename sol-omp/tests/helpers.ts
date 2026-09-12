import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";
type AgentMessage = ContextEvent["messages"][number];
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

export async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sol-omp-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export const LARGE_TEXT = Array.from({ length: 1600 }, (_, index) =>
  `${index.toString().padStart(4, "0")} 中文观察🙂 ${index === 800 ? "MIDDLE_MARKER_中间证据" : "保留完整输出"}\n`,
).join("");

export function toolMessage(text = LARGE_TEXT, overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "toolResult", toolCallId: "call-test-1", toolName: "read",
    content: [{ type: "text", text }], isError: false, timestamp: 1000,
    details: { fixture: true }, ...overrides,
  } as unknown as AgentMessage;
}

export function toolText(message: AgentMessage): string {
  const content = (message as { content: Array<{ type: string; text?: string }> }).content;
  return content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

export function sessionContext(directory: string, id = "session-a", overrides: Record<string, unknown> = {}): ExtensionContext {
  // Deliberately a unit-test double, NOT an OMP session or compatibility proof.
  return { sessionManager: { getSessionDir: () => directory, getSessionId: () => id, ...overrides } } as unknown as ExtensionContext;
}

export async function fakeApi(t: TestContext) {
  const root = await temporary(t);
  const agent = join(root, "profile-agent");
  await mkdir(agent);
  const tools: ToolDefinition<any, any>[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  let execCalls = 0;
  const Type = {
    String: (options = {}) => ({ type: "string", ...options }),
    Integer: (options = {}) => ({ type: "integer", ...options }),
    Optional: (schema: unknown) => schema,
    Object: (properties: unknown) => ({ type: "object", properties }),
  };
  const api = {
    pi: { getAgentDir: () => agent }, typebox: { Type },
    registerTool: (tool: ToolDefinition<any, any>) => tools.push(tool),
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    exec: () => { execCalls++; throw new Error("An observation extension must not execute commands"); },
  } as unknown as ExtensionAPI;
  return { root, agent, tools, handlers, api, execCalls: () => execCalls };
}
