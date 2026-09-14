// [P14-J fixture] Stands in for the P14-I composition root — a
// `src/integration/**` module reaching INTO `src/execution/**` core is the
// one intentional, allowed direction (§11/§29).
import { executionCoreValue } from './execution-core';

export const integrationRootValue = executionCoreValue;
