// Checks a published release the way the in-app updater reads it. Run after
// `npm run release`, from the repo root, with the version as package.json has it:
//   node scripts/check-release.mjs            (reads the version from package.json)
//   node scripts/check-release.mjs 0.14.0-beta
//
// electron-builder uploads the installer, its blockmap and latest.yml in
// parallel, and on v0.15.0-beta two uploads each created a release for the
// same tag: one with the installer and latest.yml, one with only the
// blockmap. GitHub's "latest" is the newest release, which was the one
// without latest.yml. This fails on that, and on anything else the updater
// would trip over.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = 'Kyogrim/stream-lurker';
const version = process.argv[2] || JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;
const installer = `Stream-Lurker-Setup-${version}.exe`;
const gh = (...args) => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
const problems = [];

const releases = gh(`repos/${REPO}/releases?per_page=20`).filter(r => r.tag_name === tag);
if (releases.length !== 1) problems.push(`${releases.length} releases on ${tag} (want 1): ${releases.map(r => `${r.id} [${r.assets.map(a => a.name).join(', ')}]`).join('; ')}`);
const release = releases.find(r => r.assets.some(a => a.name === 'latest.yml')) || releases[0];
if (release) {
  const names = release.assets.map(a => a.name);
  for (const want of ['latest.yml', installer, `${installer}.blockmap`]) {
    if (!names.includes(want)) problems.push(`${want} missing from release ${release.id}`);
  }
  if (release.draft) problems.push('the release is a draft');
}
const latest = gh(`repos/${REPO}/releases/latest`);
if (latest.tag_name !== tag || (release && latest.id !== release.id)) problems.push(`GitHub's latest release is ${latest.tag_name} (${latest.id}), not the ${tag} release with latest.yml`);

const base = `https://github.com/${REPO}/releases/download/${tag}`;
const yml = await (await fetch(`${base}/latest.yml`)).text();
const field = (k) => (new RegExp(`^${k}: (.+)$`, 'm').exec(yml) || [])[1];
if (field('version') !== version) problems.push(`latest.yml says version ${field('version')}`);
if (field('path') !== installer) problems.push(`latest.yml points at ${field('path')}`);
const local = `dist/Stream Lurker Setup ${version}.exe`;
if (fs.existsSync(local)) {
  const sha = crypto.createHash('sha512').update(fs.readFileSync(local)).digest('base64');
  if (field('sha512') !== sha) problems.push('latest.yml sha512 does not match the installer in dist/');
}
for (const f of [installer, `${installer}.blockmap`]) {
  const r = await fetch(`${base}/${f}`, { method: 'HEAD', redirect: 'follow' });
  if (r.status !== 200) problems.push(`${f} download answered ${r.status}`);
}

if (problems.length) {
  console.error(`${tag}: NOT READY\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${tag}: one release, installer + blockmap + latest.yml, latest, hashes match. Ready.`);
