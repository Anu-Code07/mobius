// Packs what `npx @anuraghq/mobius` needs: the README (links made absolute for the npm page), LICENSE, the device
// driver binary for this platform, and the iOS runner setup.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
const repo = '../..';
const gh = 'https://github.com/Anu-Code07/mobius', raw = 'https://raw.githubusercontent.com/Anu-Code07/mobius/main';
const readme = readFileSync(`${repo}/README.md`, 'utf8')
  .replace(/src="(?!https?:)([^"]+)"/g, (_, p) => `src="${raw}/${p}"`)
  .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, p) => `](${gh}/blob/main/${p})`);
writeFileSync('README.md', readme);
cpSync(`${repo}/LICENSE`, 'LICENSE');
const bin = `${repo}/drivers/mobiusagent-driver/target/release/mobiusagent-driver`;
if (!existsSync(bin)) throw new Error('Build the driver first: cargo build --release in drivers/mobiusagent-driver');
mkdirSync('bin', { recursive: true });
const out = `bin/mobiusagent-driver-${process.platform}-${process.arch}`;
cpSync(bin, out);
chmodSync(out, 0o755);
cpSync(`${repo}/drivers/mobiusagent-driver/ios-agent`, 'ios-agent', { recursive: true });
console.log(`packed driver ${out} + ios-agent`);
