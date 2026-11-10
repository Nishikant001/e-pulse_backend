// services/erp/urlValidator.js — server-side validation of an ERP base URL and service path. Phase 17 hardening.
// The server will make requests to whatever URL an admin saves, so this is the SSRF / credential-leak boundary.
//
// ALWAYS refused (any environment, no switch):
//   • schemes other than http/https (file:, javascript:, data:, ftp: …) · user:password@ in the URL · query string / fragment
//   • unspecified (0.0.0.0, ::), multicast, link-local (169.254.0.0/16 incl. the cloud metadata address, fe80::/10), "this network" 0.0.0.0/8
//   • well-known metadata / internal-only host names (metadata.google.internal, *.internal, *.local, *.localhost, *.localdomain, bare names)
//   • IPv6 forms that EMBED an IPv4 address (::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16) are judged by the embedded IPv4 address
// In PRODUCTION refused unless the deployment opts in (see PHASE17_DELIVERABLES.md §7 "Network policy"); development / test (NODE_ENV ≠ production)
// keep the pre-Phase-17 behaviour so mock ERPs on localhost / a LAN keep working:
//   • loopback (127.0.0.0/8, ::1, localhost)      never in production
//   • private ranges (10/8, 172.16/12, 192.168/16, 100.64/10 CGNAT, fc00::/7) and internal-only names (*.local …)    ERP_ALLOW_PRIVATE_NETWORK=true
//   • plain http                                  allowed outside production, or ERP_ALLOW_HTTP=true
// Optional allow-list ERP_ALLOWED_HOSTS (comma separated host names / IPs): when set, ONLY those hosts are accepted.
// Redirects are never followed (httpClient: redirect "manual", any 3xx is an error), so there is no redirect destination to re-validate; a
// "next page" link is followed only on the same origin. DNS names are additionally resolved at connect time (assertHostSafe) in production
// so a public-looking name pointing at an internal address is refused.
const dns = require("dns");
const net = require("net");
const { ErpIntegrationError } = require("./erpErrors");

const bad = (message) => new ErpIntegrationError("INVALID_CONFIGURATION", { message });
const isProd = () => process.env.NODE_ENV === "production";
const allowHttp = () => !isProd() || process.env.ERP_ALLOW_HTTP === "true";
const allowPrivate = () => !isProd() || process.env.ERP_ALLOW_PRIVATE_NETWORK === "true";
const allowLoopback = () => !isProd();
const MAX_URL = 2048;

