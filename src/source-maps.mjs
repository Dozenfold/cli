import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/;
const SHOP_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const SOURCE_MAP_LIMIT = 5 * 1024 * 1024;
const MINIFIED_FILE_LIMIT = 50 * 1024 * 1024;
const ARTIFACT_LIMIT = 500;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEBUG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEBUG_ID_MARKER_RE = /\/\/# debugId=([0-9a-f-]{36})/i;

export class SourceMapCliError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'SourceMapCliError';
    this.exitCode = exitCode;
  }
}

function safeText(value, fallback = 'request failed', secrets = []) {
  if (typeof value !== 'string') return fallback;
  let cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  for (const secret of secrets) {
    if (secret) cleaned = cleaned.replaceAll(secret, '[REDACTED]');
  }
  cleaned = cleaned.slice(0, 180);
  return cleaned || fallback;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function normalizeEndpoint(raw) {
  let parsed;
  try {
    parsed = new URL(raw || 'https://ingest.dozenfold.com');
  } catch {
    throw new SourceMapCliError('Invalid Dozenfold endpoint URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SourceMapCliError(
      'Dozenfold endpoint must not contain credentials, query, or fragment.',
    );
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLocalHostname(parsed.hostname))
  ) {
    throw new SourceMapCliError(
      'Dozenfold endpoint must use HTTPS (HTTP is allowed only for local development).',
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

export function canonicalizeMinifiedUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new SourceMapCliError('Each artifact requires an absolute minified_url.');
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new SourceMapCliError('Each artifact minified_url must be an absolute HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new SourceMapCliError(
      'Each artifact minified_url must be an absolute HTTP(S) URL without credentials.',
    );
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function hasValidIndexedSections(sections) {
  if (!Array.isArray(sections) || sections.length < 1) return false;
  return sections.every((section) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
    const map = section.map;
    if (!map || typeof map !== 'object' || Array.isArray(map) || map.version !== 3) return false;
    return (
      (typeof map.mappings === 'string' && map.mappings.length > 0) ||
      hasValidIndexedSections(map.sections)
    );
  });
}

function validateSourceMap(parsed, label) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 3) {
    throw new SourceMapCliError(`${label} is not a source map v3 object.`);
  }
  const hasMappings = typeof parsed.mappings === 'string' && parsed.mappings.length > 0;
  const hasSections = hasValidIndexedSections(parsed.sections);
  if (!hasMappings && !hasSections) {
    throw new SourceMapCliError(`${label} has neither mappings nor indexed sections.`);
  }
}

async function readBoundedFile(path, limit, label) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new SourceMapCliError(`${label} does not exist: ${path}`);
  }
  if (!metadata.isFile()) throw new SourceMapCliError(`${label} is not a regular file: ${path}`);
  if (metadata.size > limit) {
    throw new SourceMapCliError(
      `${label} exceeds the ${Math.floor(limit / 1024 / 1024)} MiB limit: ${path}`,
    );
  }
  return readFile(path);
}

