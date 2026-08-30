import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { forceReauth, isSignedOutError, reauthSuppressed, resetReauthGuard } from './reauth'

/**
 * `.ai/specs/2026-08-19-signed-out-cockpit-reauth.md`, tests 4 and 5.
 *
 * Two things are under test and they fail in opposite directions, so both need their own
 * negative control:
 *
 * - **`isSignedOutError` too WIDE** sends a user who hit a 403, a 500 or a dropped connection to
 *   an identity provider that cannot help them — a redirect loop dressed as a fix. The
 *   `does not fire` table is the control, and it is deliberately longer than the positive case.
 * - **The guard too STICKY** strands a tab on the button forever after one blip. `expires after
 *   the window` is the control for that: a guard that latched would pass every other test here.
 */

/** jsdom's `window.location.assign` is a real navigation it refuses to perform (and logs loudly
 *  about). Replacing the whole `location` object is the only way to observe the call — a spy on
 *  the live one still lets jsdom's own implementation run. Restored in `afterEach`. */
const realLocation = window.location
let assign: ReturnType<typeof vi.fn>

function stubLocation(): void {
  assign = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...realLocation, assign, href: 'https://cezar.example/tasks' },
  })
}

beforeEach(() => {
  stubLocation()
  window.sessionStorage.clear()
  resetReauthGuard()
})

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  })
  vi.useRealTimers()
})

describe('isSignedOutError', () => {
  it('a 401 from cezar is signed out', () => {
    expect(isSignedOutError(new ApiError(401, 'unauthenticated'))).toBe(true)
  })

  it('an identity-gate redirect is signed out, even though its status is 0', () => {
    const error = new ApiError(0, 'answered by an identity provider', { identityGate: true })
    expect(isSignedOutError(error)).toBe(true)
  })

  /**
   * THE control. Each row is a failure the cockpit already reports honestly, and each would be a
   * different bug if it redirected: a 403 is the server answering an authenticated caller, a 500
   * is cezar broken, `ApiError(0)` with no flag is the machine offline, and a bare `Error` is a
   * bug in our own code. A predicate that fired on any of them would loop the user through an
   * IdP that has nothing to fix.
   */
  it.each([
    ['403 forbidden', new ApiError(403, 'not allowed')],
    ['404 not found', new ApiError(404, 'no such run')],
    ['409 conflict', new ApiError(409, 'run is active')],
    ['500 server error', new ApiError(500, 'boom')],
    ['offline: status 0 with no identityGate', new ApiError(0, 'cannot reach the cezar-plus server')],
    ['a plain Error', new Error('unauthenticated')],
    ['a string that says 401', '401'],
    ['undefined', undefined],
  ])('does not fire on %s', (_label, error) => {
    expect(isSignedOutError(error)).toBe(false)
  })
})

describe('forceReauth', () => {
  it('navigates the document to /auth/login', () => {
    forceReauth()
    expect(assign).toHaveBeenCalledExactlyOnceWith('/auth/login')
  })

  /** A page whose twelve queries all 401 in the same tick must produce ONE navigation, not
   *  twelve — the same guard that bounds the loop bounds this. */
  it('a burst of failures navigates once', () => {
    forceReauth()
    forceReauth()
    forceReauth()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('suppresses a second redirect inside the window, and says so', () => {
    forceReauth()
    expect(reauthSuppressed()).toBe(true)

    stubLocation() // a fresh document, as if the IdP handed us back
    forceReauth()
    expect(assign).not.toHaveBeenCalled()
    expect(reauthSuppressed()).toBe(true)
  })

  /** The control for the control. A guard that LATCHED instead of expiring would pass every
   *  other case in this file and quietly break the ordinary "sign out, sign back in" path. */
  it('expires after the window, and navigates again', () => {
    vi.useFakeTimers()
    forceReauth()
    expect(assign).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_001)
    stubLocation()
    expect(reauthSuppressed()).toBe(false)
    forceReauth()
    expect(assign).toHaveBeenCalledExactlyOnceWith('/auth/login')
  })

  /** A stamp from the future is a clock that moved, not a redirect we just made. Erring toward
   *  navigating is what keeps the owner's zero-click path working across a laptop sleep. */
  it('ignores a stamp from the future', () => {
    window.sessionStorage.setItem('cezar:reauth-at', String(Date.now() + 60_000))
    expect(reauthSuppressed()).toBe(false)
    forceReauth()
    expect(assign).toHaveBeenCalledExactlyOnceWith('/auth/login')
  })

  /** Safari private mode / a locked-down profile. The redirect must still happen — an unguarded
   *  navigation is strictly better than a tab that will not sign in at all. */
  it('still navigates when sessionStorage throws', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('storage disabled')
      })
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage disabled')
      })

    forceReauth()
    expect(assign).toHaveBeenCalledExactlyOnceWith('/auth/login')

    getItem.mockRestore()
    setItem.mockRestore()
  })
})
