#!/usr/bin/env python3
"""Run a private Redis on a temporary UNIX socket (TCP disabled, persistence off).

The fault proxy consumes a real Redis reply then closes its client socket without
sending the reply. This is deterministic response loss, not a Redis crash/failover.
"""
import hashlib
import json
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path


class RedisError(Exception):
    pass


def read_reply(stream):
    line = stream.readline()
    if not line:
        raise EOFError('response connection closed')
    kind, value = line[:1], line[1:-2]
    if kind == b'+': return value.decode()
    if kind == b'-': raise RedisError(value.decode())
    if kind == b':': return int(value)
    if kind == b'$':
        size = int(value)
        if size == -1: return None
        raw = stream.read(size + 2)
        if len(raw) != size + 2: raise EOFError('short bulk reply')
        return raw[:-2].decode()
    if kind == b'*': return [read_reply(stream) for _ in range(int(value))]
    raise ValueError('unsupported RESP reply')


def encode(args):
    items = [str(arg).encode() for arg in args]
    return b'*%d\r\n' % len(items) + b''.join(b'$%d\r\n' % len(x) + x + b'\r\n' for x in items)


def command(path, *args):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5)
        sock.connect(str(path))
        sock.sendall(encode(args))
        with sock.makefile('rb') as stream:
            return read_reply(stream)


def lose_reply(path, *args):
    client, proxy = socket.socketpair()
    observation = {}
    client.settimeout(5)
    proxy.settimeout(5)
    def forward():
        try:
            with proxy, proxy.makefile('rb') as request:
                received = read_reply(request)
                observation['backend_reply'] = command(path, *received)
                # Deliberately omit response forwarding; closing produces client EOF.
        except BaseException as error:
            observation['proxy_error'] = repr(error)
    thread = threading.Thread(target=forward)
    thread.start()
    try:
        with client, client.makefile('rb') as stream:
            client.sendall(encode(args))
            try:
                read_reply(stream)
                raise AssertionError('reply should have been dropped')
            except EOFError:
                observation['client_result'] = 'EOF_UNKNOWN'
    finally:
        thread.join(6)
    assert not thread.is_alive() and 'proxy_error' not in observation, observation
    return observation


def run(path):
    here = Path(__file__).resolve().parent
    basic = (here / 'limit.lua').read_text()
    receipt = (here / 'limit_receipt.lua').read_text()
    info = command(path, 'INFO', 'server')
    version = next(s.split(':',1)[1] for s in info.splitlines() if s.startswith('redis_version:'))
    plain_key = 'demo:{plain}:bucket-W'
    lost = lose_reply(path, 'EVAL', basic, 1, plain_key)
    retry = command(path, 'EVAL', basic, 1, plain_key)
    another = command(path, 'EVAL', basic, 1, plain_key)
    assert lost['backend_reply'] == [1,1] and retry == [1,2] and another == [0,2]
    bucket, request = 'demo:{receipt}:bucket-W', 'demo:{receipt}:request-R1'
    fingerprint = hashlib.sha256(b'alice|W|analyze|video-1').hexdigest()
    lost_dedup = lose_reply(path, 'EVAL', receipt, 2, bucket, request, fingerprint)
    reused = command(path, 'EVAL', receipt, 2, bucket, request, fingerprint)
    conflict = False
    try: command(path, 'EVAL', receipt, 2, bucket, request, 'different-payload')
    except RedisError as e: conflict = 'REQUEST_CONFLICT' in str(e)
    count_after_reuse = int(command(path, 'GET', bucket))
    fresh = command(path, 'EVAL', receipt, 2, bucket, 'demo:{receipt}:request-R2', fingerprint)
    assert lost_dedup['backend_reply'] == [1,1,'new']
    assert reused == [1,1,'reused'] and count_after_reuse == 1 and conflict
    assert fresh == [1,2,'new']
    key = 'demo:{failure}:count'
    broken = "redis.call('INCR',KEYS[1]); redis.call('LPUSH',KEYS[1],'x'); redis.call('PEXPIRE',KEYS[1],60000)"
    error_text = ''
    try: command(path, 'EVAL', broken, 1, key)
    except RedisError as e: error_text = str(e)
    value, ttl = command(path, 'GET', key), command(path, 'PTTL', key)
    assert 'WRONGTYPE' in error_text and value == '1' and ttl == -1
    return dict(redis_version=version,
                protocol='isolated UNIX socket; persistence disabled; proxy drops reply after backend completion',
                without_receipt=dict(first=lost, retry=retry, next_logical_request=another),
                with_receipt=dict(first=lost_dedup, retry=reused, count_after_retry=count_after_reuse,
                                  conflicting_payload_rejected=conflict, next_logical_request=fresh),
                script_error=dict(error_kind='WRONGTYPE', retained_value=value, pttl_ms=ttl),
                limits='No Redis crash, persistence recovery, replica promotion, Cluster, or production traffic tested.')


if __name__ == '__main__':
    # No FLUSHDB and no connection to any existing Redis instance.
    with tempfile.TemporaryDirectory(prefix='blog-redis-') as folder:
        sock = Path(folder) / 'redis.sock'
        proc = subprocess.Popen(['redis-server','--port','0','--unixsocket',str(sock),
            '--unixsocketperm','700','--save','','--appendonly','no','--dir',folder],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while True:
                if proc.poll() is not None: raise RuntimeError('private Redis exited during startup')
                try:
                    if command(sock, 'PING') == 'PONG': break
                except OSError: pass
                if time.monotonic() > deadline: raise TimeoutError('Redis startup')
                time.sleep(.02)  # Readiness only; does not decide experiment ordering.
            print(json.dumps(run(sock), ensure_ascii=False, indent=2))
        finally:
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait()
