import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { afterEach, test } from 'node:test';
import {
  canonicalizeMinifiedUrl,
  injectSourceMapDebugIds,
  loadSourceMapManifest,
  normalizeEndpoint,
  runSourceMapCommand,
} from '../src/source-maps.mjs';

const TOKEN = `df_sm_v1_${'a'.repeat(48)}`;
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture({
  release = 'theme-2026-09-02',
  url = 'https://cdn.shopify.com/s/files/app.js?v=7',
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dozenfold-cli-'));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, 'app.js'),
    'console.log("fixture");\n//# sourceMappingURL=app.js.map\n',
  );
  await writeFile(
    join(directory, 'app.js.map'),
    JSON.stringify(
      {
        version: 3,
        file: 'app.js',
        sources: ['src/app.ts'],
        sourcesContent: ['console.log("fixture");'],
        names: [],
        mappings: 'AAAA',
      },
      null,
      2,
    ),
  );
  const manifest = join(directory, 'dozenfold-source-maps.json');
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      release,
      artifacts: [{ minified_url: url, minified_file: 'app.js', source_map: 'app.js.map' }],
    }),
  );
  return { directory, manifest };
}

test('loads a bounded manifest and computes deterministic bundle/map digests', async () => {
  const { manifest } = await fixture();
  const loaded = await loadSourceMapManifest(manifest);

  assert.equal(loaded.release, 'theme-2026-09-02');
  assert.equal(loaded.artifacts[0].minified_url, 'https://cdn.shopify.com/s/files/app.js');
  assert.match(loaded.artifacts[0].minified_digest, /^[a-f0-9]{64}$/);
  assert.match(loaded.artifacts[0].source_map_digest, /^[a-f0-9]{64}$/);
  assert.ok(loaded.artifacts[0].source_map_byte_size > 0);
});

test('injects one idempotent debug ID into a bundle, shifted map, and version 2 manifest', async () => {
  const { directory, manifest } = await fixture();
  const first = await injectSourceMapDebugIds(manifest);
  assert.equal(first.status, 'prepared');
  assert.equal(first.artifact_count, 1);
  assert.match(first.debug_ids[0], /^[0-9a-f-]{36}$/);

  const bundleAfterFirst = await readFile(join(directory, 'app.js'), 'utf8');
  const mapAfterFirst = JSON.parse(await readFile(join(directory, 'app.js.map'), 'utf8'));
  const manifestAfterFirst = JSON.parse(await readFile(manifest, 'utf8'));
  assert.match(bundleAfterFirst.split('\n')[0], new RegExp(`debugId=${first.debug_ids[0]}`));
  assert.equal(mapAfterFirst.debug_id, first.debug_ids[0]);
  assert.equal(mapAfterFirst.mappings, ';AAAA');
  assert.equal(manifestAfterFirst.version, 2);
  assert.equal(manifestAfterFirst.artifacts[0].debug_id, first.debug_ids[0]);

  const runtime = {
    URL,
    location: { href: 'https://shop.example/' },
    document: { currentScript: null },
    Error: class extends Error {
      stack = 'Error\n    at https://cdn.shopify.com/s/files/app.js?v=7:1:1';
    },
  };
  runInNewContext(bundleAfterFirst.split('\n')[0], runtime);
  assert.equal(
    runtime.__DOZENFOLD_DEBUG_IDS__['https://cdn.shopify.com/s/files/app.js'],
    first.debug_ids[0],
  );

  const second = await injectSourceMapDebugIds(manifest);
  assert.deepEqual(second.debug_ids, first.debug_ids);
  assert.equal(await readFile(join(directory, 'app.js'), 'utf8'), bundleAfterFirst);
  assert.equal(JSON.parse(await readFile(join(directory, 'app.js.map'), 'utf8')).mappings, ';AAAA');
  const loaded = await loadSourceMapManifest(manifest);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.artifacts[0].debug_id, first.debug_ids[0]);
});

test('rejects insecure endpoints, duplicate canonical URLs, and invalid maps before networking', async () => {
  assert.throws(() => normalizeEndpoint('http://ingest.example.com'), /must use HTTPS/);
  assert.equal(normalizeEndpoint('http://127.0.0.1:3001/'), 'http://127.0.0.1:3001');
  assert.equal(
    canonicalizeMinifiedUrl('https://cdn.example.com/app.js?signature=secret#fragment'),
    'https://cdn.example.com/app.js',
  );

  const { directory, manifest } = await fixture();
  const raw = JSON.parse(await readFile(manifest, 'utf8'));
  raw.artifacts.push({
    minified_url: 'https://cdn.shopify.com/s/files/app.js?v=999',
    minified_file: 'app.js',
    source_map: 'app.js.map',
  });
  await writeFile(manifest, JSON.stringify(raw));
  await assert.rejects(loadSourceMapManifest(manifest), /duplicates canonical minified_url/);

  raw.artifacts.length = 1;
  await writeFile(join(directory, 'app.js.map'), JSON.stringify({ version: 3, mappings: '' }));
  await writeFile(manifest, JSON.stringify(raw));
  await assert.rejects(loadSourceMapManifest(manifest), /neither mappings nor indexed sections/);
});

