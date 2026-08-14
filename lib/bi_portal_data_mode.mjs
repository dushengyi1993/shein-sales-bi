import path from 'node:path';

const VALID_DATA_MODES = new Set(['api', 'legacy']);

function normalizeMode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePath(value, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.resolve(String(value || '.'));
}

/**
 * Resolve the Portal data mode without allowing an omitted production flag to
 * downgrade the formal cloud core from API sections to a legacy monolith.
 * Explicit CLI or environment choices remain authoritative so local/static
 * legacy generation stays available.
 */
export function resolveBiPortalDataMode({
  cliMode = '',
  envMode = '',
  root = process.cwd(),
  outDir = '',
  platform = process.platform,
  productionRoot = '/opt/shein-bi/app',
} = {}) {
  const cli = normalizeMode(cliMode);
  const env = normalizeMode(envMode);
  if (cli && !VALID_DATA_MODES.has(cli)) throw new Error(`Invalid --data-mode: ${cli}`);
  if (env && !VALID_DATA_MODES.has(env)) throw new Error(`Invalid --data-mode: ${env}`);

  const normalizedProductionRoot = normalizePath(productionRoot, platform);
  const normalizedRoot = normalizePath(root, platform);
  const normalizedOutDir = normalizePath(outDir, platform);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const formalOutput = pathApi.join(normalizedProductionRoot, 'outputs', 'bi-portal');
  const formalCloud = platform !== 'win32'
    && normalizedRoot === normalizedProductionRoot
    && normalizedOutDir === formalOutput;

  let mode;
  let source;
  if (formalCloud) {
    // Environment is inherited across recovery shells, and cloud wrappers may
    // reify it as --data-mode. Neither path may downgrade the formal core.
    // A legacy diagnostic must target a separate, non-formal output directory.
    mode = 'api';
    source = cli === 'legacy' || (!cli && env === 'legacy')
      ? 'formal-cloud-guard'
      : cli ? 'cli' : env ? 'env' : 'formal-cloud-default';
  } else if (cli) {
    mode = cli;
    source = 'cli';
  } else {
    mode = env || 'legacy';
    source = env ? 'env' : 'default';
  }
  return {mode, source};
}
