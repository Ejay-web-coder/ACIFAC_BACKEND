import { jest } from '@jest/globals';

// A stand-in for Express's req object.
export function mockRequest({ body = {}, cookies = {}, headers = {}, ip = '127.0.0.1', method = 'GET', originalUrl = '/', user, params = {}, query = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { body, cookies, headers: lower, ip, method, originalUrl, user, params, query, get: (name) => lower[String(name).toLowerCase()] };
}

// A stand-in for Express's res object that records what the handler sent.
export function mockResponse() {
  const res = { statusCode: 200, headers: {}, body: undefined, cookies: {}, cleared: [] };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.setHeader = jest.fn((name, value) => { res.headers[String(name).toLowerCase()] = value; return res; });
  res.cookie = jest.fn((name, value, options) => { res.cookies[name] = { value, options }; return res; });
  res.clearCookie = jest.fn((name) => { res.cleared.push(name); return res; });
  return res;
}

// Makes a mocked query function answer by SQL text: the first route whose text
// appears in the statement gives the result (a value, or a function of the
// parameters). Anything else answers { rows: [], rowCount: 0 }.
export function answer(queryFn, routes) {
  queryFn.mockImplementation(async (sql, params) => {
    const route = routes.find(([text]) => String(sql).includes(text));
    if (!route) return { rows: [], rowCount: 0 };
    const result = typeof route[1] === 'function' ? route[1](params) : route[1];
    if (result instanceof Error) throw result;
    return { rowCount: result.rows?.length ?? 0, ...result };
  });
}

// Mock of src/services/emailService.js: nothing is sent, nothing is printed.
export function mockEmailService() {
  return {
    isEmailConfigured: jest.fn(() => false),
    setEmailTransportForTesting: jest.fn(),
    buildLink: jest.fn((path) => `http://localhost:5173${path}`),
    sendEmail: jest.fn(async () => ({ sent: false, skipped: true })),
    sendEmailSafely: jest.fn(async () => ({ sent: false, skipped: true })),
    sendTestEmail: jest.fn(async () => ({ sent: false, skipped: true })),
  };
}

// Mock of src/config/db.js: every export the app imports, with a fake client
// for transactions. query() answers { rows: [] } unless a test says otherwise.
export function mockDatabase() {
  const client = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() };
  const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
  return {
    client,
    module: {
      query,
      withTransaction: jest.fn(async (fn) => fn(client)),
      getPool: jest.fn(() => ({ connect: async () => client, query })),
      getDatabaseUrl: jest.fn(() => ''),
      createDedicatedClient: jest.fn(() => client),
      default: null,
    },
  };
}
