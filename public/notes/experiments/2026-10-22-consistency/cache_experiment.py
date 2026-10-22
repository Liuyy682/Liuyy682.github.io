#!/usr/bin/env python3
"""Actual SQLite/Redis with reader barriers; schedules, not random race fishing."""
import json
import sqlite3
import tempfile
import threading
from pathlib import Path
from redis_fixture import private_redis,command

# Small integer versions only. Watermark deliberately retained in this model.
INVALIDATE='''
local previous=tonumber(redis.call('GET',KEYS[2]) or '0')
local floor=math.max(previous,tonumber(ARGV[1]))
redis.call('SET',KEYS[2],floor)
local cached=tonumber(redis.call('HGET',KEYS[1],'version') or '0')
if cached < floor then redis.call('DEL',KEYS[1]) end
return floor
'''
FILL='''
local incoming=tonumber(ARGV[1])
local floor=tonumber(redis.call('GET',KEYS[2]) or '0')
local cached=tonumber(redis.call('HGET',KEYS[1],'version') or '0')
if incoming < floor or incoming < cached then return 0 end
redis.call('HSET',KEYS[1],'version',incoming,'value',ARGV[2])
redis.call('PEXPIRE',KEYS[1],60000)
return 1
'''

def scenario(sock,folder,mode):
    dbpath=folder/(mode+'.db')
    with sqlite3.connect(dbpath) as db:
        db.executescript("CREATE TABLE item(version INTEGER,value TEXT);INSERT INTO item VALUES(1,'old');")
    cache,fence=f'demo:{{{mode}}}:cache',f'demo:{{{mode}}}:fence'
    loaded,release=threading.Event(),threading.Event()
    seen={}
    guarded=mode in {'fenced','lost_fence','late_fence'}
    def reader():
        try:
            assert command(sock,'EXISTS',cache)==0
            with sqlite3.connect(dbpath) as db: version,value=db.execute('SELECT version,value FROM item').fetchone()
            seen['reader_version']=version;loaded.set()
            if not release.wait(5): raise TimeoutError('reader release')
            if guarded:
                seen['fill_accepted']=bool(command(sock,'EVAL',FILL,2,cache,fence,version,value))
            else:
                command(sock,'HSET',cache,'version',version,'value',value)
                command(sock,'PEXPIRE',cache,60000);seen['fill_accepted']=True
        except BaseException as e: seen['error']=repr(e);loaded.set()
    thread=threading.Thread(target=reader);thread.start()
    try:
        assert loaded.wait(5) and 'error' not in seen,seen
        with sqlite3.connect(dbpath) as db: db.execute("UPDATE item SET version=2,value='new'")
        if mode in {'fenced','lost_fence'}:
            command(sock,'EVAL',INVALIDATE,2,cache,fence,2)
            command(sock,'EVAL',INVALIDATE,2,cache,fence,1) # out-of-order notification
            if mode=='lost_fence': command(sock,'DEL',fence) # model eviction/early cleanup
        else:
            command(sock,'DEL',cache) # succeeds before the old reader writes
            if mode=='second_delete_before_fill': command(sock,'DEL',cache)
    finally:
        release.set();thread.join(6)
    assert not thread.is_alive() and 'error' not in seen,seen
    before=command(sock,'HGET',cache,'version')
    if mode=='second_delete_after_fill': command(sock,'DEL',cache)
    if mode=='late_fence': command(sock,'EVAL',INVALIDATE,2,cache,fence,2)
    after=command(sock,'HGET',cache,'version')
    with sqlite3.connect(dbpath) as db: authoritative=db.execute('SELECT version FROM item').fetchone()[0]
    result=dict(reader_version=seen['reader_version'],database_version=authoritative,
                old_fill_accepted=seen['fill_accepted'],cache_before_final_action=before,
                cache_after_final_action=after,watermark=command(sock,'GET',fence))
    if mode=='fenced': assert before is None and not seen['fill_accepted'] and result['watermark']=='2'
    elif mode in {'plain','second_delete_before_fill','lost_fence'}: assert after=='1'
    else: assert before=='1' and after is None
    return result

if __name__=='__main__':
    with private_redis() as sock,tempfile.TemporaryDirectory() as folder:
        names=['plain','second_delete_before_fill','second_delete_after_fill','fenced','lost_fence','late_fence']
        rows={name:scenario(sock,Path(folder),name) for name in names}
        print(json.dumps(dict(protocol='real SQLite commit and private Redis; two threads; event-controlled ordering',
            scenarios=rows,limits='No replica lag, Redis failover, Cluster, real TTL expiry, or production latency tested.'),indent=2))
