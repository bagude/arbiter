// pi's thinking levels (cli/args.js VALID_THINKING_LEVELS). pi-subagents reads the same
// list minus "max" from a worker definition's `thinking:` line (src/config/thinking-level.ts)
// and silently drops an unknown value — so the worker's is checked here, loudly.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const WORKER_THINKING_LEVELS = THINKING_LEVELS.filter((l) => l !== "max");
