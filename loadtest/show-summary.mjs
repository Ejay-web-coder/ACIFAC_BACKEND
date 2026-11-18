// Shows a saved k6 run as a k6-style summary under a module title, on a clean
// screen, ready for a screenshot.
//
//   node loadtest/show-summary.mjs loans                     one module from the newest results folder
//   node loadtest/show-summary.mjs 5                         the same, by module number
//   node loadtest/show-summary.mjs                           every module there, one screen each (Enter = next)
//   node loadtest/show-summary.mjs loadtest/results/load-20261112-1000 loans
//   node loadtest/show-summary.mjs loadtest/results/all-load.json --title "ALL MODULES TOGETHER"
//
// It reads the JSON that k6 --summary-export saved (run-modules.ps1 saves one per
// module). --no-clear keeps what is on the screen.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ORDER = ['auth', 'dashboard', 'members', 'savings', 'loans', 'machinery', 'kadiwa', 'vendor', 'attendance', 'analytics', 'ocr', 'users', 'communication', 'about', 'member-portal'];
const RESULTS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'results');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const title = flag('--title');
const noClear = args.includes('--no-clear');
const positional = args.filter((a) => a !== '--no-clear');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Which files to show.
let folder = null;
let files = [];
const wanted = [];
for (const arg of positional) {
  if (arg.endsWith('.json') && fs.existsSync(arg)) files.push(arg);
  else if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) folder = arg;
  else wanted.push(/^\d+$/.test(arg) ? ORDER[Number(arg) - 1] || arg : arg);
}
if (!files.length) {
  if (!folder) {
    const folders = fs.existsSync(RESULTS)
      ? fs.readdirSync(RESULTS).map((name) => path.join(RESULTS, name))
        .filter((p) => fs.statSync(p).isDirectory() && fs.readdirSync(p).some((f) => f.endsWith('.json')))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      : [];
    if (!folders.length) fail('No saved results yet. Run loadtest/run-modules.ps1 first, or give a results folder or .json file.');
    folder = folders[0];
  }
  const available = fs.readdirSync(folder).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const names = wanted.length ? wanted : available.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  for (const name of names) {
    if (!available.includes(name)) fail(`No result for "${name}" in ${folder}. There is: ${available.join(', ')}`);
    files.push(path.join(folder, `${name}.json`));
  }
}

// Colours, as k6 uses them (none when NO_COLOR is set or the output is not a terminal).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const green = paint('32');
const red = paint('31');
const cyan = paint('36');
const dim = paint('2');
const bold = paint('1');

const duration = (ms) => {
  if (ms === undefined || ms === null) return '-';
  if (ms >= 1000) return `${+(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${+ms.toFixed(2)}ms`;
  return `${+(ms * 1000).toFixed(2)}µs`;
};
const percent = (rate) => `${((rate || 0) * 100).toFixed(2)}%`;
const number = (n) => Math.round(n || 0).toLocaleString('en-US');
const plural = (n, word) => `${number(n)} ${word}${Math.round(n || 0) === 1 ? '' : 's'}`;
const clock = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
};

// "p(95)<1000" -> the value it was compared with, formatted like k6.
function thresholdValue(metric, expression) {
  const stat = expression.match(/^\s*([a-z]+(?:\([\d.]+\))?)/)?.[1];
  if (!stat) return '';
  if (stat === 'rate') return `rate=${percent(metric.value)}`;
  if (stat === 'count') return `count=${number(metric.count)}`;
  return `${stat}=${duration(metric[stat])}`;
}

// "1m30s" -> 90
const toSeconds = (text) => [...String(text).matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)]
  .reduce((sum, [, n, unit]) => sum + Number(n) * { h: 3600, m: 60, s: 1 }[unit], 0);

const TEST_TYPES = { smoke: 'smoke test', load: 'load test', stress: 'stress test', spike: 'spike test' };
function describeStages(stages) {
  let users = 0;
  return stages.map((stage) => {
    const text = stage.target === users ? `${stage.target} for ${stage.duration}` : `${users} → ${stage.target} in ${stage.duration}`;
    users = stage.target;
    return text;
  }).join(', ');
}

const LOGO = [
  '         /\\      Grafana   /‾‾/  ',
  '    /\\  /  \\     |\\  __   /  /   ',
  '   /  \\/    \\    | |/ /  /   ‾‾\\ ',
  '  /          \\   |   (  |  (‾)  |',
  ' / __________ \\  |_|\\_\\  \\_____/ ',
];

