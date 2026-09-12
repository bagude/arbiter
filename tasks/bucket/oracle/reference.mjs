// Reference implementation — proves the oracle is self-consistent. Never shown to agents.
const EPS = 1e-9;

function isFiniteNumber(x) {
	return typeof x === "number" && Number.isFinite(x);
}

function checkTime(state, atMs) {
	if (state.lastMs !== null && atMs < state.lastMs) {
		throw new RangeError(`time went backwards: ${atMs} < ${state.lastMs}`);
	}
}

function refill(state, atMs) {
	checkTime(state, atMs);
	if (state.lastMs !== null) {
		const elapsedSeconds = (atMs - state.lastMs) / 1000;
		state.tokens = Math.min(state.capacity, state.tokens + elapsedSeconds * state.refillPerSecond);
	}
	state.lastMs = atMs;
}

function validateAmount(n) {
	if (!isFiniteNumber(n) || n <= 0) {
		throw new RangeError(`invalid amount: ${JSON.stringify(n)} must be a positive finite number`);
	}
}

export function createBucket(options) {
	const { capacity, refillPerSecond, initial = capacity } = options ?? {};

	if (!isFiniteNumber(capacity) || capacity <= 0) {
		throw new RangeError(`invalid capacity: ${JSON.stringify(capacity)} must be a positive finite number`);
	}
	if (!isFiniteNumber(refillPerSecond) || refillPerSecond < 0) {
		throw new RangeError(`invalid refill: ${JSON.stringify(refillPerSecond)} must be a non-negative finite number`);
	}
	if (!isFiniteNumber(initial) || initial < 0 || initial > capacity) {
		throw new RangeError(`invalid initial: ${JSON.stringify(initial)} must be within [0, capacity]`);
	}

	const state = { capacity, refillPerSecond, tokens: initial, lastMs: null };

	return {
		take(n = 1, atMs) {
			validateAmount(n);
			refill(state, atMs);
			if (state.tokens + EPS >= n) {
				state.tokens = Math.max(0, state.tokens - n);
				return true;
			}
			return false;
		},
		available(atMs) {
			refill(state, atMs);
			return state.tokens;
		},
		timeUntil(n, atMs) {
			validateAmount(n);
			refill(state, atMs);
			if (n > state.capacity) return Infinity;
			if (state.tokens + EPS >= n) return 0;
			if (state.refillPerSecond === 0) return Infinity;
			const needed = n - state.tokens;
			return (needed / state.refillPerSecond) * 1000;
		},
		reset(atMs) {
			checkTime(state, atMs);
			state.tokens = state.capacity;
			state.lastMs = atMs;
		},
	};
}
