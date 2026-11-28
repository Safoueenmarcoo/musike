/**
 * The address the phone's media element gets for a YouTube stream. With the data saver on, the smaller stream; once
 * the equalizer has been used, the stream through the app's own address (MusikeStreamProxy.java), since Web Audio
 * silences sound that comes from another site.
 */

export const PROXY_PATH = "/_musike_stream";

export const proxied = (url: string, origin: string) => `${origin}${PROXY_PATH}?u=${encodeURIComponent(url)}`;

/** The stream behind a proxied address (or the address itself when it isn't one). */
export function unproxied(url: string, base = "https://localhost/"): string {
  try {
    const u = new URL(url, base);
    return u.pathname === PROXY_PATH ? (u.searchParams.get("u") ?? url) : url;
  } catch {
    return url;
  }
}

export function streamAddress(
  stream: { url: string; low?: { url: string } },
  opts: { saveData: boolean; proxy: boolean; origin: string },
): string {
  const url = opts.saveData && stream.low ? stream.low.url : stream.url;
  return opts.proxy ? proxied(url, opts.origin) : url;
}
