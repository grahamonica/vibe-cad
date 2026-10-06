import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { get } from "node:https";

export const VENDOR_FILE_LIMIT = 16 * 1024 * 1024;
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Accept only IPv6 global unicast; exclude documentation and special-use 2001 ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0*:|0*db8:|0*2:|0*10:|0*20:)/i.test(address);
}
export function vendorUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash)
    throw Error("Vendor CAD requires a public HTTPS download URL without credentials");
  return url;
}
/** Bounded, public-only download. DNS is pinned per request, including every redirect. No credentials. */
export async function downloadVendorFile(value: string) {
  let url = vendorUrl(value);
  const signal = AbortSignal.timeout(25_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error("Vendor CAD downloads cannot access private or reserved networks");
    const address = addresses[0];
    const response = await new Promise<import("node:http").IncomingMessage>((resolve,reject) => {
      const request = get(url, { signal, family: address.family, headers: { Accept: "application/step,model/step,application/octet-stream,*/*", "User-Agent": "VibeCAD/0.1 CAD-import" }, lookup: (_hostname,_options,callback) => callback(null,address.address,address.family) }, resolve);
      request.on("error",reject);
    });
    if ([301,302,303,307,308].includes(response.statusCode ?? 0)) {
      response.resume();
      if (!response.headers.location || redirects === 3) throw Error("Vendor CAD download has too many redirects");
      url = vendorUrl(new URL(response.headers.location,url).href);
      continue;
    }
    if (response.statusCode !== 200) { response.resume(); throw Error(`Vendor CAD download failed (${response.statusCode})`); }
    if (Number(response.headers["content-length"]) > VENDOR_FILE_LIMIT) { response.destroy(); throw Error("Vendor CAD exceeds the 16 MiB download limit"); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > VENDOR_FILE_LIMIT) { response.destroy(); throw Error("Vendor CAD exceeds the 16 MiB download limit"); }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const header = bytes.subarray(0,512).toString("utf8").trimStart();
    const step = header.startsWith("ISO-10303-21;");
    const stl = /^solid\b/i.test(header) || (bytes.length >= 84 && 84 + bytes.readUInt32LE(80) * 50 === bytes.length);
    if (!step && !stl) throw Error("The vendor URL did not return a STEP or STL file; use its direct CAD download link");
    const filename = decodeURIComponent(url.pathname.split("/").at(-1) || (step ? "vendor.step" : "vendor.stl")).replace(/[^\p{L}\p{N} _.()-]/gu,"_").slice(0,200);
    return { bytes, filename, url: url.href };
  }
  throw Error("Vendor CAD download failed");
}
