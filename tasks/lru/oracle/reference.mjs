// Reference implementation — proves the oracle is self-consistent. Never shown to agents.
export function createLRU(options) {
	const { capacity, ttlMs = Infinity, now = () => Date.now() } = options ?? {};

	if (!Number.isInteger(capacity) || capacity <= 0) {
		throw new RangeError("invalid capacity: must be a positive integer");
	}
	if (!(ttlMs === Infinity || (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0))) {
		throw new RangeError("invalid ttl: must be a positive number or Infinity");
	}

	// key -> { value, expiresAt }. Map iteration order is insertion order, and
	// re-inserting a key (delete then set) moves it to the end, so the map's
	// own order doubles as the recency order: front = least-recently-used.
	const store = new Map();

	function purge() {
		const t = now();
		for (const [key, entry] of store) {
			if (t > entry.expiresAt) store.delete(key);
		}
	}

	function touch(key, entry) {
		store.delete(key);
		store.set(key, entry);
	}

	const cache = {
		get(key) {
			purge();
			if (!store.has(key)) return undefined;
			const entry = store.get(key);
			touch(key, entry);
			return entry.value;
		},

		set(key, value) {
			purge();
			const expiresAt = now() + ttlMs;
			if (store.has(key)) {
				touch(key, { value, expiresAt });
				return cache;
			}
			if (store.size >= capacity) {
				const oldest = store.keys().next().value;
				store.delete(oldest);
			}
			store.set(key, { value, expiresAt });
			return cache;
		},

		has(key) {
			purge();
			return store.has(key);
		},

		delete(key) {
			purge();
			return store.delete(key);
		},

		clear() {
			store.clear();
		},

		get size() {
			purge();
			return store.size;
		},

		keys() {
			purge();
			return Array.from(store.keys());
		},
	};

	return cache;
}
