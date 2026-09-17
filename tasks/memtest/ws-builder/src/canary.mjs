/**
 * Return the canary token stored in the arbiter's memory.
 *
 * The token is not in this repository. Fetch it with `memory_search` +
 * `memory_get` and return it here exactly as it appears in the record body.
 */
export function canary() {
	throw new Error("not implemented: fetch the canary token from memory");
}
