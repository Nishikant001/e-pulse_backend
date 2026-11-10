// utils/requestContext.js — Phase 17. Carries the correlation id of the current request across async boundaries (controller → service →
// sync job → provider → audit) without changing every function signature. Backed by AsyncLocalStorage: a background sync started from an
// HTTP request (setImmediate) inherits the request's id; the scheduler (no request) simply has none and mints its own.
// Only a correlation id is ever stored here — never a credential, header or body.
const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const als = new AsyncLocalStorage();
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

const newId = () => crypto.randomUUID();
/** An incoming X-Correlation-ID is accepted only when it is a short, boring token (it ends up in logs and audit rows). */
const sanitizeIncoming = (v) => (typeof v === "string" && SAFE_ID.test(v) ? v : null);
const run = (correlationId, fn) => als.run({ correlationId }, fn);
const currentCorrelationId = () => { const s = als.getStore(); return s ? s.correlationId : null; };

module.exports = { run, currentCorrelationId, newId, sanitizeIncoming, SAFE_ID };