export async function loadSourceMapManifest(manifestPath, releaseOverride) {
  const absoluteManifest = resolve(manifestPath);
  const manifestBytes = await readBoundedFile(absoluteManifest, 1024 * 1024, 'Manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new SourceMapCliError('Source-map manifest is not valid JSON.');
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    ![1, 2].includes(manifest.version)
  ) {
    throw new SourceMapCliError('Source-map manifest must be an object with version 1 or 2.');
  }
  const release = String(releaseOverride || manifest.release || '').trim();
  if (!RELEASE_RE.test(release)) {
    throw new SourceMapCliError(
      'Release must match the Dozenfold opaque release ID contract (1-128 safe characters).',
    );
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1) {
    throw new SourceMapCliError('Source-map manifest must contain at least one artifact.');
  }
  if (manifest.artifacts.length > ARTIFACT_LIMIT) {
    throw new SourceMapCliError(
      `Source-map manifest exceeds the ${ARTIFACT_LIMIT}-artifact limit.`,
    );
  }

  const root = dirname(absoluteManifest);
  const seen = new Set();
  const artifacts = [];
  for (const [index, raw] of manifest.artifacts.entries()) {
    const label = `Artifact ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SourceMapCliError(`${label} must be an object.`);
    }
    const minifiedUrl = canonicalizeMinifiedUrl(raw.minified_url);
    if (seen.has(minifiedUrl)) {
      throw new SourceMapCliError(`${label} duplicates canonical minified_url ${minifiedUrl}.`);
    }
    seen.add(minifiedUrl);
    if (typeof raw.source_map !== 'string' || !raw.source_map.trim()) {
      throw new SourceMapCliError(`${label} requires source_map.`);
    }
    if (typeof raw.minified_file !== 'string' || !raw.minified_file.trim()) {
      throw new SourceMapCliError(`${label} requires minified_file.`);
    }

    const sourceMapPath = resolve(root, raw.source_map);
    const minifiedPath = resolve(root, raw.minified_file);
    const sourceMapBytes = await readBoundedFile(
      sourceMapPath,
      SOURCE_MAP_LIMIT,
      `${label} source map`,
    );
    let sourceMap;
    try {
      sourceMap = JSON.parse(sourceMapBytes.toString('utf8'));
    } catch {
      throw new SourceMapCliError(`${label} source map is not valid JSON.`);
    }
    validateSourceMap(sourceMap, `${label} source map`);
    const debugId = typeof raw.debug_id === 'string' ? raw.debug_id.toLowerCase() : null;
    if (manifest.version === 2 && (!debugId || !DEBUG_ID_RE.test(debugId))) {
      throw new SourceMapCliError(`${label} requires a valid debug_id in a version 2 manifest.`);
    }
    if (debugId && sourceMap.debug_id !== debugId) {
      throw new SourceMapCliError(`${label} debug_id does not match its source map.`);
    }
    const normalizedMap = Buffer.from(JSON.stringify(sourceMap), 'utf8');
    if (normalizedMap.byteLength > SOURCE_MAP_LIMIT) {
      throw new SourceMapCliError(`${label} normalized source map exceeds the 5 MiB limit.`);
    }
    const minifiedBytes = await readBoundedFile(
      minifiedPath,
      MINIFIED_FILE_LIMIT,
      `${label} minified file`,
    );

    artifacts.push({
      index,
      minified_url: minifiedUrl,
      cdn_url: raw.minified_url.trim(),
      minified_file: minifiedPath,
      minified_name: basename(minifiedPath),
      minified_digest: sha256(minifiedBytes),
      minified_byte_size: minifiedBytes.byteLength,
      source_map: sourceMap,
      source_map_file: sourceMapPath,
      source_map_digest: sha256(normalizedMap),
      source_map_byte_size: normalizedMap.byteLength,
      debug_id: debugId,
    });
  }
  return { version: manifest.version, release, manifest: absoluteManifest, artifacts };
}

function injectionLine(debugId) {
  return `;(()=>{try{var g=globalThis,r=g.__DOZENFOLD_DEBUG_IDS__||(g.__DOZENFOLD_DEBUG_IDS__=Object.create(null)),d="${debugId}",s=typeof document!=="undefined"&&document.currentScript&&document.currentScript.src,m;if(!s){m=((new Error).stack||"").match(/https?:\\/\\/[^\\s)]+?(?::\\d+){1,2}(?:\\)?$)/m);s=m&&m[0].replace(/(?::\\d+){1,2}(?:\\)?$)/,"")}if(s){var u=new URL(s,location.href);u.search="";u.hash="";r[u.href]=d}}catch(_){}})();//# debugId=${debugId}\n`;
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.dozenfold-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Idempotently inject one debug ID into each regular bundle/map pair, then upgrade manifest to v2. */
export async function injectSourceMapDebugIds(manifestPath) {
  const absoluteManifest = resolve(manifestPath);
  const manifestBytes = await readBoundedFile(absoluteManifest, 1024 * 1024, 'Manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new SourceMapCliError('Source-map manifest is not valid JSON.');
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.artifacts)) {
    throw new SourceMapCliError(
      'Source-map manifest must contain artifacts before debug-ID injection.',
    );
  }
  if (manifest.artifacts.length < 1 || manifest.artifacts.length > ARTIFACT_LIMIT) {
    throw new SourceMapCliError(`Debug-ID injection requires 1-${ARTIFACT_LIMIT} artifacts.`);
  }
  // Validate release, URLs, duplicate identities and every local file before the first mutation.
  await loadSourceMapManifest(absoluteManifest);

  const root = dirname(absoluteManifest);
  const prepared = [];
  for (const [index, raw] of manifest.artifacts.entries()) {
    const label = `Artifact ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SourceMapCliError(`${label} must be an object.`);
    }
    if (typeof raw.source_map !== 'string' || typeof raw.minified_file !== 'string') {
      throw new SourceMapCliError(`${label} requires source_map and minified_file.`);
    }
    const mapPath = resolve(root, raw.source_map);
    const bundlePath = resolve(root, raw.minified_file);
    const mapBytes = await readBoundedFile(mapPath, SOURCE_MAP_LIMIT, `${label} source map`);
    const bundleBytes = await readBoundedFile(
      bundlePath,
      MINIFIED_FILE_LIMIT,
      `${label} minified file`,
    );
    let map;
    try {
      map = JSON.parse(mapBytes.toString('utf8'));
    } catch {
      throw new SourceMapCliError(`${label} source map is not valid JSON.`);
    }
    validateSourceMap(map, `${label} source map`);
    if (typeof map.mappings !== 'string' || !map.mappings) {
      throw new SourceMapCliError(
        `${label} uses indexed sections; debug-ID injection currently requires a regular source map.`,
      );
    }
    const bundle = bundleBytes.toString('utf8');
    if (bundle.startsWith('#!')) {
      throw new SourceMapCliError(`${label} has a shebang and is not a browser bundle.`);
    }
    const bundleMatch = DEBUG_ID_MARKER_RE.exec(bundle);
    const ids = [raw.debug_id, map.debug_id, bundleMatch?.[1]]
      .filter((value) => typeof value === 'string' && value)
      .map((value) => value.toLowerCase());
    if (ids.some((id) => !DEBUG_ID_RE.test(id)) || new Set(ids).size > 1) {
      throw new SourceMapCliError(`${label} contains conflicting or invalid debug IDs.`);
    }
    const debugId = ids[0] || randomUUID();
    const nextBundle = bundleMatch ? bundle : `${injectionLine(debugId)}${bundle}`;
    if (!map.debug_id) map.mappings = `;${map.mappings}`;
    map.debug_id = debugId;
    raw.debug_id = debugId;
    const nextMap = Buffer.from(JSON.stringify(map), 'utf8');
    if (nextMap.byteLength > SOURCE_MAP_LIMIT) {
      throw new SourceMapCliError(`${label} source map exceeds 5 MiB after debug-ID injection.`);
    }
    prepared.push({ bundlePath, mapPath, nextBundle, nextMap, debugId });
  }

  for (const artifact of prepared) {
    await atomicWrite(artifact.bundlePath, artifact.nextBundle);
    await atomicWrite(artifact.mapPath, artifact.nextMap);
  }
  manifest.version = 2;
  await atomicWrite(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    status: 'prepared',
    artifact_count: prepared.length,
    debug_ids: prepared.map((a) => a.debugId),
  };
}

async function requestJson(
  url,
  init,
  { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), secret } = {},
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (attempt < 2) {
        await sleep(200 * 2 ** attempt);
        continue;
      }
      throw new SourceMapCliError(
        `Dozenfold request failed: ${safeText(error?.message, 'network error', [secret])}.`,
      );
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      // A bounded public error is emitted below; never echo an arbitrary response body.
    }
    if (response.ok) return body;
    if (attempt < 2 && RETRYABLE_STATUS.has(response.status)) {
      await sleep(200 * 2 ** attempt);
      continue;
    }
    throw new SourceMapCliError(
      `Dozenfold request failed (${response.status}): ${safeText(body?.error, 'request failed', [secret])}.`,
    );
  }
  throw new SourceMapCliError('Dozenfold request failed.');
}

function assertShop(shop) {
  // Custom site identifiers are opaque; retain their exact case.
  if (typeof shop === 'string' && /^site_[A-Za-z0-9_-]{1,250}$/.test(shop.trim())) {
    return shop.trim();
  }
  const normalized = String(shop || '')
    .trim()
    .toLowerCase();
  const labels = normalized.split('.');
  if (
    !SHOP_RE.test(normalized) ||
    labels.some(
      (label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'),
    )
  )
    throw new SourceMapCliError('Shop must be a valid hostname or custom site identifier.');
  return normalized;
}

function assertToken(token) {
  if (typeof token !== 'string' || !token.startsWith('df_sm_v1_') || token.length < 32) {
    throw new SourceMapCliError('DOZENFOLD_SOURCE_MAP_TOKEN is missing or invalid.');
  }
  return token;
}

async function getArtifactStatus({ endpoint, shop, release, artifact, token, transport }) {
  const url = new URL(`${endpoint}/v1/shops/${encodeURIComponent(shop)}/source-maps/status`);
  url.searchParams.set('release', release);
  url.searchParams.set('minified_url', artifact.minified_url);
  return requestJson(
    url,
    { headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
    { ...transport, secret: token },
  );
}

function assertReady(status, release, artifact) {
  if (!status || status.status !== 'ready') {
    throw new SourceMapCliError(`Artifact is not ready for ${artifact.minified_url}.`);
  }
  if (
    status.release !== release ||
    status.minified_url !== artifact.minified_url ||
    status.digest !== artifact.source_map_digest ||
    status.byte_size !== artifact.source_map_byte_size ||
    (artifact.debug_id && status.debug_id !== artifact.debug_id) ||
    (artifact.debug_id && status.minified_digest !== artifact.minified_digest)
  ) {
    throw new SourceMapCliError(
      `Artifact verification drift detected for ${artifact.minified_url}.`,
    );
  }
}

async function readResponseBytesBounded(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new SourceMapCliError('CDN bundle exceeds the 50 MiB verification limit.');
  }
  if (!response.body) throw new SourceMapCliError('CDN response has no readable body.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new SourceMapCliError('CDN bundle exceeds the 50 MiB verification limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

async function verifyCdnArtifact(artifact, { fetchImpl = fetch } = {}) {
  let url;
  try {
    url = new URL(artifact.cdn_url);
  } catch {
    throw new SourceMapCliError('Artifact CDN URL is invalid.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHostname(url.hostname))) {
    throw new SourceMapCliError('CDN verification requires HTTPS (or local development HTTP).');
  }
  url.hash = '';
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/javascript,*/*;q=0.1' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new SourceMapCliError(`CDN verification request failed: ${safeText(error?.message)}.`);
  }
  if (!response.ok) {
    throw new SourceMapCliError(`CDN verification request failed (${response.status}).`);
  }
  const bytes = await readResponseBytesBounded(response, MINIFIED_FILE_LIMIT);
  if (sha256(bytes) !== artifact.minified_digest) {
    throw new SourceMapCliError(
      `CDN bundle digest does not match the build for ${artifact.minified_url}.`,
    );
  }
}

export async function runSourceMapCommand({
  command,
  manifestPath,
  release: releaseOverride,
  shop: rawShop,
  endpoint: rawEndpoint,
  token: rawToken,
  verifyCdn = false,
  transport,
  onArtifact = () => {},
}) {
  if (!['upload', 'verify'].includes(command)) {
    throw new SourceMapCliError('Source-map command must be upload or verify.');
  }
  const endpoint = normalizeEndpoint(rawEndpoint);
  const shop = assertShop(rawShop);
  const token = assertToken(rawToken);
  const manifest = await loadSourceMapManifest(manifestPath, releaseOverride);
  const results = [];

  for (const artifact of manifest.artifacts) {
    let outcome = null;
    if (command === 'upload') {
      const uploaded = await requestJson(
        `${endpoint}/v1/shops/${encodeURIComponent(shop)}/source-maps`,
        {
          method: 'PUT',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            release: manifest.release,
            minified_url: artifact.minified_url,
            source_map: artifact.source_map,
            ...(artifact.debug_id
              ? {
                  debug_id: artifact.debug_id,
                  minified_digest: artifact.minified_digest,
                }
              : {}),
          }),
        },
        { ...transport, secret: token },
      );
      assertReady(uploaded, manifest.release, artifact);
      outcome = uploaded.outcome || null;
    }

    const status = await getArtifactStatus({
      endpoint,
      shop,
      release: manifest.release,
      artifact,
      token,
      transport,
    });
    assertReady(status, manifest.release, artifact);
    if (verifyCdn) await verifyCdnArtifact(artifact, transport);
    const result = {
      minified_url: artifact.minified_url,
      minified_digest: artifact.minified_digest,
      minified_byte_size: artifact.minified_byte_size,
      source_map_digest: artifact.source_map_digest,
      source_map_byte_size: artifact.source_map_byte_size,
      status: 'ready',
      outcome,
      uploaded_at: status.uploaded_at ?? null,
      expires_at: status.expires_at ?? null,
      cdn_verified: verifyCdn,
    };
    results.push(result);
    onArtifact(result, results.length, manifest.artifacts.length);
  }

  return {
    status: 'ready',
    command,
    shop,
    release: manifest.release,
    artifact_count: results.length,
    artifacts: results,
  };
}

const RELEASE_NOTE_MAX = 280;

/** Mark a deployed release so Dozenfold compares before/after and tags storefront events with it. */
export async function createReleaseMarker({
  release: rawRelease,
  shop: rawShop,
  note: rawNote,
  endpoint: rawEndpoint,
  token: rawToken,
  transport,
}) {
  const release = String(rawRelease || '').trim();
  if (!RELEASE_RE.test(release)) {
    throw new SourceMapCliError('Release must be 1-128 characters: letters, digits and ._:@/+~-');
  }
  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : undefined;
  if (note && note.length > RELEASE_NOTE_MAX) {
    throw new SourceMapCliError(`Release note must be at most ${RELEASE_NOTE_MAX} characters.`);
  }
  const endpoint = normalizeEndpoint(rawEndpoint);
  const shop = assertShop(rawShop);
  const token = assertToken(rawToken);
  try {
    const body = await requestJson(
      `${endpoint}/v1/shops/${encodeURIComponent(shop)}/release-markers`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ release, ...(note ? { note } : {}) }),
      },
      { ...transport, secret: token },
    );
    return { release: body?.release ?? release, marked_at: body?.marked_at ?? null };
  } catch (error) {
    if (error instanceof SourceMapCliError && error.message.includes('(403)')) {
      throw new SourceMapCliError(
        'This credential cannot mark releases. Create a new CI credential in Dozenfold → Releases → Source maps.',
      );
    }
    throw error;
  }
}
