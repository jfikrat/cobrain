/**
 * Stem singleton reference.
 * Allows brain-loop to call stem.feedEvent() without circular imports.
 */

import type { Stem } from "../stem/stem.ts";

let _stem: Stem | null = null;

export const stemRef = {
  set: (s: Stem): void => { _stem = s; },
  get: (): Stem | null => _stem,
};
