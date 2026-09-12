/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord, sha256 } from "./config.ts";

const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface ArchiveObject {
	readonly hash: string;
	readonly bytes: number;
	readonly chars: number;
	readonly lines: number;
	readonly path: string;
}

/**
 * root is config.storeRoot: <host session directory>/sol-omp/<session>/evidence-preserving-reducer.
 * Refuse redirected directories below the host-provided anchor, as ObservationPack does.
 * These checks are not an atomic sandbox against a malicious same-user process.
 */
async function ensureArchiveDirectories(root: string, objectDir: string): Promise<void> {
	if (!isAbsolute(root)) throw new Error("Reducer archive root is not absolute");
	for (const path of [dirname(dirname(root)), dirname(root), root, join(root, "objects"), objectDir]) {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
		}
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("Reducer archive contains a non-directory or a symbolic link");
		}
	}
}

/**
 * Store the raw observation under its own content hash before accepting a receipt.
 * An existing object with different bytes is an integrity failure, not a cache hit.
 */
export async function archiveBody(root: string, body: string): Promise<ArchiveObject> {
	const hash = sha256(body);
	const objectDir = join(root, "objects", hash.slice(0, 2));
	const path = join(objectDir, `${hash}.txt`);
	await ensureArchiveDirectories(root, objectDir);
	const bytes = Buffer.from(body, "utf8");
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, CREATE_OBJECT_FLAGS, 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		const existingHandle = await open(path, READ_OBJECT_FLAGS);
		try {
			const stat = await existingHandle.stat();
			if (!stat.isFile() || stat.size !== bytes.length) {
				throw new Error(`Reducer archive integrity failure: ${path}`);
			}
			const existing = await existingHandle.readFile();
			const existingText = existing.toString("utf8");
			if (!existing.equals(bytes) || existingText !== body || sha256(existingText) !== hash) {
				throw new Error(`Reducer archive integrity failure: ${path}`);
			}
			await existingHandle.sync();
		} finally {
			await existingHandle.close();
		}
	} finally {
		await handle?.close();
	}
	return {
		hash,
		bytes: bytes.length,
		chars: body.length,
		lines: body.length === 0 ? 0 : body.split("\n").length,
		path,
	};
}
