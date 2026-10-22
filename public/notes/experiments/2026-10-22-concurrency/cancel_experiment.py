#!/usr/bin/env python3
"""Real asyncio.to_thread cancellation plus SQLite commit races, controlled by events.

The file append stands for an external effect: it is deliberately outside the
task-state transaction. No network or production project imports.
"""
import asyncio
import json
import sqlite3
import tempfile
import threading
from pathlib import Path


def initialize(path):
    with sqlite3.connect(path) as db:
        db.executescript('''
          CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT, epoch INTEGER, result TEXT);
          INSERT INTO jobs VALUES ('job-1','RUNNING',1,NULL);
          CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT);
        ''')


async def cancellation_race(folder, guarded):
    dbpath = folder / ('guarded.db' if guarded else 'unsafe.db')
    effect = folder / ('guarded.effect' if guarded else 'unsafe.effect')
    initialize(dbpath)
    ready = asyncio.Event()
    release = threading.Event()
    done = threading.Event()
    loop = asyncio.get_running_loop()
    observed = {}

    def blocking_work():
        try:
            loop.call_soon_threadsafe(ready.set)
            if not release.wait(5): raise TimeoutError('release not signalled')
            # Happens AFTER cancellation is recorded and the awaiter is cancelled.
            with effect.open('a') as f: f.write('effect-once\n')
            with sqlite3.connect(dbpath) as db:
                sql = "UPDATE jobs SET state='SUCCEEDED',result='late' WHERE id='job-1'"
                if guarded: sql += " AND state='RUNNING' AND epoch=1"
                rows = db.execute(sql).rowcount
                if rows: db.execute("INSERT INTO events(kind) VALUES ('SUCCEEDED')")
                observed['commit_rows'] = rows
        except BaseException as e:
            observed['error'] = repr(e)
        finally:
            done.set()

    task = asyncio.create_task(asyncio.to_thread(blocking_work))
    cancelled = False
    try:
        await asyncio.wait_for(ready.wait(), timeout=5)
        with sqlite3.connect(dbpath) as db:
            rows = db.execute("UPDATE jobs SET state='CANCELLED',epoch=epoch+1 WHERE id='job-1' AND state='RUNNING'").rowcount
            assert rows == 1
            db.execute("INSERT INTO events(kind) VALUES ('CANCELLED')")
        task.cancel()
        try: await task
        except asyncio.CancelledError: cancelled = True
        assert cancelled and not done.is_set()
    finally:
        release.set()
        assert await asyncio.to_thread(done.wait, 6), 'worker did not finish'
    assert 'error' not in observed, observed
    with sqlite3.connect(dbpath) as db:
        state, epoch = db.execute('SELECT state,epoch FROM jobs').fetchone()
        events = [row[0] for row in db.execute('SELECT kind FROM events ORDER BY seq')]
    effects = len(effect.read_text().splitlines())
    assert effects == 1
    assert (state, observed['commit_rows'], events) == (
        ('CANCELLED',0,['CANCELLED']) if guarded else ('SUCCEEDED',1,['CANCELLED','SUCCEEDED']))
    return dict(awaiter_cancelled=cancelled, worker_continued=True, effect_count=effects,
                final_state=state, epoch=epoch, late_commit_rows=observed['commit_rows'], events=events)


def aba_and_success_first(folder):
    path = folder / 'aba.db'
    initialize(path)
    with sqlite3.connect(path) as db:
        def restart():
            db.execute("UPDATE jobs SET state='RUNNING',epoch=1,result=NULL")
            db.execute("UPDATE jobs SET state='CANCELLED',epoch=2")
            db.execute("UPDATE jobs SET state='RUNNING',epoch=3")
        restart()
        state_only = db.execute("UPDATE jobs SET state='SUCCEEDED',result='old' WHERE id='job-1' AND state='RUNNING'").rowcount
        restart()
        old_epoch = db.execute("UPDATE jobs SET state='SUCCEEDED',result='old' WHERE id='job-1' AND state='RUNNING' AND epoch=1").rowcount
        current = db.execute("UPDATE jobs SET state='SUCCEEDED',result='current' WHERE id='job-1' AND state='RUNNING' AND epoch=3").rowcount
        late_cancel = db.execute("UPDATE jobs SET state='CANCELLED',epoch=epoch+1 WHERE id='job-1' AND state='RUNNING'").rowcount
        assert (state_only,old_epoch,current,late_cancel) == (1,0,1,0)
        return dict(state_only_old_worker_rows=state_only, epoch_guard_old_worker_rows=old_epoch,
                    current_worker_rows=current, cancel_after_success_rows=late_cancel)


async def main():
    with tempfile.TemporaryDirectory(prefix='blog-cancel-') as name:
        folder = Path(name)
        return dict(protocol='events control actual thread; SQLite transactions; append outside state transaction',
                    unguarded=await cancellation_race(folder,False),
                    guarded=await cancellation_race(folder,True),
                    restarted_job=aba_and_success_first(folder),
                    limits='No remote API cancellation, process kill, distributed scheduler or network partition tested.')


if __name__ == '__main__':
    print(json.dumps(asyncio.run(main()), ensure_ascii=False, indent=2))
