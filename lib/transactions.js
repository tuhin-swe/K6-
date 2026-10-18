// A single, reusable transaction runner shared by all 13 flow functions.
// It fires one /transaction/* request, tags it by api + phase (so we can slice
// the metrics later), records the per-API custom metrics, and runs the four
// assertions the assignment requires.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { CONFIG } from '../config.js';
import { METRICS } from './metrics.js';

// Expected success message fragment per API (case-insensitive match).
const SUCCESS_MESSAGE = {
  deposit: /deposit/i,
  sendmoney: /send/i,
  payment: /payment/i,
};

// Pull a transaction id out of whatever shape the API returns it in.
function extractTrnxId(body) {
  if (!body || typeof body !== 'object') return undefined;
  return body.trnxId
    || (body.transaction && body.transaction.trnxId)
    || (body.data && body.data.trnxId);
}

/**
 * @param data  the object returned by setup(): { baseUrl, secretKey, phones, tokens }
 * @param type  'deposit' | 'sendmoney' | 'payment'
 * @param fromKey / toKey  user keys ('A1','C2',...) into data.phones / data.tokens
 * @param amount number
 * @param phase  'p1'..'p4'  (tag only, for degradation analysis)
 */
export function runTransaction(data, { type, fromKey, toKey, amount, phase }) {
  // Think-time jitter: spreads concurrently-started flows so they don't all hit
  // the same account row in the same instant (reduces server deadlocks).
  if (CONFIG.jitterSeconds) sleep(Math.random() * CONFIG.jitterSeconds);

  const url = `${data.baseUrl}/transaction/${type}`;
  const payload = JSON.stringify({
    from_account: data.phones[fromKey],
    to_account: data.phones[toKey],
    amount: String(amount),
  });
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `bearer ${data.tokens[fromKey]}`,
      'X-AUTH-SECRET-KEY': data.secretKey,
    },
    tags: { api: type, phase, flow: `${fromKey}->${toKey}` },
  };

  // Fire the request, retrying only on a transient server deadlock.
  let res = http.post(url, payload, params);
  for (let i = 0; i < CONFIG.deadlockRetries; i++) {
    const isDeadlock = res.status === 500 && /deadlock/i.test(String(res.body));
    if (!isDeadlock) break;
    METRICS.deadlocks.add(1, { api: type });
    sleep(0.1 + Math.random() * 0.2); // brief back-off before restarting the txn
    res = http.post(url, payload, params);
  }

  let body;
  try { body = res.json(); } catch (_) { body = undefined; }
  const trnxId = extractTrnxId(body);
  const message = (body && body.message) || '';
  const httpOk = res.status === 200 || res.status === 201;

  // --- the four required assertions, tagged per API ------------------------
  const tags = { api: type };
  const ok = check(res, {
    'status is 200/201': () => httpOk,
    'transaction successful': () => httpOk && !!body && !/error|fail|invalid|unauthor|insufficient/i.test(message),
    'transaction id returned': () => !!trnxId,
    'success message returned': () => SUCCESS_MESSAGE[type].test(message),
  }, tags);

  // --- per-API custom metrics (response time, throughput, success rate) ----
  const m = METRICS[type];
  m.duration.add(res.timings.duration);
  m.count.add(1);
  m.success.add(ok);

  // Optional diagnostics: set -e DEBUG=1 to print why a transaction failed.
  if (__ENV.DEBUG && !ok) {
    console.error(`FAIL ${type} ${fromKey}->${toKey} status=${res.status} body=${String(res.body).slice(0, 300)}`);
  }

  return res;
}
