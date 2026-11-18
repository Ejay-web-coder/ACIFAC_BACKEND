// Builds one results table from the module runs that loadtest/run-modules.ps1 saved.
//
//   node loadtest/module-table.mjs loadtest/results/load-20261112-0930
//
// Reads every <module>.json (k6 --summary-export) in the folder and writes
// summary.md and summary.csv next to them: one row per endpoint and one total
// row per module.

import fs from 'node:fs';
import path from 'node:path';

const folder = process.argv[2];
if (!folder || !fs.existsSync(folder)) {
  console.error('Use: node loadtest/module-table.mjs <results folder>');
  process.exit(1);
}

const ORDER = ['auth', 'dashboard', 'members', 'savings', 'loans', 'machinery', 'kadiwa', 'vendor', 'attendance', 'analytics', 'ocr', 'users', 'communication', 'about', 'member-portal'];
const files = fs.readdirSync(folder).filter((f) => f.endsWith('.json'))
  .sort((a, b) => (ORDER.indexOf(a.slice(0, -5)) + 1 || 99) - (ORDER.indexOf(b.slice(0, -5)) + 1 || 99));
if (!files.length) {
  console.error(`No k6 results (*.json) in ${folder}.`);
  process.exit(1);
}

const ms = (value) => (value === undefined ? '' : value < 10 ? value.toFixed(1) : Math.round(value).toString());
const pct = (value) => `${(value * 100).toFixed(2)}%`;
// In --summary-export, a threshold that is false was not crossed.
const passed = (metric) => !metric || Object.values(metric.thresholds || {}).every((crossed) => crossed === false);

const rows = [];
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
  const metrics = data.metrics || {};
  const moduleName = file.slice(0, -5);
  const label = data.setup_data?.label || moduleName;
  // No setup data: k6 stopped before the test started (the reason is in its output).
  if (!data.setup_data) {
    rows.push({ module: label, endpoint: 'DID NOT RUN (stopped in setup, see the k6 output)', requests: 0, rate: '', avg: '', p95: '', max: '', errors: '', result: 'NOT RUN', total: true });
    continue;
  }
  // In the order the test script lists them (older exports: as found).
  const found = Object.keys(metrics)
    .filter((key) => key.startsWith('http_req_duration{name:') && !key.includes('name:setup') && !key.includes('name:sign-in'))
    .map((key) => key.slice('http_req_duration{name:'.length, -1));
  const listed = data.setup_data?.endpoints || [];
  const endpoints = [...listed.filter((name) => found.includes(name)), ...found.filter((name) => !listed.includes(name))];
  // Test length in seconds, for requests per second.
  const seconds = metrics.http_reqs?.rate ? metrics.http_reqs.count / metrics.http_reqs.rate : 0;
  const perSecond = (count) => (seconds ? (count / seconds).toFixed(1) : '');

  let total = 0;
  let weighted = 0;
  let slowest = 0;
  let max = 0;
  const start = rows.length;
  for (const name of endpoints) {
    const duration = metrics[`http_req_duration{name:${name}}`];
    const failed = metrics[`http_req_failed{name:${name}}`] || { passes: 0, fails: 0, value: 0 };
    const count = (failed.passes || 0) + (failed.fails || 0);
    total += count;
    weighted += (duration.avg || 0) * count;
    slowest = Math.max(slowest, duration['p(95)'] || 0);
    max = Math.max(max, duration.max || 0);
    rows.push({
      module: label, endpoint: name, requests: count, rate: perSecond(count), avg: ms(duration.avg), p95: ms(duration['p(95)']), max: ms(duration.max),
      errors: pct(failed.value || 0), result: passed(duration) && passed(failed) ? 'PASS' : 'FAIL',
    });
  }
  // The module as a whole: its endpoints only (not the sign-in and setup requests).
  rows.push({
    module: label, endpoint: `TOTAL (${data.setup_data?.testType || 'test'}, up to ${metrics.vus_max?.max ?? '?'} users)`, requests: total,
    rate: perSecond(total), avg: total ? ms(weighted / total) : '', p95: ms(slowest), max: ms(max),
    errors: pct(metrics.http_req_failed?.value || 0),
    result: passed(metrics.http_req_failed) && passed(metrics.checks) && rows.slice(start).every((r) => r.result === 'PASS') ? 'PASS' : 'FAIL',
    total: true,
  });
}

const header = ['Module', 'Endpoint', 'Requests', 'Req/s', 'Avg (ms)', 'p95 (ms)', 'Max (ms)', 'Errors', 'Result'];
const cells = (r) => [r.module, r.endpoint, r.requests, r.rate, r.avg, r.p95, r.max, r.errors, r.result];

const md = [
  `# Load test results by module`,
  '',
  `Folder: ${folder}. p95 = 95% of requests finished within this time. Targets: p95 under 1000 ms (login 3000 ms), errors under 1%.`,
  'TOTAL rows: all of the module\'s requests; Avg is the average over them, p95 the slowest endpoint\'s p95, Errors the share of all its requests (sign-in included) that failed.',
  '',
  `| ${header.join(' | ')} |`,
  `| ${header.map((h, i) => (i >= 2 && i <= 7 ? '---:' : '---')).join(' | ')} |`,
  ...rows.map((r) => `| ${cells(r).map((c, i) => (r.total && i < 2 ? `**${c}**` : c)).join(' | ')} |`),
  '',
].join('\n');
const csv = [header, ...rows.map(cells)].map((line) => line.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');

fs.writeFileSync(path.join(folder, 'summary.md'), md);
fs.writeFileSync(path.join(folder, 'summary.csv'), csv);

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(cells(r)[i]).length)));
const line = (values) => values.map((v, i) => String(v).padEnd(widths[i])).join('  ');
console.log(line(header));
for (const r of rows) {
  console.log(line(cells(r)));
  if (r.total) console.log('');
}
console.log(`Saved ${path.join(folder, 'summary.md')} and summary.csv (opens in Excel).`);
