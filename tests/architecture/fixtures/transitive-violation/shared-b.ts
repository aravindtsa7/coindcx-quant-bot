// [P14-J fixture] The indirect hop: shared-b has no idea it's "in execution" —
// it just imports integration-c directly.
import { integrationCValue } from './integration-c';

export const sharedValue = integrationCValue;
