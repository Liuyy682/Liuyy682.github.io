-- Demonstration: at most two admitted evaluations in a 60s bucket.
-- A repeat evaluation has no logical request identity.
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= 2 then return {0, n} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end
return {1, n}
