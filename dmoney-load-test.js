/**
 * DMoney transaction performance test  (k6)
 * ------------------------------------------------------------------------
 * Simulates 2 minutes of DMoney activity for 6 users (2 Agents, 2 Customers,
 * 2 Merchants) across four 30-second phases. Each phase runs its flows
 * concurrently as independent `constant-arrival-rate` scenarios, so the flows
 * assigned to a time window all fire together and keep firing for the whole
 * window — and total throughput rises phase-by-phase as more flows overlap.
 *
 *   Phase 1 (0-30s) : C1->C2 sendmoney | C2->M1 payment
 *   Phase 2 (30-60s): C2->C1 sendmoney | A1->C2 deposit | C1->M1 payment
 *   Phase 3 (60-90s): A1->C1 deposit | A2->C2 deposit | C1->C2 sendmoney | C2->M2 payment
 *   Phase 4 (90-120): A1->M1 payment | A2->M2 payment | C1->M1 payment | C2->M2 payment
 *
 * APIs under test: /transaction/deposit, /transaction/sendmoney, /transaction/payment
 *
 * Run:   k6 run dmoney-load-test.js
 * HTML:  written to reports/summary.html by handleSummary() below.
 */
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/2.4.0/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

import { CONFIG, USERS } from './config.js';
import { login, createUser, activateUser, mintUserToken, deposit } from './lib/auth.js';
import { runTransaction } from './lib/transactions.js';

// ---------------------------------------------------------------------------
// Load profile: one scenario per flow. A flow's `phase` (1-4) decides when it
// starts — phase N begins at (N-1) x phaseSeconds — and each flow lasts exactly
// one phase, so all flows in the same phase run concurrently for the whole
// window. Deriving startTime from phaseSeconds lets a smoke run compress all
// four phases just by setting PHASE_SECONDS=3.
// ---------------------------------------------------------------------------
function flow(phase, exec) {
  const secs = CONFIG.phaseSeconds;
  return {
    executor: 'constant-arrival-rate',
    rate: CONFIG.rate,
    timeUnit: CONFIG.timeUnit,
    duration: `${secs}s`,
    startTime: `${(phase - 1) * secs}s`,
    preAllocatedVUs: CONFIG.preAllocatedVUs,
    maxVUs: CONFIG.maxVUs,
    exec,
  };
}

export const options = {
  // Keep full per-flow granularity in the end-of-test summary.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    // Phase 1 — 0 to 30s
    p1_c1_send_c2: flow(1, 'flow_p1_c1_send_c2'),
    p1_c2_pay_m1: flow(1, 'flow_p1_c2_pay_m1'),
    // Phase 2 — 30 to 60s
    p2_c2_send_c1: flow(2, 'flow_p2_c2_send_c1'),
    p2_a1_dep_c2: flow(2, 'flow_p2_a1_dep_c2'),
    p2_c1_pay_m1: flow(2, 'flow_p2_c1_pay_m1'),
    // Phase 3 — 60 to 90s
    p3_a1_dep_c1: flow(3, 'flow_p3_a1_dep_c1'),
    p3_a2_dep_c2: flow(3, 'flow_p3_a2_dep_c2'),
    p3_c1_send_c2: flow(3, 'flow_p3_c1_send_c2'),
    p3_c2_pay_m2: flow(3, 'flow_p3_c2_pay_m2'),
    // Phase 4 — 90 to 120s
    p4_a1_pay_m1: flow(4, 'flow_p4_a1_pay_m1'),
    p4_a2_pay_m2: flow(4, 'flow_p4_a2_pay_m2'),
    p4_c1_pay_m1: flow(4, 'flow_p4_c1_pay_m1'),
    p4_c2_pay_m2: flow(4, 'flow_p4_c2_pay_m2'),
  },
  thresholds: {
    // ---- global requirements from the assignment --------------------------
    http_req_failed: ['rate<0.01'],      // < 1% failed requests
    http_req_duration: ['p(95)<1000'],   // p95 under 1000 ms
    checks: ['rate>0.99'],               // > 99% of checks pass

    // ---- separate thresholds per API (via request tags) -------------------
    'http_req_duration{api:deposit}': ['p(95)<1000'],
    'http_req_duration{api:sendmoney}': ['p(95)<1000'],
    'http_req_duration{api:payment}': ['p(95)<1000'],
    'http_req_failed{api:deposit}': ['rate<0.01'],
    'http_req_failed{api:sendmoney}': ['rate<0.01'],
    'http_req_failed{api:payment}': ['rate<0.01'],
    'checks{api:deposit}': ['rate>0.99'],
    'checks{api:sendmoney}': ['rate>0.99'],
    'checks{api:payment}': ['rate>0.99'],

    // ---- custom per-API trends (duplicate guard + nice report rows) -------
    deposit_duration: ['p(95)<1000'],
    sendmoney_duration: ['p(95)<1000'],
    payment_duration: ['p(95)<1000'],

    // ---- per-phase sub-metrics (always pass; only to surface the rows so we
    //      can read response-time degradation phase-by-phase in the summary) -
    'http_req_duration{phase:p1}': ['max>=0'],
    'http_req_duration{phase:p2}': ['max>=0'],
    'http_req_duration{phase:p3}': ['max>=0'],
    'http_req_duration{phase:p4}': ['max>=0'],
  },
};

