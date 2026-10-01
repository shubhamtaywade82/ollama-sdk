/**
 * Loads and parses every overlay YAML file in `contracts/overlays/`.
 * Used by the CLI's validate path; the normalizer has its own inline loader
 * because it also needs the raw file contents (for the source hash).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import * as yaml from 'js-yaml';

import type { OverlayDomain } from './overlay-schema.js';

const OVERLAY_DIR = 'contracts/overlays';

export interface LoadedOverlay {
  readonly file: string;
  readonly domain: OverlayDomain;
}

/** Read every overlay file under {@link OVERLAY_DIR}. */
export function readOverlaysForValidation(projectRoot: string): readonly LoadedOverlay[] {
  const dir = resolve(projectRoot, OVERLAY_DIR);
  const files = readdirSync(dir).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));
  return files.map((file) => {
    const path = join(dir, file);
    const raw = readFileSync(path, 'utf8');
    const domain = yaml.load(raw) as OverlayDomain;
    return { file: basename(file), domain };
  });
}
