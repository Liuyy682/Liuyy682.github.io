#!/usr/bin/env python3
"""Actual file/checkpoint failures and a small SQLite GC coordination model.

No model calls. Process exits exercise publication ordering, not power-loss or
object-store durability. GC interleavings are explicitly scheduled, not load tests.
"""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

DATA=b'header\nitem=A\nanswer=42\n'

def sha(data): return hashlib.sha256(data).hexdigest()

def atomic_write(path,data):
    temporary=path.with_suffix(path.suffix+'.tmp')
    with temporary.open('wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
    os.replace(temporary,path)
    descriptor=os.open(path.parent,os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)

def reference():
    return dict(artifact_id=sha(DATA),sha256=sha(DATA),size_bytes=len(DATA),
                encoding='utf-8',line_base=1,expected_line=3)

def publish(folder,mode='normal'):
    folder.mkdir(exist_ok=True)
    manifest=json.dumps(reference()).encode()
    obj=folder/(sha(DATA)+'.txt')
    if mode=='reference_first':
        atomic_write(folder/'checkpoint.json',manifest)
        os._exit(73)
    atomic_write(obj,DATA)
    if mode=='object_first': os._exit(73)
    atomic_write(folder/'checkpoint.json',manifest)

def resolve(folder):
    manifest_path=folder/'checkpoint.json'
    if not manifest_path.exists(): return 'NO_CHECKPOINT'
    ref=json.loads(manifest_path.read_text())
    path=folder/(ref['artifact_id']+'.txt')
    if not path.exists(): return 'MISSING_ARTIFACT'
    raw=path.read_bytes() # Verify and read SAME bytes, not two separate path reads.
    if len(raw)!=ref['size_bytes'] or sha(raw)!=ref['sha256']: return 'INTEGRITY_ERROR'
    return raw.decode(ref['encoding']).splitlines()[ref['expected_line']-ref['line_base']]

def crash(folder,mode):
    result=subprocess.run([sys.executable,__file__,'child',str(folder),mode],
                          capture_output=True,text=True,timeout=10)
    assert result.returncode==73,(result.returncode,result.stderr)
    return dict(exit_code=result.returncode,recovery=resolve(folder),
                object_count=len(list(folder.glob('*.txt'))))

def gc_model(folder):
    path=folder/'gc.db'
    with sqlite3.connect(path) as db:
        db.executescript('''CREATE TABLE objects(id TEXT PRIMARY KEY,state TEXT,pins INTEGER);
          INSERT INTO objects VALUES('a1','LIVE',0);
          CREATE TABLE refs(checkpoint TEXT PRIMARY KEY,artifact TEXT,recoverable INTEGER);
          INSERT INTO refs VALUES('paused-task','a1',1);''')
    def collect():
        with sqlite3.connect(path) as db:
            db.execute('BEGIN IMMEDIATE')
            return db.execute('''UPDATE objects SET state='DELETING' WHERE id='a1'
                AND state='LIVE' AND pins=0 AND NOT EXISTS
                (SELECT 1 FROM refs WHERE artifact='a1' AND recoverable=1)''').rowcount
    retained=collect()
    with sqlite3.connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        pin=db.execute("UPDATE objects SET pins=pins+1 WHERE id='a1' AND state='LIVE'").rowcount
        db.execute('UPDATE refs SET recoverable=0') # recovery reference released, reader still holds pin
    pinned=collect()
    with sqlite3.connect(path) as db: db.execute("UPDATE objects SET pins=pins-1 WHERE id='a1'")
    eligible=collect()
    with sqlite3.connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        late_attach=db.execute("INSERT INTO refs SELECT 'new-task','a1',1 WHERE EXISTS (SELECT 1 FROM objects WHERE id='a1' AND state='LIVE')").rowcount
    assert (retained,pin,pinned,eligible,late_attach)==(0,1,0,1,0)
    return dict(gc_with_recoverable_ref=retained,reader_pin_acquired=pin,gc_with_reader_pin=pinned,
                gc_after_release=eligible,new_ref_after_deleting=late_attach,
                limits='Metadata state model only; no distributed reader leases or physical GC crash recovery.')

def run(root):
    normal=root/'normal';publish(normal);ok=resolve(normal)
    missing=root/'missing';publish(missing);(missing/(sha(DATA)+'.txt')).unlink();missing_result=resolve(missing)
    changed=root/'changed';publish(changed)
    altered=b'header\ninserted\nitem=A\nanswer=99\n'
    (changed/(sha(DATA)+'.txt')).write_bytes(altered)
    naive=altered.decode().splitlines()[2];verified=resolve(changed)
    same_size=root/'same-size';publish(same_size)
    tampered=DATA.replace(b'42',b'99')
    assert len(tampered)==len(DATA)
    (same_size/(sha(DATA)+'.txt')).write_bytes(tampered)
    same_size_result=resolve(same_size)
    assert same_size_result=='INTEGRITY_ERROR'
    ttl=root/'ttl';publish(ttl)
    # Logical retention expires while checkpoint remains recoverable. No real-time sleep.
    object_expires_at,recovery_at=10,20
    if recovery_at>=object_expires_at: (ttl/(sha(DATA)+'.txt')).unlink()
    ttl_result=resolve(ttl)
    assert (ok,missing_result,naive,verified,ttl_result)==('answer=42','MISSING_ARTIFACT','item=A','INTEGRITY_ERROR','MISSING_ARTIFACT')
    object_first=crash(root/'object-first','object_first')
    reference_first=crash(root/'reference-first','reference_first')
    assert object_first==dict(exit_code=73,recovery='NO_CHECKPOINT',object_count=1)
    assert reference_first==dict(exit_code=73,recovery='MISSING_ARTIFACT',object_count=0)
    return dict(protocol='real files, hashes, fsync/rename and child process exit; synthetic logical TTL',
                normal=ok,deleted_file=missing_result,modified_file=dict(naive_line3=naive,verified_read=verified),
                same_size_tamper=dict(size_unchanged=True,naive_line3='answer=99',verified_read=same_size_result),
                age_only_gc=ttl_result,publication=dict(object_first=object_first,reference_first=reference_first),
                reference_gc=gc_model(root),
                limits='No power-loss, remote object store, model recovery quality or sandbox authorization tested.')

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='child': publish(Path(sys.argv[2]),sys.argv[3])
    else:
        with tempfile.TemporaryDirectory(prefix='blog-artifacts-') as name:
            print(json.dumps(run(Path(name)),indent=2))