// ── IP classification ────────────────────────────────────────────────────────────────────
const v4parts = (ip) => ip.split(".").map(Number);
/** @returns "unspecified"|"loopback"|"linklocal"|"private"|"multicast"|"reserved"|null */
function classifyV4(ip) {
  const [a, b] = v4parts(ip);
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "linklocal";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved"; // 240/4 incl. 255.255.255.255
  return null;
}
function expandV6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%"); if (zone >= 0) s = s.slice(0, zone);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) { const p = v4parts(dotted[1]); s = s.replace(dotted[1], `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`); }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : []; const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill("0");
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}
const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
function classifyV6(ip) {
  const g = expandV6(ip);
  if (!g) return "reserved";
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyV4(v4FromGroups(g[6], g[7])) || null; // ::ffff:a.b.c.d (IPv4-mapped)
  if (g.slice(0, 6).every((x) => x === 0)) return classifyV4(v4FromGroups(g[6], g[7])) || "reserved"; // ::a.b.c.d (deprecated IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(v4FromGroups(g[6], g[7])) || null; // NAT64
  if (g[0] === 0x2002) return classifyV4(v4FromGroups(g[1], g[2])) || null; // 6to4
  if ((g[0] & 0xffc0) === 0xfe80) return "linklocal";
  if ((g[0] & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  return null;
}
function classifyIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return classifyV4(ip);
  if (v === 6) return classifyV6(ip);
  return "reserved";
}
/** Throws unless the address class is acceptable under the current policy. `what` is only used in the message. */
function assertAddressAllowed(cls, what) {
  if (!cls) return;
  if (cls === "loopback") { if (!allowLoopback()) throw bad(`${what} must not point to this server.`); return; }
  if (cls === "private") { if (!allowPrivate()) throw bad(`${what} points to a private network address. Private / on-premise ERP hosts must be enabled explicitly (ERP_ALLOW_PRIVATE_NETWORK).`); return; }
  throw bad(`${what} points to a reserved address.`);
}

const BLOCKED_NAME = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp)$/i;
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal", "kubernetes.default.svc"]);
const allowedHosts = () => (process.env.ERP_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function validateBaseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw bad("Base URL is required.");
  if (raw.length > MAX_URL) throw bad("Base URL is too long.");
  if (/[\u0000-\u001f\u007f\s\\]/.test(raw.trim())) throw bad("Base URL contains invalid characters.");
  let u;
  try { u = new URL(raw.trim()); } catch { throw bad("Base URL is not a valid URL."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw bad("Base URL must start with https:// (or http:// outside production).");
  if (u.protocol === "http:" && !allowHttp()) throw bad("Base URL must use https:// in production.");
  if (u.username || u.password) throw bad("Base URL must not contain a user name or password.");
  if (u.search || u.hash) throw bad("Base URL must not contain a query string or fragment.");
  // WHATWG URL already normalises decimal / hex / octal IPv4 spellings (http://2130706433, http://0x7f.1) to dotted form.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw bad("Base URL must contain a host name.");
  const ipv = net.isIP(host);
  if (ipv) {
    const allow = allowedHosts();
    assertAddressAllowed(classifyIp(host), "Base URL");
    if (allow.length && !allow.includes(host)) throw bad("Base URL host is not on the allowed ERP host list.");
  } else {
    if (host === "localhost" || host.endsWith(".localhost")) { if (!allowLoopback()) throw bad("Base URL must not point to this server."); }
    else if (METADATA_NAMES.has(host)) throw bad("Base URL points to a reserved address.");
    else if (BLOCKED_NAME.test(host) && !allowPrivate()) throw bad("Base URL uses an internal-only host name. On-premise / VPN ERP hosts must be enabled explicitly (ERP_ALLOW_PRIVATE_NETWORK) and should be listed in ERP_ALLOWED_HOSTS.");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) && host !== "localhost") throw bad("Base URL host name is not valid.");
    const allow = allowedHosts();
    if (allow.length && !allow.includes(host)) throw bad("Base URL host is not on the allowed ERP host list.");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`; // canonical: no trailing slash
}

function validateServicePath(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  const p = String(raw).trim();
  if (!p.startsWith("/")) throw bad("Service path must start with '/'.");
  if (/[?#\\\s\u0000-\u001f]/.test(p) || p.includes("..") || p.includes("//") || /%(2e|2f|5c|00)/i.test(p)) throw bad("Service path contains invalid characters.");
  if (p.length > 255) throw bad("Service path is too long.");
  return p.replace(/\/+$/, "");
}

// ── connect-time DNS check (anti DNS-rebinding / "public name → internal address") ───────────
const dnsEnabled = () => (process.env.ERP_DNS_CHECK ? process.env.ERP_DNS_CHECK === "true" : isProd());
/**
 * Resolves the host of an already validated URL and refuses it when ANY returned address is not allowed. On by default in production only
 * (ERP_DNS_CHECK=true/false overrides) so development and tests need no DNS. `resolver` is injectable for tests.
 * Limitation (documented): the later fetch resolves the name again, so a hostile DNS server could still answer differently a moment later —
 * pair this with an egress firewall / ERP_ALLOWED_HOSTS.
 */
async function assertHostSafe(baseUrl, { resolver } = {}) {
  if (!resolver && !dnsEnabled()) return;
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return; // literals were fully classified by validateBaseUrl
  let addrs;
  try { addrs = await (resolver || ((h) => dns.promises.lookup(h, { all: true })))(host); } catch { throw new ErpIntegrationError("CONNECTION_ERROR"); }
  for (const a of addrs || []) assertAddressAllowed(classifyIp(a.address || a), "The ERP host name resolves to an address that");
}

module.exports = { validateBaseUrl, validateServicePath, assertHostSafe, classifyIp, classifyV4, classifyV6 };
