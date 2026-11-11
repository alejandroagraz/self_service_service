/**
 * Parser de `TRUSTED_PROXY_IPS`: la lista de proxies de los que Fastify acepta
 * `X-Forwarded-For` (opción `trustProxy`, rulebook §10.3).
 *
 * `request.ip` recorre `[IP del socket, entradas de X-Forwarded-For de derecha a izquierda]`
 * y devuelve la primera que **no** es de confianza. Si el socket no es de confianza, devuelve
 * la IP del socket y la cabecera no se lee. Por eso cada entrada de esta lista es una
 * dirección cuyo `X-Forwarded-For` se cree a ciegas: la lista correcta es la IP de Traefik y
 * nada más (`TRAEFIK_IP` en compose). Con `true`, cualquiera que llegue al contenedor sin pasar
 * por Traefik falsificaría su IP (y con ella todas las claves de rate limiting).
 *
 * Qué se rechaza (ver la implementación de referencia de identity para el detalle): vacío,
 * `true`/`*`/rangos con nombre, máscara de red, zona IPv6, comodines `/0`, IPv6 con IPv4
 * incrustada, CIDR con bits de host, y cualquier rango que no quepa entero en espacio privado o
 * de loopback (donde vive la IP de Traefik en la red de compose).
 */
import { isIP } from "node:net";

type Family = 4 | 6;

interface Block {
  readonly family: Family;
  readonly network: bigint;
  readonly prefix: number;
}

const BITS: Readonly<Record<Family, number>> = { 4: 32, 6: 128 };

const ipv4ToBigInt = (address: string): bigint =>
  address.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);

/** Solo recibe direcciones que `net.isIP` ya dio por IPv6 válidas y sin zona ni IPv4 incrustada. */
const ipv6ToBigInt = (address: string): bigint => {
  const [head = "", tail] = address.split("::");
  const headGroups = head.length > 0 ? head.split(":") : [];
  const tailGroups = tail !== undefined && tail.length > 0 ? tail.split(":") : [];
  const zeros = new Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
  const groups = tail === undefined ? headGroups : [...headGroups, ...zeros, ...tailGroups];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
};

const hostMask = (family: Family, prefix: number): bigint =>
  (1n << BigInt(BITS[family] - prefix)) - 1n;

const contains = (outer: Block, inner: Block): boolean =>
  outer.family === inner.family &&
  outer.prefix <= inner.prefix &&
  (inner.network & ~hostMask(outer.family, outer.prefix)) === outer.network;

const block = (family: Family, address: string, prefix: number): Block => ({
  family,
  network: family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address),
  prefix,
});

/** Espacio en el que puede vivir un proxy de confianza. Ver la cabecera. */
const ALLOWED_SPACE: readonly Block[] = [
  block(4, "10.0.0.0", 8),
  block(4, "172.16.0.0", 12),
  block(4, "192.168.0.0", 16),
  block(4, "127.0.0.0", 8),
  block(6, "fc00::", 7),
  block(6, "::1", 128),
];

const PREFIX_PATTERN = /^[0-9]{1,3}$/;

/** Devuelve el motivo de rechazo de una entrada, o `null` si es aceptable. */
const rejectionOf = (entry: string): string | null => {
  if (entry.length === 0) {
    return "entrada vacía (¿coma sobrante o duplicada?)";
  }
  const slash = entry.indexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const prefixText = slash === -1 ? null : entry.slice(slash + 1);

  if (address.includes("%")) {
    return "los identificadores de zona IPv6 (%iface) no se admiten";
  }
  const kind = isIP(address);
  if (kind !== 4 && kind !== 6) {
    return "no es una IP literal ni un CIDR (se esperaba p. ej. 172.30.0.2 o 172.30.0.0/24; no se admiten rangos con nombre ni `true`)";
  }
  if (kind === 6 && address.includes(".")) {
    return "IPv6 con IPv4 incrustada (::ffff:a.b.c.d): proxy-addr la hace cubrir IPv4; escribe la IPv4 directamente";
  }
  const family: Family = kind;
  const bits = BITS[family];

  let prefix = bits;
  if (prefixText !== null) {
    if (!PREFIX_PATTERN.test(prefixText)) {
      return `prefijo inválido "/${prefixText}" (solo longitud decimal, sin máscara de red)`;
    }
    prefix = Number(prefixText);
    if (prefix > bits) {
      return `prefijo /${String(prefix)} mayor que ${String(bits)}`;
    }
    if (prefix === 0) {
      return "comodín /0: equivale a trustProxy: true y deja falsificar la IP a cualquier cliente";
    }
  }

  const candidate = block(family, address, prefix);
  if ((candidate.network & hostMask(family, prefix)) !== 0n) {
    return `tiene bits de host fijados: confiaría en la /${String(prefix)} entera; escribe la IP sin prefijo o la dirección de red`;
  }
  if (!ALLOWED_SPACE.some((allowed) => contains(allowed, candidate))) {
    return "no cabe entero en espacio privado o de loopback (10/8, 172.16/12, 192.168/16, 127/8, fc00::/7, ::1), que es donde vive la IP de Traefik en la red de compose";
  }
  return null;
};

/**
 * Convierte el valor crudo en la lista para `trustProxy`. Lanza `Error` con todos los
 * motivos de rechazo a la vez; el llamador lo traduce a `EnvError`.
 */
export const parseTrustedProxies = (raw: string): string[] => {
  if (raw.trim().length === 0) {
    throw new Error(
      "está vacía: sin ella no hay forma de distinguir a Traefik de cualquier otro cliente. Debe ser la IP fija de Traefik (TRAEFIK_IP).",
    );
  }
  const entries = raw.split(",").map((entry) => entry.trim());
  const problems = entries
    .map((entry) => ({ entry, reason: rejectionOf(entry) }))
    .filter((item): item is { entry: string; reason: string } => item.reason !== null)
    .map(({ entry, reason }) => `"${entry}": ${reason}`);
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
  return entries;
};
