# global

1 fact(s), 0 run(s) in history, 0 candidate(s). Runs: [[runs/2026-09-10T23-49-42]], [[runs/2026-09-12T00-56-28]], [[runs/2026-09-12T01-21-29]], [[runs/2026-09-12T05-30-35]].

## Facts

- [semantic] [run-analysis F4] bash call with no timeout: Agents issue bash tool calls without a timeout. (28 occurrences across 4 runs; proposed guard: tool_call edge (the bash-timeout guard extension, already built — this finding documents that the no-timeout behavior recurs 27+ times across 4 runs, so the guard must stay on by default, and extend the same rule to workers): for every bash call with no timeout, inject caps.bashTimeoutSec (90 s, clamp 600 s) and report guard:bash_timeout_rewritten.) (m_ab293c445cbd, conf 0.5, evidence: [[runs/2026-09-12T05-30-35]] [[runs/2026-09-10T23-49-42]] [[runs/2026-09-12T00-56-28]] [[runs/2026-09-12T01-21-29]])

## History

(no runs retained)

## Candidates

(none)
