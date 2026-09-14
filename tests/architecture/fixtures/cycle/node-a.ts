// [P14-J fixture] Import cycle: node-a <-> node-b. Proves the graph
// traversal is cycle-safe (visited-set-gated) and never infinite-loops (§30).
// No production cycle is introduced anywhere by this fixture.
import type { NodeB } from './node-b';

export interface NodeA {
  readonly other: NodeB | null;
}
