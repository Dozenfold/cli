#!/usr/bin/env node
import {
  injectSourceMapDebugIds,
  runSourceMapCommand,
  SourceMapCliError,
} from '../src/source-maps.mjs';

const USAGE = `Usage:
  dozenfold source-maps upload --manifest <path> --shop <shop> [--release <id>] [--endpoint <url>] [--json]
  dozenfold source-maps verify --manifest <path> --shop <shop> [--release <id>] [--endpoint <url>] [--cdn] [--json]
  dozenfold source-maps inject --manifest <path> [--json]

Authentication:
  Set DOZENFOLD_SOURCE_MAP_TOKEN to a shop-scoped source-map credential.
`;

function parseArgs(argv) {
  if (argv[0] !== 'source-maps' || !['upload', 'verify', 'inject'].includes(argv[1])) {
    throw new SourceMapCliError(USAGE.trim());
  }
  const options = { command: argv[1], json: false, cdn: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--cdn') {
      options.cdn = true;
      continue;
    }
    if (!['--manifest', '--shop', '--release', '--endpoint'].includes(arg)) {
      throw new SourceMapCliError(`Unknown option: ${arg}\n\n${USAGE.trim()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new SourceMapCliError(`Missing value for ${arg}.`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  if (!options.manifest || (options.command !== 'inject' && !options.shop)) {
    throw new SourceMapCliError(USAGE.trim());
  }
  if (options.cdn && options.command !== 'verify') {
    throw new SourceMapCliError('--cdn is supported only by source-maps verify.');
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'inject') {
    const prepared = await injectSourceMapDebugIds(options.manifest);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(prepared)}\n`
        : `Injected debug IDs into ${prepared.artifact_count} bundle/map pair(s).\n`,
    );
  } else {
    const result = await runSourceMapCommand({
      ...options,
      manifestPath: options.manifest,
      endpoint:
        options.endpoint || process.env.DOZENFOLD_ENDPOINT || 'https://ingest.dozenfold.com',
      token: process.env.DOZENFOLD_SOURCE_MAP_TOKEN,
      verifyCdn: options.cdn,
      onArtifact: options.json
        ? undefined
        : (artifact, current, total) => {
            process.stdout.write(
              `[${current}/${total}] ${artifact.status} ${artifact.minified_url}\n`,
            );
          },
    });
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `${result.command === 'upload' ? 'Uploaded and verified' : 'Verified'} ${result.artifact_count} source-map artifact(s) for ${result.release}.\n`,
      );
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown source-map CLI failure.';
  process.stderr.write(`Dozenfold source-map error: ${message}\n`);
  process.exitCode = error instanceof SourceMapCliError ? error.exitCode : 1;
}
