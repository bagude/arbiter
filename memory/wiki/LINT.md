# LINT — 2026-09-12T21:35:04.089Z

21 finding(s): 20 to rule on, 1 informational.

## Rule on these

- **unbacked-promotion** m_b451874cbb68 ([[scopes/global]]) — promoted agent record without oracle evidence: [run-analysis F1] silent turn: text generated but never sent: An agent turn produces assistant text 
- **unbacked-promotion** m_ab293c445cbd ([[scopes/global]]) — promoted agent record without oracle evidence: [run-analysis F4] bash call with no timeout: Agents issue bash tool calls without a timeout. (28 occ
- **unbacked-promotion** m_77f5996c5c86 ([[scopes/global]]) — promoted agent record without oracle evidence: [run-analysis F5] done re-claim with unchanged failing oracle verdict: The agent claims done (kind=d
- **unbacked-promotion** m_48dfb2112cbc ([[scopes/global]]) — promoted agent record without oracle evidence: [run-analysis F6] file re-read in small offset/limit slices (incl. exact repeat of a range): read to
- **unbacked-promotion** m_8822c0fb9f26 ([[scopes/task-bucket]]) — promoted agent record without oracle evidence: Supervisor probe scripts run in a sandboxed non-module eval (no import statements, no require, no Nu
- **unbacked-promotion** m_482121f731f9 ([[scopes/task-mdtable]]) — promoted agent record without oracle evidence: Supervisor probes require an explicit "fn" field per case ("renderTable" or "parseTable") and suppor
- **unbacked-promotion** m_ce408fac0b17 ([[scopes/task-tmpl]]) — promoted agent record without oracle evidence: Supervisor probes for render(template, data) require both args present (pass {} for data when testin
- **unbacked-promotion** m_de2f7c2570c0 ([[scopes/task-review-guard]]) — promoted agent record without oracle evidence: Keep src/ files-only: the host-side probe runner crashes with EISDIR when a directory (e.g. a juncti
- **unbacked-promotion** m_36438949544b ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R1] false_negative (bash {"command":"cat .PI/agents/worker.md"}): On Windows the files
- **unbacked-promotion** m_bdeb21f26749 ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R2] false_negative (bash {"command":"ls /"}): A bare '/' is deliberately 'left alone' 
- **unbacked-promotion** m_a6f89a2e47a5 ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R3] false_negative (bash {"command":"type \\\\server\\share\\flag.txt"}): No pattern i
- **unbacked-promotion** m_69be6e694f9e ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R4] false_negative (bash {"command":"type %USERNAME%\\Desktop\\note.txt"}): The policy
- **unbacked-promotion** m_a33e82effc7c ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R5] false_positive (bash {"command":"cd src && cat ../README.md"}): 'cd src && cat ../
- **unbacked-promotion** m_56ed7fbe822f ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R6] false_positive (bash {"command":"grep -rn \".pi\" src/"}): PROTECTED_IN_BASH match
- **unbacked-promotion** m_c8821556908b ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R7] false_negative (bash {"command":"ls .pi*"}): The protected-dir rule requires a lit
- **unbacked-promotion** m_c0b5acee8f15 ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard R8] false_negative (read {"path":"src/notes/link-out"}): decidePath is pure string log
- **unbacked-promotion** m_bf121c5ff86f ([[scopes/global]]) — promoted agent record without oracle evidence: [review-guard recommendation] R1 is the single most important fix: PROTECTED_IN_BASH is a one-charac
- **unbacked-promotion** m_3ee3736af8d9 ([[scopes/repo-data-warehousers]]) — promoted agent record without oracle evidence: dw-explore: serialize observation results programmatically from the exact cited query (script runs t
- **unbacked-promotion** m_94e2c8699f08 ([[scopes/repo-data-warehousers]]) — promoted agent record without oracle evidence: dw-explore: a single worker given (a) the explicit list of already-covered observation titles, (b) t
- **unbacked-promotion** m_c1c1e2fe9107 ([[scopes/repo-data-warehousers]]) — promoted agent record without oracle evidence: dw-explore: graded observation queries must ORDER BY a unique tie-breaker (e.g. the entity key) — a 

## For information

- **scope-without-runs** ([[scopes/global]]) — no episodic record: nothing here has been tried in a run
