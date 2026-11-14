#!/usr/bin/env node
// Start the Ospeli site server:  node tools/ospeli-server/server.mjs
// Options: --port 8787   --host 0.0.0.0 (let other computers on your network reach it)
//          --data FILE   (where the data is kept)   --no-console
//          --tls-cert FILE --tls-key FILE   (answer over https with the site's own certificate)
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Ospeli needs Node.js 22.13 or newer. This computer has ${process.versions.node}.\nInstall the current "LTS" version from nodejs.org, then start Ospeli again.`);
  process.exit(1);
}
// Node still labels its built-in SQLite "experimental" and prints a warning; keep the first screen clean.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));

const { startServer, StartError, DEFAULT_PORT } = await import('./site-server.mjs');
const { fileURLToPath } = await import('node:url');
const { createInterface } = await import('node:readline');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const known = new Set(['--port', '--host', '--data', '--no-console', '--allow-host', '--tls-cert', '--tls-key', '--help']);
const unknown = args.find((a) => a.startsWith('--') && !known.has(a));
if (unknown || args.includes('--help')) {
  console.log(`${unknown ? `Ospeli does not know the option ${unknown}.\n` : ''}Start Ospeli:  node tools/ospeli-server/server.mjs\nOptions:  --port ${DEFAULT_PORT}   --host 0.0.0.0 (other computers on your network can reach it)   --data FILE   --no-console   --tls-cert FILE --tls-key FILE (https with your own certificate)`);
  process.exit(unknown ? 1 : 0);
}
const port = Number(opt('port', DEFAULT_PORT));
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('The port must be a number from 1 to 65535, for example: --port 8787'); process.exit(1); }

// https: the site gives its own certificate and key (two PEM files). Ospeli does not make one.
const certFile = opt('tls-cert', ''); const keyFile = opt('tls-key', '');
if (!!certFile !== !!keyFile) { console.error('To use https give both files: --tls-cert FILE --tls-key FILE'); process.exit(1); }
let tls = null;
if (certFile) {
  const { readFileSync } = await import('node:fs');
  try { tls = { cert: readFileSync(certFile), key: readFileSync(keyFile) }; } catch (err) { console.error(`Ospeli could not read the certificate or key file (${err.code || 'not readable'}). Check the two file names.`); process.exit(1); }
}

let site;
try {
  site = await startServer({
    file: opt('data', fileURLToPath(new URL('./data/site.db', import.meta.url))),
    host: opt('host', '127.0.0.1'), port,
    allowHosts: opt('allow-host', '') ? opt('allow-host', '').split(',') : [],
    tls,
  });
} catch (err) {
  if (err instanceof StartError) { console.error(err.message); process.exit(1); }
  console.error(`Ospeli could not start: ${err.message}`);
  process.exit(1);
}
console.log(await site.banner());

const stop = async () => { try { await site.close(); } finally { console.log('\nOspeli is off. Your data is saved.'); process.exit(0); } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (process.stdin.isTTY && !args.includes('--no-console')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    try { const out = await site.consoleLine(line); if (out) console.log(out); } catch (err) { console.log(`That did not work (${err.message}). Type: help`); }
    rl.prompt();
  });
  rl.on('close', stop);
}
