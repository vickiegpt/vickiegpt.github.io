import { server as wispServer } from '@mercuryworkshop/wisp-js/server';

export const WISP_PATH = '/wisp/';

export function createRestrictedWispRouter(server = wispServer) {
  Object.assign(server.options, {
    hostname_whitelist: [/^asplos\.dev$/i],
    hostname_blacklist: null,
    port_whitelist: [443],
    port_blacklist: null,
    allow_direct_ip: false,
    allow_private_ips: false,
    allow_loopback_ips: false,
    allow_udp_streams: false,
    allow_tcp_streams: true,
    stream_limit_per_host: 8,
    stream_limit_total: 8,
    wisp_version: 2,
  });

  return Object.freeze({
    path: WISP_PATH,
    route(request, socket, head) {
      request.url = WISP_PATH;
      server.routeRequest(request, socket, head);
    },
  });
}
