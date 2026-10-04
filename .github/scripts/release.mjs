import { readFileSync, appendFileSync } from 'node:fs';

const { name, version } = JSON.parse(readFileSync('packages/eventport/package.json', 'utf8'));
if (name !== 'eventport') throw new Error(`Unexpected publish package: ${name}`);
if (process.env.RELEASE_TAG !== `v${version}`) {
  throw new Error(`Release tag must match package version: v${version}`);
}
const prerelease = version.split('+')[0].includes('-');
if (process.env.RELEASE_PRERELEASE !== String(prerelease)) {
  throw new Error('GitHub prerelease flag must match the package version prerelease suffix.');
}
const channel = prerelease ? 'next' : 'latest';
appendFileSync(process.env.GITHUB_OUTPUT, `dist-tag=${channel}\n`);
console.log(`Validated ${name}@${version} for npm channel ${channel}`);
