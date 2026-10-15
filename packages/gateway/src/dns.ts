import { Resolver } from 'node:dns/promises';
import type { DnsAnswer, DnsResolver, RecordType } from '@tbve/core-api';

type NodeResolver = Pick<Resolver, 'resolveMx' | 'resolveTxt' | 'resolve4' | 'resolve6' | 'resolveNs' | 'resolveCname'>;

/** Native resolver for Node: lower latency than DoH and matches what `fetch` will connect to. */
export class NodeDnsResolver implements DnsResolver {
  constructor(private readonly resolver: NodeResolver = Object.assign(new Resolver({ timeout: 2500, tries: 2 }))) {}

  async resolve(name: string, type: RecordType): Promise<DnsAnswer> {
    try {
      const r = this.resolver;
      let records: string[];
      switch (type) {
        case 'MX':
          records = (await r.resolveMx(name)).map((m) => `${m.priority} ${m.exchange || '.'}`);
          break;
        case 'TXT':
          records = (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
          break;
        case 'A':
          records = await r.resolve4(name);
          break;
        case 'AAAA':
          records = await r.resolve6(name);
          break;
        case 'NS':
          records = await r.resolveNs(name);
          break;
        case 'CNAME':
          records = await r.resolveCname(name);
          break;
      }
      return { status: records.length ? 'ok' : 'nodata', records };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND') return { status: 'nxdomain', records: [] };
      if (code === 'ENODATA') return { status: 'nodata', records: [] };
      return { status: 'error', records: [] };
    }
  }
}
