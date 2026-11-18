import { CapacitorHttp } from "@capacitor/core";

/**
 * Plain-http requests to the desktop app on the same Wi-Fi (remote playback, server/src/connect.ts). They go through
 * Android's own HTTP stack: the web view would block http from an https page. The body is the devices' encrypted
 * messages, sent as text; short timeouts, so a computer that left the network is noticed quickly.
 */
export const lanFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const res = await CapacitorHttp.request({
    url,
    method: init?.method ?? "GET",
    headers: { "content-type": "text/plain" },
    data: typeof init?.body === "string" ? init.body : undefined,
    responseType: "text",
    connectTimeout: 2000,
    readTimeout: 4000,
  });
  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  return new Response(body, { status: res.status });
};
