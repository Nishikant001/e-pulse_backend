// services/erp/redaction.js — Phase 17. ONE place that knows what a secret looks like. Used by the audit trail, the error layer, the log
// helper and the API error responses so a credential cannot reach a log line, an audit row or a browser by accident.
//   isSecretKey(name)   does an object key / header name look like a secret?
//   redactString(text)  masks "Authorization: …", "Bearer …", "password=…", cookies, CSRF tokens, URL user-info
//   redactDeep(value)   copy of a structure with secret-named keys masked and every string passed through redactString
// It is deliberately conservative: a false positive hides a harmless value, a false negative leaks a credential.
const MASK = "[REDACTED]";
// password, secret, token (access/refresh/csrf/id), authorization, cookie, api key, client secret, bearer, credential, session, private key
const SECRET_KEY = /pass(word|wd)?|pwd|secret|token|authoriz|cookie|csrf|xsrf|api[-_]?key|bearer|credential|session|private[-_]?key|signature|auth(?!or)/i;
const isSecretKey = (k) => SECRET_KEY.test(String(k));

const PATTERNS = [
  [/(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token|x-api-key)\s*[:=]\s*[^\r\n,;]+/gi, `$1=${MASK}`],
  [/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/g, `$1 ${MASK}`],
  [/((?:client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|csrf[_-]?token|api[_-]?key|password|passwd|pwd|secret|token|csrf|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, `$1${MASK}`],
  [/\/\/[^/\s:@]+:[^/\s@]+@/g, `//${MASK}@`],
];

function redactString(value, max = 500) {
  let s = String(value === undefined || value === null ? "" : value);
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return max && s.length > max ? s.slice(0, max) : s;
}

function redactDeep(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, 2000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactDeep(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) out[k] = isSecretKey(k) ? MASK : redactDeep(v, depth + 1);
    return out;
  }
  return undefined;
}

/** Console wrappers that can never print a credential. `erpLog.info("[tag] message", optionalObject)` */
const fmt = (args) => args.map((a) => (typeof a === "string" ? redactString(a, 2000) : a instanceof Error ? redactString(`${a.name}: ${a.message}`, 2000) : JSON.stringify(redactDeep(a)))).join(" ");
const erpLog = {
  info: (...a) => console.info(fmt(a)),
  warn: (...a) => console.warn(fmt(a)),
  error: (...a) => console.error(fmt(a)),
};

module.exports = { MASK, isSecretKey, redactString, redactDeep, erpLog };
