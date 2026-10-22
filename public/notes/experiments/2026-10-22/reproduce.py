#!/usr/bin/env python3
"""Deterministic article exhibits, standard library only; NOT project benchmarks.

Run from any directory: python3 reproduce.py > results.json
All inputs are synthetic. No network, models, credentials or project imports.
"""
import heapq
import json
import math
import sqlite3
import tempfile
from pathlib import Path


def capacity():
    rows = []
    for workers in (4, 8, 16):
        available = [0.0] * workers
        jobs = []
        for i in range(400):  # 40/min for ten minutes, first arrival at t=0
            arrival = i * 1.5
            start = max(arrival, heapq.heappop(available))
            finish = start + 20
            heapq.heappush(available, finish)
            jobs.append((arrival, start, finish))
        completed = sum(f <= 600 for _, _, f in jobs)
        running = sum(s <= 600 < f for _, s, f in jobs)
        waiting = sum(s > 600 for _, s, _ in jobs)
        waits = sorted(s - a for a, s, _ in jobs)
        assert completed + running + waiting == 400
        rows.append(dict(workers=workers, ideal_capacity_per_min=workers * 3,
                         completed_at_600s=completed, running_at_600s=running,
                         waiting_at_600s=waiting,
                         all_400_jobs_wait_p95_s=waits[math.ceil(.95 * len(waits)) - 1],
                         last_finish_s=max(f for _, _, f in jobs)))
    assert [r['waiting_at_600s'] for r in rows] == [279, 159, 0]
    return dict(protocol='uniform arrivals; fixed 20s service; FCFS; infinite queue; no retries',
                arrivals_per_min=40, arrival_window_s=600, jobs=400, rows=rows,
                provider_example=dict(calls_per_video=10, calls_per_min=300,
                                      video_capacity_per_min=30, backlog_growth_per_min=10))


def ownership_and_concurrency():
    # Two independent SQLite connections, deliberately interleaved, no sleep/race lottery.
    with tempfile.TemporaryDirectory() as folder:
        path = str(Path(folder) / 'model.db')
        a = sqlite3.connect(path, isolation_level=None)
        b = sqlite3.connect(path, isolation_level=None)
        a.executescript('''
            CREATE TABLE sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                                   value INTEGER NOT NULL, version INTEGER NOT NULL);
            INSERT INTO sessions VALUES ('s-A', 'alice', 0, 0);
            CREATE TABLE jobs (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, result TEXT);
            INSERT INTO jobs VALUES ('j-A', 2, NULL);
        ''')
        unsafe = b.execute('SELECT id FROM sessions WHERE id=?', ('s-A',)).fetchone()
        safe = b.execute('SELECT id FROM sessions WHERE id=? AND owner=?',
                         ('s-A', 'bob')).fetchone()
        own = a.execute('SELECT id FROM sessions WHERE id=? AND owner=?',
                        ('s-A', 'alice')).fetchone()
        assert unsafe is not None and safe is None and own is not None
        old_a = a.execute('SELECT value FROM sessions WHERE id="s-A"').fetchone()[0]
        old_b = b.execute('SELECT value FROM sessions WHERE id="s-A"').fetchone()[0]
        a.execute('UPDATE sessions SET value=? WHERE id="s-A"', (old_a + 1,))
        b.execute('UPDATE sessions SET value=? WHERE id="s-A"', (old_b + 1,))
        lost = a.execute('SELECT value FROM sessions').fetchone()[0]
        assert lost == 1  # Two increments intended; stale read overwrites first write.
        a.execute('UPDATE sessions SET value=0, version=0')
        snapshots = [c.execute('SELECT value,version FROM sessions').fetchone() for c in (a,b)]
        def cas(conn, snapshot):
            value, version = snapshot
            return conn.execute('''UPDATE sessions SET value=?, version=version+1
                                   WHERE id=? AND owner=? AND version=?''',
                                (value+1, 's-A', 'alice', version)).rowcount
        first = cas(a, snapshots[0])
        stale = cas(b, snapshots[1])
        retry = cas(b, b.execute('SELECT value,version FROM sessions').fetchone())
        final = a.execute('SELECT value FROM sessions').fetchone()[0]
        assert (first, stale, retry, final) == (1, 0, 1, 2)
        old_worker = a.execute('UPDATE jobs SET result=? WHERE id=? AND epoch=?',
                               ('stale', 'j-A', 1)).rowcount
        new_worker = b.execute('UPDATE jobs SET result=? WHERE id=? AND epoch=?',
                               ('current', 'j-A', 2)).rowcount
        assert (old_worker, new_worker) == (0, 1)
        a.close()
        b.close()
    return dict(protocol='SQLite two connections; forced interleaving; synthetic trusted owner',
                unscoped_bob_can_read_alice=True, scoped_bob_can_read_alice=False,
                scoped_alice_can_read_own=True, intended_increments=2,
                unguarded_final_value=lost, cas_rows=[first, stale, retry], cas_final_value=final,
                old_epoch_commit_rows=old_worker, current_epoch_commit_rows=new_worker)


