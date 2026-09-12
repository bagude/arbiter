`topoSort(nodes, edges)`, `layers(nodes, edges)`, and `findCycle(nodes, edges)` compute topological structure over a directed graph. `nodes` is an array of unique strings. `edges` is an array of `[from, to]` pairs meaning `from` must come **before** `to`.

## Validation (all three functions)

Walk `nodes` in order, then `edges` in order, and validate as you go:
1. Each node must be a string. Otherwise throw `TypeError` starting with `node must be a string`.
2. Each node must not have appeared already. Otherwise throw `RangeError` starting with `duplicate node: <name>`.
3. Each edge's `from` and `to` (checking `from` first) must appear in `nodes`. Otherwise throw `RangeError` starting with `unknown node: <name>`.

The first violation found, in that walk order, is the one thrown. Self-edges (`["a","a"]`) are structurally valid — they form a 1-node cycle (see below). Duplicate edges (identical `[from, to]` pairs, however many times repeated) are allowed and must not affect any result. Empty `nodes` with empty `edges` is valid: `topoSort` and `layers` return `[]`; `findCycle` returns `null`.

## `topoSort(nodes, edges)`

Returns an array containing every node exactly once, in a valid topological order, computed with **Kahn's algorithm**: maintain the set of "available" nodes — those with in-degree 0 among nodes not yet emitted. Repeatedly remove the **lexicographically smallest** (plain `<` on strings) available node, append it to the result, decrement the in-degree of each of its direct successors, and add any successor whose in-degree just reached 0 to the available set. Nodes that never appear in any edge become available immediately and are ordered by this same rule. This makes the result fully deterministic: every correct implementation returns the same array for the same input.

If the graph is cyclic, throw `Error` whose message is `cycle: ` followed by `findCycle(nodes, edges)`'s result joined with ` -> ` (see below for the exact array).

## `layers(nodes, edges)`

Returns an array of arrays partitioning every node into layers. Layer 0 is every node with no prerequisites (no incoming edges). Layer `k` (`k > 0`) is every node whose prerequisites are all in layers `< k`, with at least one prerequisite in layer `k - 1` exactly. Equivalently: repeatedly take the set of not-yet-placed nodes whose in-degree (counting only not-yet-placed predecessors) is 0 as the next layer, then remove them. Each layer is sorted lexicographically in the output. Throws the same `cycle: ` error as `topoSort` when the graph is cyclic.

## `findCycle(nodes, edges)`

Returns `null` if the graph is acyclic. Otherwise returns an array of node names describing one cycle, with the first node repeated as the last element (e.g. `["a", "b", "c", "a"]` for `a -> b -> c -> a`). A self-edge produces a length-1 cycle, e.g. `["a", "a"]`.

The cycle is chosen deterministically by depth-first search: visit not-yet-started nodes in **lexicographic order**, and from each node visit its direct successors in **lexicographic order**. The first time this search follows an edge into a node that is still on the current DFS stack, that closes a cycle: take the stack from that node onward (inclusive) as the cycle, in edge-following order, then close it by repeating the first of those nodes at the end. Finally, rotate the cycle (without reversing or reordering the edges) so that it starts at its lexicographically smallest node, and repeat that node at the end instead. Nodes outside every cycle (even ones that lead into one) never appear in the returned cycle.

## Examples

- `topoSort(["b","a"], [["a","b"]])` → `["a","b"]`
- `topoSort(["a","b","c"], [])` → `["a","b","c"]` (no edges: pure lexicographic order)
- `layers(["a","b","c"], [["a","c"],["b","c"]])` → `[["a","b"],["c"]]`
- `findCycle(["a","b"], [["a","b"],["b","a"]])` → `["a","b","a"]`
- `findCycle(["a"], [["a","a"]])` → `["a","a"]`
