/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { DIAGNOSTIC_COMMAND, isRecord, recordValue } from "./config.ts";

export interface ReducerToolResult {
	readonly toolName: string;
	readonly input: unknown;
	readonly content: unknown;
	readonly details?: unknown;
	readonly isError: boolean;
}

export interface ReducibleToolResult {
	readonly command: string;
	readonly body: string;
}

/**
 * Only the actual plain-text OMP bash observation is eligible. Never follow a
 * fullOutputPath or an inline Pi temporary-file reference, discard mixed content,
 * or interpret native eval/edit/write as Action Fusion's unsupported then_run.
 */
export function reducibleToolResult(event: ReducerToolResult): ReducibleToolResult | undefined {
	if (event.toolName !== "bash") return undefined;
	const command = recordValue(event.input, "command");
	if (typeof command !== "string" || !command || !DIAGNOSTIC_COMMAND.test(command)) return undefined;
	if (!Array.isArray(event.content) || event.content.length === 0) return undefined;
	const content = event.content;
	if (!content.every((item): item is { type: "text"; text: string } =>
		isRecord(item) && item.type === "text" && typeof item.text === "string")) return undefined;
	return { command, body: content.map(item => item.text).join("\n") };
}
