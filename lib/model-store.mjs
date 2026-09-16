// pi's model store, read-only: which provider/model ids exist and their context
// windows, so config.mjs can preflight a role's model before spawning a process
// (today an unknown model only fails after the pi child boots, as a model_error
// audit line on the first turn).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const norm = (p) => p.replace(/\\/g, "/");

export function defaultModelStorePaths(env = process.env) {
	const home = os.homedir();
	return {
		store: env.ARBITER_MODEL_STORE || path.join(home, ".pi", "agent", "models-store.json"),
		overrides: env.ARBITER_MODEL_OVERRIDES || path.join(home, ".pi", "agent", "models.json"),
	};
}

function readJson(filePath) {
	let text;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined; // missing file: skipped, not an error
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`malformed model store JSON at ${norm(filePath)}: ${err.message}`);
	}
}

export function loadModelStore({ storePath, overridesPath }) {
	const available = new Map();
	const source = [];

	const storeData = readJson(storePath);
	if (storeData !== undefined) {
		source.push(norm(storePath));
		for (const [provider, entry] of Object.entries(storeData ?? {})) {
			for (const m of entry?.models ?? []) {
				if (!m?.id) continue;
				available.set(`${provider}/${m.id}`, { provider, id: m.id, contextWindow: m.contextWindow ?? null });
			}
		}
	}

	const overridesData = readJson(overridesPath);
	if (overridesData !== undefined) {
		source.push(norm(overridesPath));
		for (const [provider, entry] of Object.entries(overridesData?.providers ?? {})) {
			for (const id of Object.keys(entry?.modelOverrides ?? {})) {
				const key = `${provider}/${id}`;
				if (!available.has(key)) available.set(key, { provider, id, contextWindow: null });
			}
			for (const m of entry?.models ?? []) {
				if (!m?.id) continue;
				const key = `${provider}/${m.id}`;
				if (!available.has(key)) available.set(key, { provider, id: m.id, contextWindow: m.contextWindow ?? null });
			}
		}
	}

	return { available, source };
}

export function preflightRoles(roles, store) {
	const missing = [];
	const providers = [...new Set([...store.available.values()].map((e) => e.provider))].sort();
	for (const [name, role] of Object.entries(roles)) {
		const key = `${role.provider}/${role.model}`;
		const entry = store.available.get(key);
		role.contextWindow = entry ? entry.contextWindow : null;
		if (!entry) {
			const ids = [...store.available.values()]
				.filter((e) => e.provider === role.provider)
				.map((e) => e.id)
				.sort();
			const avail = ids.length ? ids.join(", ") : `no models for provider "${role.provider}" (known: ${providers.join(", ")})`;
			missing.push(`roles.${name} names "${key}" but pi has no such model; available for ${role.provider}: ${avail}`);
		}
	}
	return { roles, missing };
}
