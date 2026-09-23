import { getAllowedOrigins } from '../config/env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence for cookie-authenticated requests:
//  1. every state-changing request must carry the X-Requested-With header, which
//     browsers cannot add cross-site without a CORS preflight (blocked by CORS);
//  2. when the browser sends an Origin header it must be an allowed origin.
export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin ? String(req.headers.origin).replace(/\/$/, '') : null;
  if (origin && !getAllowedOrigins().includes(origin)) {
    return res.status(403).json({ success: false, message: 'Request origin is not allowed.' });
  }
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return res.status(403).json({ success: false, message: 'Missing request verification header.' });
  }
  return next();
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

export function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
