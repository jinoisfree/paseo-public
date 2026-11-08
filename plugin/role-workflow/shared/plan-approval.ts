/** Canonical JSON shared by the server inbox and the rendered plan decision. */
export function canonicalDecision(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDecision).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalDecision(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 without runtime imports: a display identity, never an approval token. */
export function decisionHash(decision: unknown): string {
  const bytes: number[] = [];
  for (const char of canonicalDecision(decision)) {
    const point = char.codePointAt(0)!;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | point >>> 6, 0x80 | point & 63);
    else if (point < 0x10000) bytes.push(0xe0 | point >>> 12, 0x80 | point >>> 6 & 63, 0x80 | point & 63);
    else bytes.push(0xf0 | point >>> 18, 0x80 | point >>> 12 & 63, 0x80 | point >>> 6 & 63, 0x80 | point & 63);
  }
  const bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let n = 7; n >= 0; n--) bytes.push(Math.floor(bitLength / 2 ** (n * 8)) & 255);
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) if (!primes.some(p => p * p <= n && n % p === 0)) primes.push(n);
  const frac = (n: number) => (n - Math.floor(n)) * 0x100000000 | 0;
  const k = primes.map(p => frac(Math.cbrt(p)));
  const h = primes.slice(0, 8).map(p => frac(Math.sqrt(p)));
  const rotr = (n: number, r: number) => n >>> r | n << (32 - r);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w: number[] = [];
    for (let i = 0; i < 16; i++) w[i] = bytes[offset + i*4] << 24 | bytes[offset + i*4+1] << 16 | bytes[offset + i*4+2] << 8 | bytes[offset + i*4+3];
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      w[i] = (w[i-16] + (rotr(x,7)^rotr(x,18)^x>>>3) + w[i-7] + (rotr(y,17)^rotr(y,19)^y>>>10)) | 0;
    }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotr(e,6)^rotr(e,11)^rotr(e,25)) + (e&f ^ ~e&g) + k[i] + w[i]) | 0;
      const t2 = ((rotr(a,2)^rotr(a,13)^rotr(a,22)) + (a&b ^ a&c ^ b&c)) | 0;
      j=g; g=f; f=e; e=d+t1|0; d=c; c=b; b=a; a=t1+t2|0;
    }
    [a,b,c,d,e,f,g,j].forEach((n,i) => { h[i] = h[i]+n|0; });
  }
  return h.map(n => (n>>>0).toString(16).padStart(8,"0")).join("");
}
