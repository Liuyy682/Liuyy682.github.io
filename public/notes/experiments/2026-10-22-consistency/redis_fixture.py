"""Private temporary Redis, minimal RESP client; never connects to existing data."""
import contextlib
import socket
import subprocess
import tempfile
import time
from pathlib import Path

def reply(stream):
    line=stream.readline()
    if not line: raise EOFError('Redis response closed')
    kind,value=line[:1],line[1:-2]
    if kind==b'+': return value.decode()
    if kind==b'-': raise RuntimeError(value.decode())
    if kind==b':': return int(value)
    if kind==b'$':
        n=int(value)
        if n==-1: return None
        raw=stream.read(n+2)
        if len(raw)!=n+2: raise EOFError('short reply')
        return raw[:-2].decode()
    if kind==b'*': return [reply(stream) for _ in range(int(value))]
    raise ValueError('unexpected RESP type')

def command(path,*args):
    items=[str(x).encode() for x in args]
    data=b'*%d\r\n'%len(items)+b''.join(b'$%d\r\n'%len(x)+x+b'\r\n' for x in items)
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5);sock.connect(str(path));sock.sendall(data)
        with sock.makefile('rb') as stream: return reply(stream)

@contextlib.contextmanager
def private_redis():
    with tempfile.TemporaryDirectory(prefix='cache-blog-') as folder:
        path=Path(folder)/'redis.sock'
        process=subprocess.Popen(['redis-server','--port','0','--unixsocket',str(path),
            '--unixsocketperm','700','--save','','--appendonly','no','--dir',folder],
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            deadline=time.monotonic()+5
            while True:
                if process.poll() is not None: raise RuntimeError('private Redis exited')
                try:
                    if command(path,'PING')=='PONG': break
                except OSError: pass
                if time.monotonic()>deadline: raise TimeoutError('Redis readiness')
                time.sleep(.02)
            yield path
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill();process.wait()
