# CI and npm releases

`ci.yml` runs source type checks and `pnpm test` on pull requests and pushes to `main`, using Node 22, 24 and 26. Tests include the build, 56 regression/package checks and consumer typing. The publishing workflow reuses the same checks for the release commit.

## One-time setup

1. Ensure you own the npm package name `eventport`. If the package does not yet exist, publish its initial version from an authenticated maintainer machine (`pnpm pack:lib`, then `npm publish <tarball> --access public`). The workflow cannot establish npm package ownership.
2. In npm's package settings, configure a GitHub Actions trusted publisher with:
   - Organization/user: `AbhinRustagi`
   - Repository: `eventport`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
   - Allow direct publishing with `npm publish` if npm presents that option.
3. Create the GitHub repository environment `npm`. Add release protections there if desired. No `NPM_TOKEN` secret is needed.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). The workflow grants OIDC permission only to the publish job and uses npm 11 with Node 24. Package installation and building continue to use the pinned pnpm version.

## Publish a version

1. Update `packages/eventport/package.json` to a new version and merge the change into `main`.
2. Create and publish a GitHub release with an exact matching tag, such as `v0.1.1`. The tag must point to a commit reachable from `main`.
3. For a prerelease such as `v0.2.0-beta.1`, mark the GitHub release as a prerelease. These publish to `next`; stable releases publish to `latest`.

Publishing waits for the full CI matrix, validates the version/channel, builds and packs only `packages/eventport`, and publishes its tarball with provenance. Draft releases and ordinary main pushes do not publish. The private workspace root and playground are never published.

If a publish fails before npm accepts the version, fix its cause and rerun the failed workflow. If npm already accepted the version, verify it on the registry; npm versions cannot be overwritten. Use a new version for changed contents. After a manual initial publish, start automated releases with a newer version.