test('uploads and then verifies exact object-derived digest and size', async () => {
  const { manifest } = await fixture();
  const requests = [];
  let stored = null;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      const loaded = await loadSourceMapManifest(manifest);
      stored = {
        status: 'ready',
        release: body.release,
        minified_url: loaded.artifacts[0].minified_url,
        digest: loaded.artifacts[0].source_map_digest,
        byte_size: loaded.artifacts[0].source_map_byte_size,
        outcome: 'created',
      };
      return Response.json(stored);
    }
    return Response.json({
      ...stored,
      uploaded_at: '2026-09-02T00:00:00.000Z',
      expires_at: '2027-03-01T00:00:00.000Z',
    });
  };

  const result = await runSourceMapCommand({
    command: 'upload',
    manifestPath: manifest,
    shop: 'fixture.myshopify.com',
    endpoint: 'https://ingest.dozenfold.com',
    token: TOKEN,
    transport: { fetchImpl },
  });

  assert.equal(requests.length, 2);
  assert.equal(result.status, 'ready');
  assert.equal(result.artifact_count, 1);
  assert.equal(result.artifacts[0].outcome, 'created');
  assert.equal(result.artifacts[0].expires_at, '2027-03-01T00:00:00.000Z');
});

test('verifies the deployed CDN bytes against the injected bundle and stored metadata', async () => {
  const { directory, manifest } = await fixture();
  await injectSourceMapDebugIds(manifest);
  const loaded = await loadSourceMapManifest(manifest);
  const artifact = loaded.artifacts[0];
  const bundle = await readFile(join(directory, 'app.js'));
  const fetchImpl = async (url) => {
    if (String(url).includes('/source-maps/status?')) {
      return Response.json({
        status: 'ready',
        release: loaded.release,
        minified_url: artifact.minified_url,
        digest: artifact.source_map_digest,
        byte_size: artifact.source_map_byte_size,
        debug_id: artifact.debug_id,
        minified_digest: artifact.minified_digest,
      });
    }
    return new Response(bundle, {
      status: 200,
      headers: { 'content-length': String(bundle.length) },
    });
  };

  const result = await runSourceMapCommand({
    command: 'verify',
    manifestPath: manifest,
    shop: 'fixture.myshopify.com',
    endpoint: 'https://ingest.dozenfold.com',
    token: TOKEN,
    verifyCdn: true,
    transport: { fetchImpl },
  });
  assert.equal(result.artifacts[0].cdn_verified, true);

  await assert.rejects(
    runSourceMapCommand({
      command: 'verify',
      manifestPath: manifest,
      shop: 'fixture.myshopify.com',
      endpoint: 'https://ingest.dozenfold.com',
      token: TOKEN,
      verifyCdn: true,
      transport: {
        fetchImpl: async (url) =>
          String(url).includes('/source-maps/status?')
            ? fetchImpl(url)
            : new Response('different deployed bytes'),
      },
    }),
    /CDN bundle digest does not match/,
  );
});

test('fails closed when status is missing or has digest drift', async () => {
  const { manifest } = await fixture();
  await assert.rejects(
    runSourceMapCommand({
      command: 'verify',
      manifestPath: manifest,
      shop: 'fixture.myshopify.com',
      endpoint: 'https://ingest.dozenfold.com',
      token: TOKEN,
      transport: { fetchImpl: async () => Response.json({ status: 'missing' }) },
    }),
    /not ready/,
  );

  await assert.rejects(
    runSourceMapCommand({
      command: 'verify',
      manifestPath: manifest,
      shop: 'fixture.myshopify.com',
      endpoint: 'https://ingest.dozenfold.com',
      token: TOKEN,
      transport: {
        fetchImpl: async () =>
          Response.json({
            status: 'ready',
            release: 'theme-2026-09-02',
            minified_url: 'https://cdn.shopify.com/s/files/app.js',
            digest: '0'.repeat(64),
            byte_size: 1,
          }),
      },
    }),
    /verification drift/,
  );
});