// ---------------------------------------------------------------------------
// setup(): provision everything, then hand tokens + phone numbers to the VUs.
// ---------------------------------------------------------------------------
export function setup() {
  console.log('--- setup: provisioning 6 users + minting tokens ---');
  const adminToken = login(CONFIG.admin.email, CONFIG.admin.password);
  const systemToken = login(CONFIG.system.email, CONFIG.system.password);

  const phones = {};
  const tokens = {};

  // 1) create + activate all six accounts
  for (const key of Object.keys(USERS)) {
    const u = USERS[key];
    const created = createUser(adminToken, u);
    phones[key] = u.phone;
    activateUser(adminToken, created.id);
    console.log(`  ${key} ${u.role} ${u.phone} -> active (id ${created.id})`);
  }

  // 2) mint own-account tokens for the 4 initiators (merchants only receive)
  for (const key of ['A1', 'A2', 'C1', 'C2']) {
    tokens[key] = mintUserToken(adminToken, USERS[key]);
    console.log(`  ${key} token minted`);
  }

  // 3) fund the agents from SYSTEM (unlimited), then fund the customers from
  //    Agent 1 (SYSTEM may only deposit to agents; agent->customer is capped at
  //    10000/deposit and by the customer's 10000 balance ceiling).
  for (const key of ['A1', 'A2']) {
    const r = deposit(systemToken, CONFIG.system.account, phones[key], CONFIG.amounts.fundAgent);
    console.log(`  fund agent ${key} from SYSTEM ${CONFIG.amounts.fundAgent} -> ${r.status}`);
  }
  for (const key of ['C1', 'C2']) {
    const r = deposit(tokens.A1, phones.A1, phones[key], CONFIG.amounts.fundCustomer);
    console.log(`  fund customer ${key} from A1 ${CONFIG.amounts.fundCustomer} -> ${r.status} ${r.status >= 300 ? r.body : ''}`);
  }

  console.log('--- setup complete ---');
  return { baseUrl: CONFIG.baseUrl, secretKey: CONFIG.secretKey, phones, tokens };
}

// ---------------------------------------------------------------------------
// The 13 flow functions. Each is a thin wrapper around runTransaction so the
// scenario table above stays readable and every flow is independently taggable.
// ---------------------------------------------------------------------------
const A = CONFIG.amounts;

// Phase 1
export function flow_p1_c1_send_c2(d) { runTransaction(d, { type: 'sendmoney', fromKey: 'C1', toKey: 'C2', amount: A.sendMoney, phase: 'p1' }); }
export function flow_p1_c2_pay_m1(d) { runTransaction(d, { type: 'payment', fromKey: 'C2', toKey: 'M1', amount: A.payment, phase: 'p1' }); }
// Phase 2
export function flow_p2_c2_send_c1(d) { runTransaction(d, { type: 'sendmoney', fromKey: 'C2', toKey: 'C1', amount: A.sendMoney, phase: 'p2' }); }
export function flow_p2_a1_dep_c2(d) { runTransaction(d, { type: 'deposit', fromKey: 'A1', toKey: 'C2', amount: A.deposit, phase: 'p2' }); }
export function flow_p2_c1_pay_m1(d) { runTransaction(d, { type: 'payment', fromKey: 'C1', toKey: 'M1', amount: A.payment, phase: 'p2' }); }
// Phase 3
export function flow_p3_a1_dep_c1(d) { runTransaction(d, { type: 'deposit', fromKey: 'A1', toKey: 'C1', amount: A.deposit, phase: 'p3' }); }
export function flow_p3_a2_dep_c2(d) { runTransaction(d, { type: 'deposit', fromKey: 'A2', toKey: 'C2', amount: A.deposit, phase: 'p3' }); }
export function flow_p3_c1_send_c2(d) { runTransaction(d, { type: 'sendmoney', fromKey: 'C1', toKey: 'C2', amount: A.sendMoney, phase: 'p3' }); }
export function flow_p3_c2_pay_m2(d) { runTransaction(d, { type: 'payment', fromKey: 'C2', toKey: 'M2', amount: A.payment, phase: 'p3' }); }
// Phase 4
export function flow_p4_a1_pay_m1(d) { runTransaction(d, { type: 'payment', fromKey: 'A1', toKey: 'M1', amount: A.payment, phase: 'p4' }); }
export function flow_p4_a2_pay_m2(d) { runTransaction(d, { type: 'payment', fromKey: 'A2', toKey: 'M2', amount: A.payment, phase: 'p4' }); }
export function flow_p4_c1_pay_m1(d) { runTransaction(d, { type: 'payment', fromKey: 'C1', toKey: 'M1', amount: A.payment, phase: 'p4' }); }
export function flow_p4_c2_pay_m2(d) { runTransaction(d, { type: 'payment', fromKey: 'C2', toKey: 'M2', amount: A.payment, phase: 'p4' }); }

// ---------------------------------------------------------------------------
// Reports: a shareable HTML summary + machine-readable JSON + console text.
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  return {
    'reports/summary.html': htmlReport(data),
    'reports/summary.json': JSON.stringify(data, null, 2),
    'reports/summary.txt': textSummary(data, { indent: ' ', enableColors: false }),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
