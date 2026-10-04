import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runSourceMapCommand } from './src/source-maps.mjs';

function input(name, required = false) {
  const value = process.env[`INPUT_${name.replaceAll('-', '_').toUpperCase()}`]?.trim() || '';
  if (required && !value) throw new Error(`Missing required action input: ${name}`);
  return value;
}

async function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const delimiter = `dozenfold_${randomUUID()}`;
  await appendFile(path, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, { encoding: 'utf8' });
}

try {
  const command = input('command') || 'upload';
  const verifyCdn = input('verify-cdn') === 'true';
  if (verifyCdn && command !== 'verify') {
    throw new Error('verify-cdn requires command: verify');
  }
  const result = await runSourceMapCommand({
    command,
    manifestPath: input('manifest', true),
    shop: input('shop', true),
    release: input('release') || undefined,
    endpoint: input('endpoint') || 'https://ingest.dozenfold.com',
    token: input('token', true),
    verifyCdn,
    onArtifact: (artifact, current, total) => {
      process.stdout.write(`[${current}/${total}] ${artifact.status} ${artifact.minified_url}\n`);
    },
  });
  await output('release', result.release);
  await output('artifact-count', String(result.artifact_count));
  process.stdout.write(
    `${result.command === 'upload' ? 'Uploaded and verified' : 'Verified'} ${result.artifact_count} source-map artifact(s) for ${result.release}.\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown source-map action failure.';
  process.stderr.write(
    `::error title=Dozenfold source maps::${message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`,
  );
  process.exitCode = 1;
}
