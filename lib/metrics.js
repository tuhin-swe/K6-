// Custom k6 metrics, one trio per transaction API, so the end-of-test summary
// and the HTML report can compare Deposit vs Send Money vs Payment directly
// (response time, throughput, success rate) instead of lumping every request
// into the single built-in http_req_duration metric.
import { Trend, Counter, Rate } from 'k6/metrics';

function group(name) {
  return {
    duration: new Trend(`${name}_duration`, true), // true => report in ms with time formatting
    count: new Counter(`${name}_count`),            // total attempts => throughput
    success: new Rate(`${name}_success`),           // share of successful transactions
  };
}

export const METRICS = {
  deposit: group('deposit'),
  sendmoney: group('sendmoney'),
  payment: group('payment'),
  // Count of transient server deadlocks (HTTP 500 "try restarting transaction")
  // we hit and retried — reported as a reliability signal, not a test error.
  deadlocks: new Counter('server_deadlocks'),
};
