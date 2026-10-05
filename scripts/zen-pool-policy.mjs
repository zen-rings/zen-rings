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

// The retention window, in hours: 27 minutes. A pool worker lives at most 30 minutes
// (`timeout-minutes: 30` in zen-pool.yml, measured 30.3 min), so once its run is finished the run is
// already history — 27 minutes is enough to see "this worker worked" in the Actions tab and stop there.
// The owner picked the odd number on purpose: a cutoff that is not a round hour never lands on an hour
// boundary, so a burst of workers finishing together does not all survive (or all vanish) at once.
// 27 min = 0.45 h. The window is expressed in hours because that is what the entry points take.
export const DEFAULT_KEEP_HOURS = 0.45;

// Same window for the newest-items cap. Kept next to the window so the two cannot drift: with a 27
// minute window a busy ring still needs the cap, because GitHub may deliver the cron hours late.
export const DEFAULT_MAX_ITEMS = 20;

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
  const safe = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_KEEP_HOURS;
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
