import { isIP } from "node:net";

const normalize = (ip = "") => ip.replace(/^::ffff:/, "");
const loopback = (ip) => ip === "::1" || ip === "127.0.0.1";
const ipv4Number = (ip) =>
  ip.split(".").reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
const localIPv4 = (ip) => {
  const [first, second] = ip.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
};

export function clientAddress(req, trustedProxies = []) {
  const remote = normalize(req.socket.remoteAddress);
  // Trust only the nearest hop, which the configured proxy must append/overwrite.
  if (loopback(remote) || trustedProxies.includes(remote)) {
    const forwarded = normalize(
      String(req.headers["x-forwarded-for"] || "")
        .split(",")
        .at(-1)
        .trim(),
    );
    if (isIP(forwarded)) return forwarded;
  }
  return isIP(remote) ? remote : "";
}

export function discoveryScopes(ip, networks) {
  if (!isIP(ip)) return [];
  const scopes = networks
    .filter((network) => {
      if (
        isIP(network.address) !== 4 ||
        isIP(network.netmask) !== 4 ||
        !localIPv4(network.address)
      )
        return false;
      if (loopback(ip)) return true;
      return (
        isIP(ip) === 4 &&
        (ipv4Number(ip) & ipv4Number(network.netmask)) ===
          (ipv4Number(network.address) & ipv4Number(network.netmask))
      );
    })
    .map(
      (network) =>
        `lan:${(ipv4Number(network.address) & ipv4Number(network.netmask)) >>> 0}/${network.netmask}`,
    );
  return [...scopes, `ip:${loopback(ip) ? "loopback" : ip}`];
}