function render(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const metrics = data.metrics || {};
  const setup = data.setup_data || {};
  const moduleName = path.basename(file, '.json');
  const number_ = ORDER.indexOf(setup.module || moduleName) + 1;
  const heading = title || (setup.module || number_
    ? `MODULE ${number_}: ${String(setup.label || moduleName).toUpperCase()}`
    : String(setup.label || moduleName).toUpperCase());

  const reqs = metrics.http_reqs || {};
  const seconds = reqs.rate ? reqs.count / reqs.rate : 0;
  const users = metrics.vus_max?.max ?? metrics.vus_max?.value;
  const lines = [];
  const out = (text = '') => lines.push(text);

  out();
  for (const line of LOGO) out(cyan(line));
  out();
  out(`  ${bold(heading)}`);
  out();
  out(`     ${dim('execution:')} local, summary of the saved run`);
  out(`        ${dim('script:')} ${setup.module ? 'loadtest/modules.k6.js' : setup.label ? 'loadtest/acifac.k6.js' : '-'}`);
  const relative = path.relative(process.cwd(), file);
  out(`        ${dim('source:')} ${(relative.startsWith('..') ? path.resolve(file) : relative).replace(/\\/g, '/')}`);
  const scenario = [
    `${TEST_TYPES[setup.testType] || 'test'}: up to ${users === undefined ? '? users' : plural(users, 'user')}`,
    setup.stages ? `(${describeStages(setup.stages)})` : null,
    setup.endpoints ? `across ${setup.endpoints.length} endpoints` : null,
  ].filter(Boolean).join(' ');
  out(`     ${dim('scenarios:')} ${scenario}`);
  // Planned length from the stages; a run much shorter than that was stopped.
  const planned = (setup.stages || []).reduce((sum, stage) => sum + toSeconds(stage.duration), 0);
  const early = planned && seconds < planned - 5 ? `  ${red(`(stopped early: ${clock(planned)} planned)`)}` : '';
  out(`      ${dim('duration:')} ${clock(seconds)}, ${number(reqs.count)} requests (${(reqs.rate || 0).toFixed(1)}/s), ${plural(metrics.iterations?.count, 'round')}${early}`);
  out();
  if (!data.setup_data) {
    out(`  ${red(bold('✗ DID NOT RUN: k6 stopped in setup, before any user started. The reason is in the k6 output of this run.'))}`);
    out();
    return lines.join('\n');
  }

  // Thresholds: the module-wide ones, then one per endpoint (in the order the script lists them).
  const withThresholds = Object.keys(metrics).filter((key) => metrics[key].thresholds);
  const order = (key) => {
    if (key === 'http_req_failed') return [0, 0];
    if (key === 'checks') return [1, 0];
    const name = key.match(/\{name:(.*)\}$/)?.[1];
    const index = name && setup.endpoints ? setup.endpoints.indexOf(name) : -1;
    return [key.startsWith('http_req_failed{') ? 3 : 2, index === -1 ? 999 : index];
  };
  withThresholds.sort((a, b) => {
    const [ga, ia] = order(a);
    const [gb, ib] = order(b);
    return ga - gb || ia - ib || a.localeCompare(b);
  });

  let crossed = 0;
  let total = 0;
  const perEndpointErrors = withThresholds.filter((key) => key.startsWith('http_req_failed{name:'));
  out(`  ${bold('█ THRESHOLDS')}`);
  out();
  for (const key of withThresholds) {
    if (perEndpointErrors.length > 3 && perEndpointErrors.includes(key)) continue; // folded below
    out(`    ${key}`);
    for (const [expression, wasCrossed] of Object.entries(metrics[key].thresholds)) {
      total += 1;
      if (wasCrossed) crossed += 1;
      out(`    ${wasCrossed ? red('✗') : green('✓')} '${expression}' ${thresholdValue(metrics[key], expression)}`);
    }
    out();
  }
  // Error rate of every endpoint in one block, so a long module still fits on one screen.
  if (perEndpointErrors.length > 3) {
    const failing = perEndpointErrors.filter((key) => Object.values(metrics[key].thresholds).some(Boolean));
    const worst = Math.max(...perEndpointErrors.map((key) => metrics[key].value || 0));
    total += perEndpointErrors.length;
    crossed += failing.length;
    out(`    http_req_failed{name:<each of the ${perEndpointErrors.length} endpoints>}`);
    out(`    ${failing.length ? red('✗') : green('✓')} 'rate<0.01' highest=${percent(worst)}${failing.length ? `  (${failing.length} crossed)` : ''}`);
    for (const key of failing) out(`      ${red('✗')} ${key.slice('http_req_failed'.length)} rate=${percent(metrics[key].value)}`);
    out();
  }

  const d = metrics.http_req_duration || {};
  const failed = metrics.http_req_failed || {};
  out(`  ${bold('█ TOTAL RESULTS')}`);
  out();
  out(`    http_reqs..........: ${number(reqs.count)}  ${(reqs.rate || 0).toFixed(2)}/s`);
  out(`    http_req_duration..: avg=${duration(d.avg)} med=${duration(d.med)} p(95)=${duration(d['p(95)'])} max=${duration(d.max)}`);
  out(`    http_req_failed....: ${percent(failed.value)}  ${number(failed.passes)} out of ${number((failed.passes || 0) + (failed.fails || 0))}`);
  out(`    checks.............: ${percent(metrics.checks?.value)}  ${number(metrics.checks?.passes)} out of ${number((metrics.checks?.passes || 0) + (metrics.checks?.fails || 0))}`);
  out(`    iterations.........: ${number(metrics.iterations?.count)}`);
  out(`    vus_max............: ${users ?? '-'}`);
  out();
  out(crossed
    ? `  ${red(bold(`✗ FAILED: ${crossed} of ${total} thresholds crossed`))}`
    : `  ${green(bold(`✓ PASSED: all ${total} thresholds met`))}`);
  out();
  return lines.join('\n');
}

const clear = () => {
  if (!noClear && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
};
const waitForEnter = (prompt) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(prompt, () => { rl.close(); resolve(); });
});

for (let i = 0; i < files.length; i++) {
  clear();
  process.stdout.write(render(files[i]));
  process.stdout.write('\n');
  if (i < files.length - 1 && process.stdout.isTTY) await waitForEnter(dim(`  Enter: next module (${i + 2}/${files.length})   Ctrl+C: stop `));
}
