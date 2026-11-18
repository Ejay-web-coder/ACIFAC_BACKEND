// Unit tests (Jest). Run: npm run test:unit   One module: npm run test:unit -- __tests__/login
// The backend is native ES modules, so Jest runs with --experimental-vm-modules
// (see the test:unit script) and no Babel transform. The older node:test suites
// in test/ (including the database integration test) still run with npm test.
export default {
  testEnvironment: 'node',
  transform: {},
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.js'],
  setupFiles: ['<rootDir>/__tests__/setup/isolate-env.js'],
  verbose: true,
  reporters: ['default'],
  maxWorkers: 1,
};
