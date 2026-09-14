// [P14-J fixture] Proves the graph checker follows an INDIRECT (transitive)
// path, not just direct imports — execution-a never imports integration-c
// directly; it only imports shared-b, which imports integration-c.
import { sharedValue } from './shared-b';

export const executionAValue = sharedValue;
