/**
 * Tests for the pi event wiring in advisor.ts — that each handler forwards the
 * event fields the runtime needs. The runtime itself is covered in
 * runtime.test.ts; these pin the glue between pi's event payloads and it.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerAdvisor from "../advisor.js";
import { CONFIG_FILENAME } from "../src/index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** Register the extension against a fake pi with a temp agent dir holding
 *  `config`, so the real user config is never read or written. */
async function withExtension(config: Record<string, unknown>, fn: (handlers: Map<string, Handler>) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-advisor-wiring-"));
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "extensions", CONFIG_FILENAME), JSON.stringify(config));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
		},
		registerCommand: () => {},
		sendMessage: vi.fn(),
	};
	try {
		registerAdvisor(pi as never);
		await fn(handlers);
	} finally {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, {});
		process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

function fakeCtx() {
	return {
		cwd: tmpdir(),
		signal: undefined,
		isProjectTrusted: () => false,
		modelRegistry: {
			// Unknown model: a scheduled review stops at model lookup, so `find`
			// being called is the observable "a review was requested" signal.
			find: vi.fn(() => undefined),
			getApiKeyAndHeaders: vi.fn(),
		},
	};
}

describe("advisor.ts input wiring", () => {
	it("forwards event.source so extension-injected input never schedules a review", async () => {
		await withExtension({ advisorModel: "fake/advisor", triggers: ["input"] }, async (handlers) => {
			const input = handlers.get("input")!;
			const ctx = fakeCtx();
			await input({ type: "input", text: "<advisory>delivered</advisory>", source: "extension" }, ctx);
			expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
			await input({ type: "input", text: "real prompt", source: "interactive" }, ctx);
			expect(ctx.modelRegistry.find).toHaveBeenCalledTimes(1);
		});
	});
});
