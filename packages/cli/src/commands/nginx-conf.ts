// `ppn nginx-conf <template> <out>` — render the server's nginx config.
//
// The chain and service routes are generated from the dashboard model (the same table the
// dashboard proxies locally); everything else in the template — TLS, certbot, p2p streams,
// logs — passes through untouched, including its ${VARS}, which the caller still envsubsts.
// Two markers say where the generated halves go, so a template that loses them fails loudly
// instead of silently shipping no routes.

import fs from 'node:fs';
import { loadCurrentNetwork, dashboardModel, nginxRoutes } from '@parity/ppn-network-config';

const UPSTREAMS = '# {{GENERATED_UPSTREAMS}}';
const LOCATIONS = '        # {{GENERATED_LOCATIONS}}';

export function run(args: string[]): void {
  const [template, out] = args;
  if (!template || !out) throw new Error('usage: ppn nginx-conf <template> <out>');

  const domain = process.env.PPN_DOMAIN;
  if (!domain) throw new Error('PPN_DOMAIN is not set — the routes advertise it');

  const net = loadCurrentNetwork();
  const model = dashboardModel(net, `https://${domain}`);
  const { upstreams, locations } = nginxRoutes(model);

  let text = fs.readFileSync(template, 'utf-8');
  for (const [marker, block] of [[UPSTREAMS, upstreams], [LOCATIONS, locations]] as const) {
    if (!text.includes(marker)) {
      throw new Error(`template has no "${marker.trim()}" marker — refusing to emit a config without routes`);
    }
    text = text.replace(marker, block);
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}: ${model.chains.length} chain routes generated`);
}
