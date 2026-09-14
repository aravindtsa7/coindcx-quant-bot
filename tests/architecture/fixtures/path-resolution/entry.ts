// [P14-J fixture] Exercises: extensionless relative import, `/index.ts`
// directory resolution, a re-export, and a type-only local import — the
// exact real-repo forms the scanner must resolve (§31).
import { extensionlessValue } from './extensionless-target';
import { folderTargetValue } from './folder-target';
import type { Thing } from './extensionless-target';
export * from './re-export';

export const entryValue: string = extensionlessValue + folderTargetValue;
export const entryThing: Thing | null = null;
