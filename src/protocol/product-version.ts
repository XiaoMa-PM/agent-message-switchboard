// INPUT: The package.json at the repository root, which install copies into every bundle next to src/.
// OUTPUT: PRODUCT_VERSION, the one version msd status, the plugin manifests and the MCP client and server info report.
// POS: Single version source; read once, synchronously, when first imported.
import { readFileSync } from 'node:fs';

export const PRODUCT_VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string }).version;
