// Fixed shapes for the run patterns arbiter supports: which roles exist, what tools
// each role gets, who each role's peer is (used as PEER in the child's env), which
// prompt file backs each role, and which role's approval is the trigger for the
// oracle (null for solo, where the builder's own done is the trigger instead).
export const BUILDER_TOOLS = "read,bash,edit,write,ls,grep,find,send_mail,context_usage";
export const ORCHESTRATOR_TOOLS = "read,ls,grep,send_mail,subagent,steer_subagent,get_subagent_result,memory_search,memory_get,recall_result,checkpoint,context_usage";
export const WORKER_TOOLS = ["read", "bash", "edit", "write", "ls", "grep", "find", "memory_search", "memory_get", "remember", "recall_result", "context_usage"];

export const PATTERNS = {
	dyad: {
		roles: ["builder", "critic"],
		tools: { builder: BUILDER_TOOLS, critic: "send_mail,context_usage" },
		peer: { builder: "critic", critic: "builder" },
		prompt: { builder: "builder.md", critic: "critic.md" },
		verifier: "critic",
	},
	solo: {
		roles: ["builder"],
		tools: { builder: BUILDER_TOOLS },
		peer: { builder: "supervisor" },
		prompt: { builder: "builder-solo.md" },
		verifier: null,
	},
	orchestrator: {
		roles: ["orchestrator", "worker"],
		tools: { orchestrator: ORCHESTRATOR_TOOLS },
		peer: { orchestrator: "supervisor" },
		prompt: { orchestrator: "orchestrator.md", worker: "worker.md" },
		verifier: "orchestrator",
	},
};
