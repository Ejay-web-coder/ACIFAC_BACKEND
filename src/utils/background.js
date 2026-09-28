// Work that finishes after the response (emails, status refreshes).
//
// On Vercel a function may be frozen as soon as its response is sent, which
// would cut an email off halfway. Vercel exposes a per-request `waitUntil` on
// this global (the same lookup @vercel/functions uses); passing the promise to
// it keeps the function alive until the work settles, without delaying the
// response. On a normal server the lookup finds nothing and the promise simply
// runs to completion.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

export function keepAlive(promise) {
  try {
    globalThis[REQUEST_CONTEXT]?.get?.()?.waitUntil?.(promise);
  } catch {
    // Outside a request (tests, scripts): nothing to extend.
  }
  return promise;
}
