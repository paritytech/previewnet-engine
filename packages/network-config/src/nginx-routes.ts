// nginx upstreams and location blocks, generated from the dashboard model.
//
// These blocks used to be hand-maintained in server/nginx/ppn.conf.template — one upstream
// and one location per chain and service, edited by hand whenever the network changed, and
// nothing kept them in step with what actually ran. They are now emitted from the same route
// table the dashboard serves and proxies, so nginx on a server and the local proxy on a
// laptop cannot disagree about a path.
//
// Only the *chain* routes are generated: they are uniform (a proxy_pass plus the websocket
// snippet) and they are what changes when a descriptor changes — a new parachain is a new
// route. The service blocks (eth-rpc, dub, the storage provider, ipfs) stay hand-written in
// the template: each carries bespoke CORS, body-size and header-stripping rules that are
// behaviour, not routing, and flattening them into a generator would erase it. TLS, certbot,
// the p2p WSS streams, logs and health stay in the template too.

import type { DashboardModel } from './dashboard-model.js';

const sanitize = (id: string) => id.replace(/[^a-z0-9]/g, '_');

/**
 * The `upstream` blocks (http context) and `location` blocks (server context), as two
 * strings, so the caller can splice each into the right place in the template.
 */
export function nginxRoutes(model: DashboardModel): { upstreams: string; locations: string } {
  const entries = model.chains;

  const upstreams = entries
    .map(
      (e) => `upstream ${sanitize(e.id)} {
    server 127.0.0.1:${e.port};
    keepalive 32;
}`
    )
    .join('\n\n');

  const locations = entries
    .map(
      (e) => `    # ${e.label}
    location ${e.path} {
        proxy_pass http://${sanitize(e.id)}/;
        include /etc/nginx/snippets/websocket-proxy.conf;
    }`
    )
    .join('\n\n');

  return { upstreams, locations };
}
