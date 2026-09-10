import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { guard, lockedFor, recordFailure, recordSuccess, sweepThrottles, throttleSize } =
  await import('../src/core/throttle.ts')

// Prefixed, because the policy is chosen by prefix: the address bucket locks
// quickly, the account bucket deliberately does not.
let seq = 0
const key = () => `ip:k${seq++}`
const userKey = () => `user:k${seq++}`

beforeEach(() => { sweepThrottles() })

test('a handful of wrong guesses is tolerated', () => {
  const k = key()
  for (let i = 0; i < 5; i++) recordFailure(k)
  assert.equal(lockedFor(k), 0, 'locked before the free attempts were used up')
  assert.doesNotThrow(() => guard([k]))
})

test('the attempt after the free ones locks the key', () => {
  const k = key()
  for (let i = 0; i < 6; i++) recordFailure(k)
  assert.ok(lockedFor(k) > 0, 'not locked after exceeding the free attempts')
  assert.throws(() => guard([k]), /429|시도|attempts/i)
})

test('each further failure lengthens the lock', () => {
  const k = key()
  for (let i = 0; i < 6; i++) recordFailure(k)
  const first = lockedFor(k)
  recordFailure(k)
  const second = lockedFor(k)
  assert.ok(second > first, `lock did not grow: ${first} then ${second}`)
})

test('the lock is capped rather than growing without bound', () => {
  const k = key()
  for (let i = 0; i < 40; i++) recordFailure(k)
  assert.ok(lockedFor(k) <= 15 * 60, `lock exceeded the cap: ${lockedFor(k)}s`)
})

test('a success clears the counter', () => {
  const k = key()
  for (let i = 0; i < 6; i++) recordFailure(k)
  assert.ok(lockedFor(k) > 0)
  recordSuccess(k)
  assert.equal(lockedFor(k), 0)
  assert.doesNotThrow(() => guard([k]))
})

test('one locked key refuses the attempt even when the other is free', () => {
  const locked = key()
  const free = key()
  for (let i = 0; i < 6; i++) recordFailure(locked)
  assert.throws(() => guard([free, locked]))
  assert.doesNotThrow(() => guard([free]))
})

test('accounts and addresses are throttled independently', () => {
  const user = userKey()
  const ip = key()
  for (let i = 0; i < 25; i++) recordFailure(user)
  assert.ok(lockedFor(user) > 0)
  assert.equal(lockedFor(ip), 0, 'locking an account also locked an unrelated address')
})

test('an account is not locked out by the handful of guesses that locks an address', () => {
  // Otherwise anyone who knows a member's address could lock them out at will.
  const user = userKey()
  for (let i = 0; i < 10; i++) recordFailure(user)
  assert.equal(lockedFor(user), 0, 'an account locked after only ten guesses')
})

test('an account does lock once the guessing is sustained', () => {
  const user = userKey()
  for (let i = 0; i < 21; i++) recordFailure(user)
  assert.ok(lockedFor(user) > 0, 'sustained guessing against one account was never stopped')
})

test('cold keys are swept so the table cannot grow forever', () => {
  const k = key()
  recordFailure(k)
  const before = throttleSize()
  assert.ok(before > 0)
  recordSuccess(k)
  sweepThrottles()
  assert.ok(throttleSize() < before || throttleSize() === 0)
})