test('bounds server errors and redacts the credential even if an upstream reflects it', async () => {
  const { manifest } = await fixture();
  let message = '';
  try {
    await runSourceMapCommand({
      command: 'verify',
      manifestPath: manifest,
      shop: 'fixture.myshopify.com',
      endpoint: 'https://ingest.dozenfold.com',
      token: TOKEN,
      transport: {
        fetchImpl: async () =>
          Response.json({ error: `bad credential ${TOKEN} ${'x'.repeat(500)}` }, { status: 401 }),
      },
    });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /\[REDACTED\]/);
  assert.doesNotMatch(message, new RegExp(TOKEN));
  assert.ok(message.length < 260);
});

test('GitHub Action wrapper uploads, verifies, emits outputs, and never prints its token', async () => {
  const { directory, manifest } = await fixture();
  const outputPath = join(directory, 'github-output.txt');
  let stored = null;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const loaded = await loadSourceMapManifest(manifest);
      stored = {
        status: 'ready',
        outcome: 'created',
        release: body.release,
        minified_url: loaded.artifacts[0].minified_url,
        digest: loaded.artifacts[0].source_map_digest,
        byte_size: loaded.artifacts[0].source_map_byte_size,
      };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(stored));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const child = spawn(process.execPath, [new URL('../action.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      INPUT_COMMAND: 'upload',
      INPUT_MANIFEST: manifest,
      INPUT_SHOP: 'fixture.myshopify.com',
      INPUT_TOKEN: TOKEN,
      INPUT_ENDPOINT: `http://127.0.0.1:${address.port}`,
      GITHUB_OUTPUT: outputPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit));
  server.close();

  assert.equal(exitCode, 0, stderr);
  assert.doesNotMatch(`${stdout}${stderr}`, new RegExp(TOKEN));
  const outputs = await readFile(outputPath, 'utf8');
  assert.match(outputs, /release<<dozenfold_/);
  assert.match(outputs, /theme-2026-09-02/);
  assert.match(outputs, /artifact-count<<dozenfold_/);
  assert.match(outputs, /\n1\n/);
});

test('custom site source-map access preserves the opaque identifier', async () => {
  const { manifest } = await fixture();
  const site = 'site_3905fd50-d21c-4c22-adfc-541b640598dc';
  let called = false;
  await assert.rejects(
    runSourceMapCommand({
      command: 'upload',
      manifestPath: manifest,
      shop: site,
      endpoint: 'https://ingest.dozenfold.com',
      token: TOKEN,
      transport: {
        fetchImpl: async (url) => {
          called = true;
          assert.equal(new URL(url).pathname, `/v1/shops/${site}/source-maps`);
          return Response.json({ error: 'test stop' }, { status: 403 });
        },
      },
    }),
    /403/,
  );
  assert.equal(called, true);
});

test('source-map access rejects path injection in a custom identifier', async () => {
  const { manifest } = await fixture();
  await assert.rejects(
    runSourceMapCommand({
      command: 'upload',
      manifestPath: manifest,
      shop: 'site_a/other',
      endpoint: 'https://ingest.dozenfold.com',
      token: TOKEN,
    }),
    /valid hostname or custom site identifier/,
  );
});

for (const shop of ['fixture.myshopify.com', 'site_3905fd50-d21c-4c22-adfc-541b640598dc']) {
  test(`real CLI uploads and verifies the supplied manifest for ${shop}`, async () => {
    const { manifest } = await fixture();
    const loaded = await loadSourceMapManifest(manifest);
    let writes = 0;
    let reads = 0;
    const server = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.ok(request.url.startsWith(`/v1/shops/${shop}/source-maps`));
      if (request.method === 'PUT') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.equal(JSON.parse(Buffer.concat(chunks)).release, 'landing-override');
        writes++;
      } else reads++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          status: 'ready',
          release: 'landing-override',
          minified_url: loaded.artifacts[0].minified_url,
          digest: loaded.artifacts[0].source_map_digest,
          byte_size: loaded.artifacts[0].source_map_byte_size,
          outcome: 'created',
        }),
      );
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      for (const command of ['upload', 'verify']) {
        const child = spawn(
          process.execPath,
          [
            new URL('../bin/dozenfold.mjs', import.meta.url).pathname,
            'source-maps',
            command,
            '--manifest',
            manifest,
            '--shop',
            shop,
            '--release',
            'landing-override',
            '--endpoint',
            `http://127.0.0.1:${server.address().port}`,
            '--json',
          ],
          {
            env: { ...process.env, DOZENFOLD_SOURCE_MAP_TOKEN: TOKEN },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit));
        assert.equal(exitCode, 0, stderr);
        assert.equal(JSON.parse(stdout).status, 'ready');
        assert.doesNotMatch(stdout + stderr, new RegExp(TOKEN));
      }
      assert.equal(writes, 1);
      assert.equal(reads, 2);
    } finally {
      server.close();
    }
  });
}
