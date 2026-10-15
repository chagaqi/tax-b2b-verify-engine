import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { generateEd25519 } from '@tbve/core-api';
import { loadShellAssets } from './assets.js';
import { NodeDnsResolver } from './dns.js';
import { createGateway } from './gateway.js';

const HELP = `tax-b2b-verify-engine gateway

Usage:
  node dist/server.mjs                         start the HTTP server (PORT, default 8787)
  node dist/server.mjs --generate-signing-key  print a new CERT_SIGNING_KEY (Ed25519 PKCS#8, base64)
  node dist/server.mjs --help

Configuration is read from environment variables — see .env.example.`;

async function main(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (argv.includes('--generate-signing-key')) {
    const { pkcs8 } = await generateEd25519();
    console.log(pkcs8);
    return;
  }

  const gateway = await createGateway({
    env: process.env,
    assets: loadShellAssets(),
    dns: new NodeDnsResolver(),
    getClientIp: (c) => getConnInfo(c).remote.address,
  });
  const port = Number(process.env.PORT ?? 8787);
  const hostname = process.env.HOST ?? '0.0.0.0';
  const server = serve({ fetch: gateway.app.fetch, port, hostname }, (info) => {
    gateway.services.logger.info('listening', {
      port: info.port,
      url: gateway.services.config.publicBaseUrl,
      storage: gateway.storage,
      viesMode: gateway.services.config.viesMode,
      signingKey: gateway.services.signer.keyId,
    });
  });

  const shutdown = (signal: string) => {
    gateway.services.logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main(process.argv.slice(2)).catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'fatal', error: (err as Error).message }));
  process.exit(1);
});
