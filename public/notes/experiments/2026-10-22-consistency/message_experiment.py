#!/usr/bin/env python3
"""SQLite outbox crash probes + explicit transaction-message STATE MODEL.

queue.db is a separate durable SQLite inbox, NOT RocketMQ. Child processes exit
at specified boundaries. Model checks are manual, not a broker scheduler.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

def init(folder):
    folder.mkdir()
    with sqlite3.connect(folder/'business.db') as db:
        db.executescript('''CREATE TABLE orders(id TEXT PRIMARY KEY);
          CREATE TABLE outbox(event_id TEXT PRIMARY KEY,order_id TEXT,sent INTEGER DEFAULT 0);
          CREATE TABLE txlog(tx_id TEXT PRIMARY KEY,state TEXT);''')
    with sqlite3.connect(folder/'queue.db') as db:
        db.executescript('''CREATE TABLE messages(seq INTEGER PRIMARY KEY,event_id TEXT);
          CREATE TABLE half(tx_id TEXT PRIMARY KEY,state TEXT);''')
    with sqlite3.connect(folder/'consumer.db') as db:
        db.executescript('''CREATE TABLE processed(event_id TEXT PRIMARY KEY);
          CREATE TABLE effect(value INTEGER);INSERT INTO effect VALUES(0);''')

def child(folder,mode):
    if mode in {'direct','outbox'}:
        with sqlite3.connect(folder/'business.db') as db:
            db.execute("INSERT INTO orders VALUES('order-1')")
            if mode=='outbox': db.execute("INSERT INTO outbox(event_id,order_id) VALUES('event-1','order-1')")
        os._exit(73) # committed business transaction, no queue send
    if mode=='relay_crash':
        with sqlite3.connect(folder/'queue.db') as db: db.execute("INSERT INTO messages(event_id) VALUES('event-1')")
        os._exit(73) # queue accepted, outbox has not been marked sent
    raise ValueError(mode)

def run_child(folder,mode):
    done=subprocess.run([sys.executable,__file__,'child',str(folder),mode],capture_output=True,text=True,timeout=10)
    assert done.returncode==73,(done.returncode,done.stderr)

def relay(folder):
    with sqlite3.connect(folder/'business.db') as business:
        pending=business.execute('SELECT event_id FROM outbox WHERE sent=0').fetchall()
        for (event,) in pending:
            with sqlite3.connect(folder/'queue.db') as queue:
                queue.execute('INSERT INTO messages(event_id) VALUES(?)',(event,))
            business.execute('UPDATE outbox SET sent=1 WHERE event_id=?',(event,))

def count(folder,db,query):
    with sqlite3.connect(folder/db) as conn: return conn.execute(query).fetchone()[0]

def check_model(folder,tx):
    with sqlite3.connect(folder/'business.db') as db:
        row=db.execute('SELECT state FROM txlog WHERE tx_id=?',(tx,)).fetchone()
    decision=row[0] if row else 'UNKNOWN'
    with sqlite3.connect(folder/'queue.db') as db:
        # Monotone terminal transitions; no broker timing/failure behavior simulated.
        if decision=='COMMIT': db.execute("UPDATE half SET state='READY' WHERE tx_id=? AND state='HALF'",(tx,))
        elif decision=='ROLLBACK': db.execute("UPDATE half SET state='ROLLED_BACK' WHERE tx_id=? AND state='HALF'",(tx,))
    return decision

def main(folder):
    direct=folder/'direct';init(direct);run_child(direct,'direct')
    direct_result=dict(order_rows=count(direct,'business.db','SELECT count(*) FROM orders'),
                       queue_rows=count(direct,'queue.db','SELECT count(*) FROM messages'),exit_code=73)
    box=folder/'outbox';init(box);run_child(box,'outbox')
    pending=count(box,'business.db','SELECT count(*) FROM outbox WHERE sent=0')
    run_child(box,'relay_crash');relay(box)
    with sqlite3.connect(box/'queue.db') as queue:
        events=[row[0] for row in queue.execute('SELECT event_id FROM messages ORDER BY seq')]
    for event in events:
        with sqlite3.connect(box/'consumer.db') as db:
            inserted=db.execute('INSERT OR IGNORE INTO processed VALUES(?)',(event,)).rowcount
            if inserted: db.execute('UPDATE effect SET value=value+1')
    effect=count(box,'consumer.db','SELECT value FROM effect')
    sent=count(box,'business.db','SELECT sent FROM outbox')
    assert direct_result['order_rows']==1 and direct_result['queue_rows']==0
    assert pending==1 and events==['event-1','event-1'] and effect==1 and sent==1
    model=folder/'transaction-model';init(model)
    with sqlite3.connect(model/'queue.db') as db:
        db.executemany("INSERT INTO half VALUES(?,'HALF')",[('tx-ok',),('tx-no',),('tx-pending',)])
    with sqlite3.connect(model/'business.db') as db:
        db.execute("INSERT INTO orders VALUES('order-tx')")
        db.execute("INSERT INTO txlog VALUES('tx-ok','COMMIT')")
        db.execute("INSERT INTO txlog VALUES('tx-no','ROLLBACK')") # definitive abort, not a missing row
    decisions={name:check_model(model,name) for name in ['tx-ok','tx-no','tx-pending']}
    # Missing at check time does not mean the original transaction cannot later commit.
    with sqlite3.connect(model/'business.db') as db:
        db.execute("INSERT INTO orders VALUES('order-late')")
        db.execute("INSERT INTO txlog VALUES('tx-pending','COMMIT')")
    second=check_model(model,'tx-pending')
    with sqlite3.connect(model/'queue.db') as db: states=dict(db.execute('SELECT tx_id,state FROM half ORDER BY tx_id'))
    assert decisions=={'tx-ok':'COMMIT','tx-no':'ROLLBACK','tx-pending':'UNKNOWN'}
    assert second=='COMMIT' and states=={'tx-no':'ROLLED_BACK','tx-ok':'READY','tx-pending':'READY'}
    return dict(protocol='actual child exit + SQLite persistence; queue is a local inbox model, NOT RocketMQ',
                direct=direct_result,outbox=dict(pending_after_crash=pending,delivered_event_ids=events,
                marked_sent=sent,consumer_effect_count=effect),
                transaction_message_model=dict(first_checks=decisions,late_commit_recheck=second,final_states=states),
                limits='No RocketMQ broker/SDK, real ACK loss, transaction timeout, producer-cluster check, or replication tested.')

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='child': child(Path(sys.argv[2]),sys.argv[3])
    else:
        with tempfile.TemporaryDirectory(prefix='blog-outbox-') as folder:
            print(json.dumps(main(Path(folder)),indent=2))
