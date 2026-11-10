// services/erpInflight.js — Phase 17. Registry of sync runs executing in THIS process (manual and scheduled), so graceful shutdown can wait for
// all of them and release the ones that do not finish in time. Tracks job ids only — no payloads.
const running = new Map(); // promise → job id (or null)

function track(promise, jobId = null) {
  running.set(promise, jobId);
  const done = () => running.delete(promise);
  promise.then(done, done);
  return promise;
}
const count = () => running.size;
const jobIds = () => [...running.values()].filter((v) => v !== null);
const pending = () => [...running.keys()];

module.exports = { track, count, jobIds, pending };
