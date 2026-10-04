#!/usr/bin/env python3
"""Analytics report over the D1 trace log (ladder_calls) → markdown/json.

Answers, from what the worker already records: how many calls, which ladders, which rungs
actually served, reliability, failover depth, top errors, and an estimated OpenRouter spend
(tokens x current list price). Go rungs are a flat subscription — reported with tokens but no
cost. Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; DAYS (default 7) or --days; FORMAT md|json
or --format. Markdown is GitHub-flavoured (job summary ready).
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

DB_NAME = 'trained-assist-llm-ladder-trace'
OR_MODELS_URL = 'https://openrouter.ai/api/v1/models'
MAX_DAYS = 90


def since_ms(days):
    days = max(1, min(int(days), MAX_DAYS))
    return int((time.time() - days * 86400) * 1000), days


def queries(since):
    """name → (sql, params). All user input is bound; nothing is string-interpolated."""
    return {
        'totals': (
            'SELECT COUNT(*) AS n, SUM(1 - ok) AS failed, ROUND(AVG(ms)) AS avg_ms, '
            'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout, '
            'SUM(ok) AS ok_n, '
            'SUM(CASE WHEN ok = 1 AND tokens_in IS NULL THEN 1 ELSE 0 END) AS ok_no_usage '
            'FROM ladder_calls WHERE ts >= ?1', [since]),
        'ladders': (
            'SELECT ladder, COUNT(*) AS n, SUM(1 - ok) AS failed, ROUND(AVG(ms)) AS avg_ms '
            'FROM ladder_calls WHERE ts >= ?1 GROUP BY ladder ORDER BY n DESC', [since]),
        'models': (
             'SELECT model, COUNT(*) AS n, ROUND(AVG(ms)) AS avg_ms, '
             'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout, '
             'SUM(CASE WHEN tokens_in IS NULL THEN 1 ELSE 0 END) AS no_usage '
             'FROM ladder_calls WHERE ts >= ?1 AND ok = 1 '
             'GROUP BY model ORDER BY n DESC', [since]),
        'rungs': (
             'SELECT ladder, model, COUNT(*) AS calls, '
             'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_cached, 0)) AS tcached, '
             'SUM(COALESCE(tokens_out, 0)) AS tout '
             'FROM ladder_calls WHERE ts >= ?1 AND ok = 1 '
             'GROUP BY ladder, model ORDER BY ladder, calls DESC', [since]),
        'hourly': (
             "SELECT strftime('%Y-%m-%dT%H:00Z', ts / 1000, 'unixepoch') AS hour, ladder, model, "
             'COUNT(*) AS calls, SUM(ok) AS ok_n, '
             'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_cached, 0)) AS tcached, '
             'SUM(COALESCE(tokens_out, 0)) AS tout '
             'FROM ladder_calls WHERE ts >= ?1 '
             'GROUP BY hour, ladder, model ORDER BY hour DESC, calls DESC', [since]),
        'daily': (
            "SELECT date(ts / 1000, 'unixepoch') AS d, COUNT(*) AS n, SUM(1 - ok) AS failed, "
            'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout '
            'FROM ladder_calls WHERE ts >= ?1 GROUP BY d ORDER BY d', [since]),
        'depth': (
            'SELECT json_array_length(attempts) AS depth, COUNT(*) AS n FROM ladder_calls '
            'WHERE ts >= ?1 AND attempts IS NOT NULL AND json_valid(attempts) '
            'GROUP BY depth ORDER BY depth', [since]),
        'errors': (
            "SELECT json_extract(j.value, '$.error') AS err, COUNT(*) AS n "
            'FROM ladder_calls, json_each(ladder_calls.attempts) j '
            "WHERE ts >= ?1 AND json_extract(j.value, '$.outcome') <> 'ok' "
            "AND json_extract(j.value, '$.error') IS NOT NULL "
            'GROUP BY err ORDER BY n DESC LIMIT 100', [since]),
    }


def normalize_error(err):
    """Group digit-only variants of one failure ('can only afford 499' / '776').
    Keeps the HTTP status (part before the first ':'), masks digits in the payload."""
    if not err:
        return '(no message)'
    s = str(err)
    head, sep, rest = s.partition(': ')
    if sep and re.fullmatch(r'HTTP \d+', head.strip()):
        body = re.sub(r'\d+', '#', rest)
        return re.sub(r'\s+', ' ', f'{head}{sep}{body}').strip()[:160]
    s = re.sub(r'\d+', '#', s)
    return re.sub(r'\s+', ' ', s).strip()[:160]


def openrouter_id(model):
    """Ladder rung → OpenRouter pricing id; None when not billed per token here
    (opencode-go/* is the subscription, opencode-zen/* is the free tier, #36)."""
    if not model or not model.startswith('openrouter/'):
        return None  # opencode-go/* / opencode-zen/* are not per-token billed here
    return model[len('openrouter/'):]


def fetch_pricing(opener=None):
    """{openrouter model id: {prompt, completion}} $ per token. {} on failure (report degrades)."""
    try:
        req = urllib.request.Request(OR_MODELS_URL, headers={'User-Agent': 'llm-ladder-analytics'})
        with (opener or urllib.request.urlopen)(req, timeout=30) as r:
            data = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001 — a pricing outage must not kill the report
        print(f'pricing fetch failed: {e}', file=sys.stderr)
        return {}
    out = {}
    for m in data.get('data') or []:
        p = m.get('pricing') or {}
        try:
            out[m['id']] = {'prompt': float(p.get('prompt') or 0), 'completion': float(p.get('completion') or 0)}
        except (TypeError, ValueError):
            continue
    return out


def load_prices():
    """config/prices.json → {model: [in, out, cachedRead]} per 1M tokens. {} on failure."""
    try:
        with open(os.path.join(os.path.dirname(__file__), '..', 'config', 'prices.json')) as f:
            return json.load(f)
    except Exception:
        return {}


def est_cost(model, tin, tout, pricing):
    """$ for one served-model row. None = not per-token-billable here (Go) or price unknown."""
    oid = openrouter_id(model)
    if oid is None:
        return None
    p = pricing.get(oid)
    if p is None:
        return None
    return tin * p['prompt'] + tout * p['completion']


def est_cost_cached(model, tin, tcached, tout, prices):
    """$ with the cache split (#94): (in-cached)×in + out×out + cached×cachedRead, per 1M.
    None = unknown price and not an obvious $0 rung."""
    if not model:
        return None
    p = prices.get(model)
    if not p:
        if model.startswith('opencode-zen/') or model.endswith('-free') or model.endswith(':free'):
            return 0
        return None
    fresh = max(0, (tin or 0) - (tcached or 0))
    return (fresh * p[0] + (tout or 0) * p[1] + (tcached or 0) * p[2]) / 1e6


def build_report(queries_out, pricing, days, now=None):
    """Pure: SQL rows + pricing → a plain dict the renderers consume."""
    now = now or time.gmtime()
    t = queries_out['totals'][0] if queries_out['totals'] else {}
    prices = load_prices()
    models = []
    total_cost = 0.0
    cost_known = False
    for row in queries_out['models']:
        cost = est_cost_cached(row['model'], row['tin'] or 0, row.get('tcached') or 0, row['tout'] or 0, prices)
        if cost is not None:
            total_cost += cost
            cost_known = True
        models.append({**row, 'cost': cost})
    rungs = []
    for row in queries_out.get('rungs', []) or []:
        cost = est_cost_cached(row['model'], row['tin'] or 0, row.get('tcached') or 0, row['tout'] or 0, prices)
        rungs.append({**row, 'cost': cost})  # same calls as `models`, grouped by ladder — NOT summed again
    hourly = []
    for row in queries_out.get('hourly', []) or []:
        cost = est_cost_cached(row['model'], row['tin'] or 0, row.get('tcached') or 0, row['tout'] or 0, prices)
        hourly.append({**row, 'cost': cost, 'tokens_in': row.get('tin') or 0,
                       'tokens_cached': row.get('tcached') or 0, 'tokens_out': row.get('tout') or 0})
    merged_errors = {}
    for row in queries_out['errors']:
        key = normalize_error(row['err'])
        merged_errors[key] = merged_errors.get(key, 0) + row['n']
    errors = sorted(({'err': k, 'n': n} for k, n in merged_errors.items()), key=lambda r: -r['n'])
    n, failed, ok_n = t.get('n') or 0, t.get('failed') or 0, t.get('ok_n') or 0
    return {
        'days': days,
        'generated_utc': time.strftime('%Y-%m-%d %H:%M', now),
        'totals': {
            'calls': n,
            'ok': ok_n,
            'failed': failed,
            'ok_rate': (ok_n / n) if n else 0.0,
            'avg_ms': t.get('avg_ms'),
            'tokens_in': t.get('tin') or 0,
            'tokens_out': t.get('tout') or 0,
            'ok_no_usage': t.get('ok_no_usage') or 0,
            'est_cost_usd': total_cost if cost_known else None,
        },
        'ladders': queries_out['ladders'],
        'rungs': rungs,
        'hourly': hourly,
        'models': models,
        'daily': queries_out['daily'],
        'depth': queries_out['depth'],
        'errors': errors[:15],
        'pricing_ok': bool(pricing),
    }


def fmt_money(v):
    if v is None:
        return '—'
    if v == 0:
        return '$0'
    if v < 0.0001:
        return '<$0.0001'
    return f'${v:.4f}'


def fmt_tokens(n):
    if n is None:
        return '0'
    if n >= 1_000_000:
        return f'{n / 1_000_000:.1f}M'
    if n >= 10_000:
        return f'{n / 1_000:.0f}k'
    if n >= 1_000:
        return f'{n / 1_000:.1f}k'
    return str(n)


def render_markdown(r):
    tt = r['totals']
    lines = [
        f'# Ladder analytics — {r["days"]}d (UTC, {r["generated_utc"]})',
        '',
        f'**{tt["calls"]} calls** · {tt["ok_rate"] * 100:.1f}% ok · '
        f'avg {tt["avg_ms"] if tt["avg_ms"] is not None else "—"} ms · '
        f'tokens {fmt_tokens(tt["tokens_in"])} in / {fmt_tokens(tt["tokens_out"])} out · '
        f'est. OpenRouter spend **{fmt_money(tt["est_cost_usd"])}**',
    ]
    if tt['ok_no_usage']:
        lines.append(f'_usage missing for {tt["ok_no_usage"]} ok calls (stream path, #22) — spend is a lower bound_')
    if not r['pricing_ok']:
        lines.append('_pricing fetch failed — cost column unavailable_')
    lines += ['', '## Ladders', '', '| ladder | calls | ok% | avg ms |', '|---|---:|---:|---:|']
    for l in r['ladders']:
        okp = 100.0 * (l['n'] - l['failed']) / l['n'] if l['n'] else 0.0
        lines.append(f'| `{l["ladder"]}` | {l["n"]} | {okp:.1f} | {l["avg_ms"] or "—"} |')
    lines += ['', '## Served rungs', '', '| model | calls | tokens in/out | avg ms | est $ |', '|---|---:|---:|---:|---:|']
    for m in r['models']:
        lines.append(
            f'| `{m["model"]}` | {m["n"]} | {fmt_tokens(m["tin"])} / {fmt_tokens(m["tout"])} '
            f'| {m["avg_ms"] or "—"} | {fmt_money(m["cost"])} |')
    lines += ['', '## Hourly (UTC)', '', '| hour | ladder | model | calls | tokens in/cached/out | est $ |', '|---|---|---|---:|---:|---:|']
    for h in r.get('hourly', []) or []:
        lines.append(
            f'| {h["hour"]} | `{h["ladder"]}` | `{h["model"]}` | {h["calls"]} | '
            f'{fmt_tokens(h["tokens_in"])} / {fmt_tokens(h["tokens_cached"])} / {fmt_tokens(h["tokens_out"])} '
            f'| {fmt_money(h["cost"])} |')
    lines += ['', '## Daily', '', '| day | calls | ok% | tokens in/out |', '|---|---:|---:|---:|']
    for d in r['daily']:
        okp = 100.0 * (d['n'] - d['failed']) / d['n'] if d['n'] else 0.0
        lines.append(f'| {d["d"]} | {d["n"]} | {okp:.1f} | {fmt_tokens(d["tin"])} / {fmt_tokens(d["tout"])} |')
    if r['depth']:
        depth = ', '.join(f'{d["depth"]}→{d["n"]}' for d in r['depth'])
        lines += ['', f'**Failover depth (attempts):** {depth}']
    if r['errors']:
        lines += ['', '## Top errors', '', '| n | error |', '|---:|---|']
        for e in r['errors']:
            err = e['err'].replace('|', '\\|')
            lines.append(f'| {e["n"]} | `{err}` |')
    return '\n'.join(lines) + '\n'


def query_d1(sql, params, token, account, opener=None):
    """POST one statement via the D1 REST API."""
    base = f'https://api.cloudflare.com/client/v4/accounts/{account}'
    req = urllib.request.Request(
        f'{base}/d1/database', headers={'Authorization': f'Bearer {token}'})
    with (opener or urllib.request.urlopen)(req, timeout=30) as r:
        dbs = json.loads(r.read().decode()).get('result') or []
    db = next((d for d in dbs if d.get('name') == DB_NAME), None)
    if not db:
        sys.exit(f'D1 database {DB_NAME} not found')
    req = urllib.request.Request(
        f'{base}/d1/database/{db["uuid"]}/query',
        data=json.dumps({'sql': sql, 'params': params}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        method='POST')
    with (opener or urllib.request.urlopen)(req, timeout=60) as r:
        res = json.loads(r.read().decode())
    if res.get('errors'):
        sys.exit(f'D1 error: {res["errors"]}')
    return (res.get('result') or [{}])[0].get('results') or []


def run_report(days, token, account, opener=None):
    since, days = since_ms(days)
    qs = queries(since)
    out = {name: query_d1(sql, params, token, account, opener) for name, (sql, params) in qs.items()}
    pricing = fetch_pricing(opener)
    return build_report(out, pricing, days)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--days', type=int, default=int(os.environ.get('DAYS') or 7))
    ap.add_argument('--format', choices=['md', 'json'], default=os.environ.get('FORMAT') or 'md')
    args = ap.parse_args()
    token = os.environ.get('CLOUDFLARE_API_TOKEN')
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    if not token or not account:
        sys.exit('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required')
    report = run_report(args.days, token, account)
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.format == 'json' else render_markdown(report), end='')


if __name__ == '__main__':
    main()