def retrieval():
    # FIXED ranked lists, not BM25/vector engine output. Gold is for scoring and
    # explicitly labelled ORACLE only, never described as a learned reranker.
    cases = [
        dict(id='exact-code', query='E1042 错误码如何处理', gold=['A'],
             lexical=['A','B','C'], dense=['B','C','A']),
        dict(id='paraphrase', query='关掉页面后为什么任务还在跑', gold=['D'],
             lexical=['E','F','D'], dense=['D','E','F']),
        dict(id='constraint', query='只查项目甲中支持离线运行的方案', gold=['G'],
             lexical=['H','I','G'], dense=['I','H','G']),
        dict(id='missing', query='新版协议的取消规则', gold=['J'],
             lexical=['K','L','M'], dense=['L','M','K']),
    ]
    def rrf(lists):
        scores = {}
        for ranked in lists:
            for rank, doc in enumerate(ranked, 1):
                scores[doc] = scores.get(doc, 0) + 1 / (60 + rank)
        return sorted(scores, key=lambda doc: (-scores[doc], doc)), scores
    def metrics(ranked, gold):
        relevant = set(gold)
        hits = [i for i, d in enumerate(ranked[:3], 1) if d in relevant]
        return dict(recall_at_3=len(set(ranked[:3]) & relevant) / len(relevant),
                    reciprocal_rank_at_3=1 / hits[0] if hits else 0,
                    hit_at_1=int(ranked[0] in relevant))
    totals = {k: [] for k in ('lexical','dense','rrf','oracle_rerank')}
    for case in cases:
        fused, scores = rrf([case['lexical'], case['dense']])
        candidate_set = fused[:3]
        oracle = sorted(candidate_set, key=lambda d: (d not in case['gold'], candidate_set.index(d)))
        assert set(oracle) == set(candidate_set)
        case['rrf'] = fused
        case['rrf_scores'] = scores
        case['oracle_rerank'] = oracle
        case['metrics'] = {}
        for method in totals:
            m = metrics(case[method], case['gold'])
            case['metrics'][method] = m
            totals[method].append(m)
    averages = {method: {metric: sum(m[metric] for m in ms)/len(ms) for metric in ms[0]}
                for method, ms in totals.items()}
    assert cases[0]['rrf'] == ['B', 'A', 'C']
    assert all(m['recall_at_3'] == .75 for m in averages.values())
    assert averages['rrf']['hit_at_1'] == 0
    assert averages['oracle_rerank']['reciprocal_rank_at_3'] == .75
    return dict(protocol='four hand-built counterexamples; fixed ranks; RRF c=60; tie by doc ID; K=3',
                cases=cases, averages=averages,
                limits='No tokenizer, embedding, learned reranker or LLM executed. Oracle uses gold explicitly.')


if __name__ == '__main__':
    print(json.dumps(dict(capacity=capacity(), ownership=ownership_and_concurrency(),
                          retrieval=retrieval()), ensure_ascii=False, indent=2))
