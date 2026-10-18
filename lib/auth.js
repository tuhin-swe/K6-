// Authentication & test-data provisioning helpers.
//
// These run ONCE inside k6 setup() — before the timed load phases — so the
// cost of logging six people in is paid up front and never pollutes the
// response-time metrics we report.
//
// Why it looks the way it does: DMoney forces an e-mail OTP for every non-admin
// login, and each /transaction/* call must be initiated from the token owner's
// OWN account (admin/system tokens are rejected with "you can only initiate
// transactions from your own account"). So to make "Agent 1 sends money" real,
// we must hold Agent 1's own token. We mint it the only way automation allows:
//   login (generates the OTP)  ->  admin reads the OTP of this freshly created
//   test account  ->  verify-otp returns the user's JWT.
import http from 'k6/http';
import { CONFIG } from '../config.js';

const SECRET = CONFIG.secretKey;
const BASE = CONFIG.baseUrl;

function headers(token) {
  const h = { 'Content-Type': 'application/json', 'X-AUTH-SECRET-KEY': SECRET };
  if (token) h['Authorization'] = `bearer ${token}`;
  return h;
}

function postJson(path, body, token) {
  return http.post(`${BASE}${path}`, JSON.stringify(body), { headers: headers(token) });
}

// --- privileged logins (no OTP) ---------------------------------------------
export function login(email, password) {
  const res = postJson('/user/login', { email, password });
  const body = res.json();
  if (body && body.token) return body.token;
  throw new Error(`login failed for ${email}: ${res.status} ${res.body}`);
}

// --- user provisioning ------------------------------------------------------
// Create the account (idempotent-ish: a duplicate just means it already exists)
// and return the numeric id by searching for it afterwards.
export function createUser(adminToken, u) {
  const res = postJson('/user/create', {
    name: u.name, email: u.email, password: u.password,
    phone_number: u.phone, nid: u.nid, role: u.role,
  }, adminToken);
  // 201 => created; anything else we tolerate if the user already exists.
  if (res.status !== 201) {
    console.warn(`createUser ${u.key} (${u.role}) -> ${res.status} ${res.body}`);
  }
  return findUser(adminToken, u.email);
}

export function findUser(adminToken, email) {
  const res = http.get(`${BASE}/user/search/email/${email}`, { headers: headers(adminToken) });
  const body = res.json();
  if (body && body.user) return body.user;
  throw new Error(`findUser failed for ${email}: ${res.status} ${res.body}`);
}

// Flip a freshly created (pending) account to active so it can send/receive.
export function activateUser(adminToken, id) {
  const res = http.patch(`${BASE}/user/update/${id}`, JSON.stringify({ status: 'active' }), { headers: headers(adminToken) });
  if (res.status !== 200) console.warn(`activateUser ${id} -> ${res.status} ${res.body}`);
  return res.status === 200;
}

// --- OTP login flow for a test account we own -------------------------------
// Returns the user's own JWT. Retries a couple of times because the OTP is
// regenerated on every /user/login call.
export function mintUserToken(adminToken, u, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    // 1) trigger OTP generation
    const loginRes = postJson('/user/login', { email: u.email, password: u.password });
    const loginBody = loginRes.json();
    if (loginBody && loginBody.token) return loginBody.token; // in case OTP ever gets disabled
    // 2) read the OTP that was just generated for THIS test account
    const user = findUser(adminToken, u.email);
    const otp = user && user.otp;
    if (!otp) { lastErr = new Error(`no OTP present for ${u.email}`); continue; }
    // 3) exchange email+OTP for the JWT
    const verifyRes = postJson('/user/verify-otp', { identifier: u.email, otp: String(otp) });
    const verifyBody = verifyRes.json();
    if (verifyBody && verifyBody.token) return verifyBody.token;
    lastErr = new Error(`verify-otp failed for ${u.email}: ${verifyRes.status} ${verifyRes.body}`);
  }
  throw lastErr || new Error(`could not mint token for ${u.email}`);
}

// --- funding ----------------------------------------------------------------
// A deposit always debits `from_account` and credits `to_account`, initiated
// with the from-account owner's token.
export function deposit(fromToken, fromAccount, toAccount, amount) {
  const res = postJson('/transaction/deposit', {
    from_account: fromAccount, to_account: toAccount, amount: String(amount),
  }, fromToken);
  return res;
}
