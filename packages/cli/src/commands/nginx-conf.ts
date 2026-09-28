// `ppn nginx-conf <template> <out>` — render the server's nginx config.
//
// The chain and service routes are generated from the dashboard model (the same table the
// dashboard proxies locally), plus the TURN-over-TLS stream when the relay runs; everything
// else in the template — TLS, certbot, p2p streams, logs — passes through untouched,
// including its ${VARS}, which the caller still envsubsts. Markers say where the generated
// blocks go, so a template that loses one fails loudly instead of silently shipping without.

import fs from 'node:fs';
import { loadCurrentNetwork, dashboardModel, nginxRoutes, nginxTurnStream } from '@parity/ppn-network-config';

const UPSTREAMS = '# {{GENERATED_UPSTREAMS}}';
const LOCATIONS = '        # {{GENERATED_LOCATIONS}}';
/** Inside the template's stream{} block, which holds the TLS certificates. */
const STREAMS = '    # {{GENERATED_STREAMS}}';

export function run(args: string[]): void {
  const [template, out] = args;
  if (!template || !out) throw new Error('usage: ppn nginx-conf <template> <out>');

  const domain = process.env.PPN_DOMAIN;
  if (!domain) throw new Error('PPN_DOMAIN is not set — the routes advertise it');

  const net = loadCurrentNetwork();
  const model = dashboardModel(net, `https://${domain}`);
  const { upstreams, locations } = nginxRoutes(model);

  const blocks: [string, string][] = [[UPSTREAMS, upstreams], [LOCATIONS, locations]];
  // Only a network that runs the TURN relay needs a stream marker (docs/TURN.md).
  if (model.ice) blocks.push([STREAMS, nginxTurnStream()]);

  let text = fs.readFileSync(template, 'utf-8');
  for (const [marker, block] of blocks) {
    if (!text.includes(marker)) {
      throw new Error(`template has no "${marker.trim()}" marker — refusing to emit a config without routes`);
    }
    text = text.replace(marker, block);
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}: ${model.chains.length} chain routes generated${model.ice ? ', TURN over TLS' : ''}`);
}
