// The prune policy, shared by the ring sweep (`ring-hygiene.mjs`) and the worker's own exit sweep
// (`zen-pool-prune.mjs`).
//
// Why this is a module of its own: the worker sweep runs inside a ring repository, and the provisioner
// only copies a handful of files there — `ring-hygiene.mjs` is not one of them. So the policy both
// entry points apply has to live in a file that IS provisioned, or the two would drift apart and the
// worker would delete something the ring sweep would keep.
//
// Two rules, not one: finished items older than the cutoff go by age, and at most `max` finished items
// are kept. The cap is what makes a sweep robust to a late trigger — GitHub delays `schedule` in this
// ring by hours (measured), so an age window alone cannot bound an Actions tab.

// A finished item is the only thing either sweep is ever allowed to delete. A pool worker IS an Actions
// run, so anything that is not `completed` is a worker that is still serving requests — or a job that
// GitHub has queued and will start in a minute.
export function isFinished(item) {
  if (!item || typeof item.created_at !== 'string') return false;
  const created = Date.parse(item.created_at);
  if (!Number.isFinite(created)) return false;
  return !item.status || item.status === 'completed';
}

// `status` is the field GitHub reports for in-flight work; anything that is not `completed` is left
// alone, which is what keeps live pool workers alive.
export function isPrunable(item, cutoffMs, nowMs) {
  if (!item || typeof item.created_at !== 'string') return false;
  const created = Date.parse(item.created_at);
  if (!Number.isFinite(created)) return false;
  if (created >= cutoffMs) return false;
  if (item.status && item.status !== 'completed') return false;
  if (nowMs != null && created > nowMs) return false;
  return true;
}

export function cutoffIso(keepHours, nowMs = Date.now()) {
  const hours = Number(keepHours);
  const safe = Number.isFinite(hours) && hours > 0 ? hours : 6;
  return new Date(nowMs - safe * 3600 * 1000).toISOString();
}

function capOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

// The prune decision, as a pure function: finished items older than the cutoff go by age, the finished
// items beyond the newest `max` go by cap, and everything not finished is left alone. Newest-first is
// what the REST list already returns, but sorting here keeps the decision independent of that.
export function planPrune(items, { cutoffMs, max = Infinity, nowMs = Date.now() } = {}) {
  const list = Array.isArray(items) ? items.filter((it) => it && typeof it.id === 'number') : [];
  const cap = capOf(max);
  const finished = list
    .filter((it) => isFinished(it) && Date.parse(it.created_at) <= nowMs)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const byAge = finished.filter((it) => isPrunable(it, cutoffMs, nowMs));
  const fresh = finished.filter((it) => !isPrunable(it, cutoffMs, nowMs));
  const kept = cap === Infinity ? fresh : fresh.slice(0, cap);
  const byCap = cap === Infinity ? [] : fresh.slice(cap);
  return {
    ids: [...byAge, ...byCap].map((it) => it.id),
    by_age: byAge.length,
    by_cap: byCap.length,
    kept: kept.length,
    live: list.length - finished.length,
  };
}
