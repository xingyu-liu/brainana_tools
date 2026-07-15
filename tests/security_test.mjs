// Unit tests for core/server/security.mjs: token compare + path containment.
import assert from 'node:assert/strict'
import path from 'node:path'
import { generateSessionToken, timingSafeEqual, createTokenGuard, isWithin, cleanRelative, resolveWithin } from '../core/server/security.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- token ---
const token = generateSessionToken()
assert.equal(typeof token, 'string')
assert.equal(token.length, 64, 'token is 32 bytes hex')
ok('generateSessionToken returns 64-hex chars')

assert.equal(timingSafeEqual(token, token), true)
assert.equal(timingSafeEqual(token, token.slice(0, -1) + '0'), false)
assert.equal(timingSafeEqual(token, ''), false)
assert.equal(timingSafeEqual('', ''), true)
assert.equal(timingSafeEqual(token, 'short'), false, 'length mismatch is safely false, not a throw')
ok('timingSafeEqual handles equal, unequal, and length-mismatch inputs')

// --- guard ---
const guard = createTokenGuard(token)
const reqWith = (t) => ({ headers: t ? { authorization: `Bearer ${t}` } : {} })
assert.equal(guard(reqWith(token), new URL('http://x/api/x')), true)
assert.equal(guard(reqWith('nope'), new URL('http://x/api/x')), false)
assert.equal(guard(reqWith(null), new URL('http://x/api/x')), false)
// header + query-param sources
assert.equal(guard({ headers: { 'x-brainana-token': token } }, new URL('http://x/')), true)
assert.equal(guard({ headers: {} }, new URL(`http://x/?token=${token}`)), true)
ok('createTokenGuard accepts bearer, header, and query token; rejects wrong/absent')

const openGuard = createTokenGuard(null)
assert.equal(openGuard({ headers: {} }, new URL('http://x/')), true, 'null token disables the guard')
ok('null token disables the guard (legacy loopback)')

// --- path containment ---
assert.equal(isWithin('/a/b', '/a/b/c'), true)
assert.equal(isWithin('/a/b', '/a/b'), true)
assert.equal(isWithin('/a/b', '/a/x'), false)
assert.equal(isWithin('/a/b', '/a/b/../x'), false)
ok('isWithin rejects sibling and parent escapes')

assert.equal(cleanRelative('sub-1/anat'), 'sub-1/anat')
assert.equal(cleanRelative('/sub-1//anat/'), 'sub-1/anat')
assert.equal(cleanRelative('a\\b'), 'a/b')
for (const bad of ['../x', 'a/../../b', 'a/./b/..', 'a\0b']) {
  assert.throws(() => cleanRelative(bad), /Invalid path/, `cleanRelative rejects ${JSON.stringify(bad)}`)
}
ok('cleanRelative normalises and rejects traversal/NUL')

const { clean, resolved } = resolveWithin('/root', 'a/b')
assert.equal(clean, 'a/b')
assert.equal(resolved, path.resolve('/root', 'a', 'b'))
assert.throws(() => resolveWithin('/root', '../escape'))
ok('resolveWithin resolves inside root and rejects escapes')

console.log(`security_test: ${passed} checks passed`)
