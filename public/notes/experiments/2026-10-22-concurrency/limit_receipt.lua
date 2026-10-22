-- Demonstration only: dedicated key types, 60s recovery horizon, no failover.
-- KEYS[1] bucket, KEYS[2] receipt; both use the same Redis Cluster hash tag.
-- ARGV[1] is a fingerprint binding subject, original bucket, operation and payload.
local saved = redis.call('HGET', KEYS[2], 'fingerprint')
if saved then
    if saved ~= ARGV[1] then return redis.error_reply('REQUEST_CONFLICT') end
    return {1, tonumber(redis.call('HGET', KEYS[2], 'count')), 'reused'}
end
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= 2 then return {0, n, 'limited'} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end
redis.call('HSET', KEYS[2], 'fingerprint', ARGV[1], 'count', n)
redis.call('PEXPIRE', KEYS[2], 60000)
return {1, n, 'new'}
