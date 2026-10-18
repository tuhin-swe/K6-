// Central configuration for the DMoney k6 performance test.
// Everything that a reviewer might want to tweak lives here, and every value
// can be overridden from the command line with `-e KEY=value` (k6 env vars).

export const CONFIG = {
  // --- Target system under test ---------------------------------------------
  baseUrl: __ENV.BASE_URL || 'https://dmoney.roadtocareer.net',
  // Partner / API secret key. In the Postman collection this is the
  // `X-AUTH-SECRET-KEY` header kept as a collection variable.
  secretKey: __ENV.SECRET_KEY || 'ROADTOSDET',

  // --- Privileged accounts (no OTP) used only during setup ------------------
  admin: {
    email: __ENV.ADMIN_EMAIL || 'admin@dmoney.com',
    password: __ENV.ADMIN_PASSWORD || '1234',
  },
  system: {
    email: __ENV.SYSTEM_EMAIL || 'system@dmoney.com',
    password: __ENV.SYSTEM_PASSWORD || '1234',
    account: 'SYSTEM', // SYSTEM is the funding source account in DMoney
  },

  // --- Transaction amounts --------------------------------------------------
  // DMoney business rules discovered by probing the API:
  //   * deposit  : 10 <= amount <= 10000, and a Customer's balance is capped
  //                at 10000 (balance-based, so it refills as they spend).
  //   * sendmoney: min 10, flat 5 tk fee on the sender.
  //   * payment  : min 10, flat 5 tk fee on the sender; merchants have no cap.
  // We keep per-transaction amounts tiny so no account ever runs dry across the
  // 2-minute run, and fund customers to a mid value that leaves head-room for
  // the in-test deposits (phases 2-3) without hitting the 10000 balance cap.
  amounts: {
    // Deposit amount is kept at the 10 tk minimum on purpose: an agent->customer
    // deposit injects `amount` into a wallet capped at 10000, and a larger value
    // (e.g. 100 x ~60/phase = 6000) would fill a customer up and get rejected
    // with "Limit exceeded" — a test-data artifact, not a server limit. 10 tk
    // keeps every deposit well inside the cap so the API itself is what we measure.
    deposit: Number(__ENV.AMT_DEPOSIT || 10),
    sendMoney: Number(__ENV.AMT_SEND || 10),
    payment: Number(__ENV.AMT_PAYMENT || 10),
    // one-time funding done in setup()
    fundAgent: Number(__ENV.AMT_FUND_AGENT || 200000),   // SYSTEM -> each agent
    fundCustomer: Number(__ENV.AMT_FUND_CUSTOMER || 5000), // agent -> each customer
  },

  // --- Load profile ----------------------------------------------------------
  // Each flow is a `constant-arrival-rate` scenario firing `rate` transactions
  // per second for its 30s window. Because later phases run more flows at once,
  // total throughput naturally climbs phase-by-phase, which is exactly the
  // "workload change" the assignment asks us to observe.
  rate: Number(__ENV.RATE || 2), // transactions / second / flow
  timeUnit: '1s',
  // Random think-time (seconds) added before each request. It de-syncs the
  // flows that a phase starts at the exact same instant, which sharply cuts the
  // server-side MySQL row-lock deadlocks that pure simultaneous hits to the same
  // account would otherwise cause. Set JITTER=0 to see the raw deadlock behaviour.
  jitterSeconds: Number(__ENV.JITTER || 0.6),
  // On a transient MySQL deadlock (HTTP 500, "try restarting transaction") the
  // client retries this many extra times, as the DB error itself advises.
  deadlockRetries: Number(__ENV.DEADLOCK_RETRIES || 3),
  // Each phase is this many seconds (assignment = 30). Overridable so a quick
  // smoke run can compress all four phases into a few seconds.
  phaseSeconds: Number(__ENV.PHASE_SECONDS || 30),
  preAllocatedVUs: Number(__ENV.PRE_VUS || 5),
  maxVUs: Number(__ENV.MAX_VUS || 15),
};

// The six test users. Emails must be @gmail.com (API rule). Each run appends a
// unique stamp so re-runs never collide with existing accounts.
const STAMP = (__ENV.USER_STAMP || String(Date.now())).slice(-6);

export const USER_STAMP = STAMP;

export const USERS = {
  A1: { key: 'A1', role: 'Agent',    name: `k6Agent1_${STAMP}`,    email: `k6.agent1.${STAMP}@gmail.com`,    phone: `0181${STAMP}0`.slice(0, 11), nid: `1181${STAMP}000`.slice(0, 13), password: '1234' },
  A2: { key: 'A2', role: 'Agent',    name: `k6Agent2_${STAMP}`,    email: `k6.agent2.${STAMP}@gmail.com`,    phone: `0182${STAMP}0`.slice(0, 11), nid: `1182${STAMP}000`.slice(0, 13), password: '1234' },
  C1: { key: 'C1', role: 'Customer', name: `k6Customer1_${STAMP}`, email: `k6.customer1.${STAMP}@gmail.com`, phone: `0161${STAMP}0`.slice(0, 11), nid: `1161${STAMP}000`.slice(0, 13), password: '1234' },
  C2: { key: 'C2', role: 'Customer', name: `k6Customer2_${STAMP}`, email: `k6.customer2.${STAMP}@gmail.com`, phone: `0162${STAMP}0`.slice(0, 11), nid: `1162${STAMP}000`.slice(0, 13), password: '1234' },
  M1: { key: 'M1', role: 'Merchant', name: `k6Merchant1_${STAMP}`, email: `k6.merchant1.${STAMP}@gmail.com`, phone: `0171${STAMP}0`.slice(0, 11), nid: `1171${STAMP}000`.slice(0, 13), password: '1234' },
  M2: { key: 'M2', role: 'Merchant', name: `k6Merchant2_${STAMP}`, email: `k6.merchant2.${STAMP}@gmail.com`, phone: `0172${STAMP}0`.slice(0, 11), nid: `1172${STAMP}000`.slice(0, 13), password: '1234' },
};
