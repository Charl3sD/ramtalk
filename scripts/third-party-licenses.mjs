// Writes dist/THIRD_PARTY_LICENSES.txt with the license text of every production dependency
// bundled into the site (some are Apache-2.0, which requires shipping the license with copies).
// Runs after `vite build`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist', 'THIRD_PARTY_LICENSES.txt');

const tree = JSON.parse(
  execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], { cwd: root, encoding: 'utf8' }),
);

const seen = new Map();
(function walk(deps = {}) {
  for (const [name, info] of Object.entries(deps)) {
    const key = `${name}@${info.version}`;
    if (!seen.has(key) && info.path) seen.set(key, info);
    walk(info.dependencies);
  }
})(tree.dependencies);

const sections = [...seen.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, info]) => {
    const licenseFile = readdirSync(info.path).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const pkg = JSON.parse(readFileSync(join(info.path, 'package.json'), 'utf8'));
    const declared = pkg.license ?? JSON.stringify(pkg.licenses ?? 'UNKNOWN');
    const text = licenseFile ? readFileSync(join(info.path, licenseFile), 'utf8').trim() : `(no license file; declared license: ${declared})`;
    return `${key}\nLicense: ${declared}\n${pkg.homepage ? `Homepage: ${pkg.homepage}\n` : ''}\n${text}`;
  });

if (!existsSync(join(root, 'dist'))) throw new Error('dist/ not found; run vite build first');
writeFileSync(
  out,
  `ramtalk bundles the following third-party packages.\n\n${sections.join(`\n\n${'='.repeat(78)}\n\n`)}\n`,
);
console.log(`wrote ${out} (${seen.size} packages)`);
