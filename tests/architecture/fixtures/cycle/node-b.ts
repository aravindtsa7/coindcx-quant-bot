// [P14-J fixture] The other half of the cycle — node-b imports back from node-a.
import type { NodeA } from './node-a';

export interface NodeB {
  readonly other: NodeA | null;
}
