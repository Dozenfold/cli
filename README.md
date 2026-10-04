# Dozenfold CLI

Release tooling for uploading private, tenant-scoped browser source maps to Dozenfold. The CLI
injects a debug ID into each minified bundle/map pair, uploads the map, reads private artifact
status back, and can verify that the exact deployed CDN bytes match the local build.

## Install

Pin an exact version in merchant CI:

```bash
npm install --save-dev --save-exact @dozenfold/cli@<version>
```

Create a shop-scoped credential in **Dozenfold → Releases → Source maps** and store the one-time
token as the masked `DOZENFOLD_SOURCE_MAP_TOKEN` CI secret. Do not pass it as a command argument.

## Manifest and release flow

```json
{
  "version": 1,
  "release": "shopify-theme-2026-09-03.1",
  "artifacts": [
    {
      "minified_url": "https://shop.myshopify.com/cdn/shop/t/2/assets/theme.js?v=123",
      "minified_file": "dist/theme.js",
      "source_map": "dist/theme.js.map"
    }
  ]
}
```

```bash
npx dozenfold source-maps inject --manifest dozenfold-source-maps.json

DOZENFOLD_SOURCE_MAP_TOKEN="$DOZENFOLD_SOURCE_MAP_TOKEN" \
  npx dozenfold source-maps upload \
  --manifest dozenfold-source-maps.json \
  --shop shop.myshopify.com

# Publish the exact injected bundle, then verify Shopify serves those bytes.
DOZENFOLD_SOURCE_MAP_TOKEN="$DOZENFOLD_SOURCE_MAP_TOKEN" \
  npx dozenfold source-maps verify \
  --manifest dozenfold-source-maps.json \
  --shop shop.myshopify.com \
  --cdn
```

The release value must exactly match the release configured in the Dozenfold storefront SDK.
Reusing one release for different builds is unsupported.

## GitHub Actions

Use the action after the injected bundle is built. Keep the token in GitHub Actions secrets:

```yaml
- run: npx dozenfold source-maps inject --manifest dozenfold-source-maps.json
- uses: Dozenfold/cli@v1
  with:
    manifest: dozenfold-source-maps.json
    shop: shop.myshopify.com
    token: ${{ secrets.DOZENFOLD_SOURCE_MAP_TOKEN }}
# Publish the exact bundle here.
- uses: Dozenfold/cli@v1
  with:
    command: verify
    verify-cdn: 'true'
    manifest: dozenfold-source-maps.json
    shop: shop.myshopify.com
    token: ${{ secrets.DOZENFOLD_SOURCE_MAP_TOKEN }}
```

Or install the pinned package during the normal build job and run the same commands. Keep the token in
GitHub Actions secrets:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: npm
- run: npm ci
- run: npx dozenfold source-maps inject --manifest dozenfold-source-maps.json
- run: npx dozenfold source-maps upload --manifest dozenfold-source-maps.json --shop shop.myshopify.com
  env:
    DOZENFOLD_SOURCE_MAP_TOKEN: ${{ secrets.DOZENFOLD_SOURCE_MAP_TOKEN }}
# Publish the exact bundle here.
- run: npx dozenfold source-maps verify --manifest dozenfold-source-maps.json --shop shop.myshopify.com --cdn
  env:
    DOZENFOLD_SOURCE_MAP_TOKEN: ${{ secrets.DOZENFOLD_SOURCE_MAP_TOKEN }}
```

Maps and `sourcesContent` remain private, expire under the configured retention policy, and resolve
only for the exact shop, release, canonical minified URL, bundle digest, and debug ID.
