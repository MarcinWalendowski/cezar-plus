import { useMutation, useQuery } from '@tanstack/react-query'
import { LogOutIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SettingsField } from './settings-field'
import { logout, probeAccountAvailable } from './account-api'

/**
 * The actual Settings → Account content (D14) — dynamically imported by `account-section.tsx`,
 * which is the file that owns why this is a separate module (same reasoning as `teams-section.tsx`
 * / `teams-panel.tsx`).
 *
 * Renders NOTHING (`null`) while the probe is pending or errors — no flash of an explainer that a
 * resolved probe is about to replace.
 *
 * **CORRECTED 2026-08-07 (same day as D14): a resolved `false` renders a one-line explainer, not
 * `null`.** The original reasoning below was sound about the CONTENT and wrong about the
 * CONSEQUENCE. `account-section.tsx` declares this section unconditionally, because
 * `visibleSettingsSections`'s three gates are synchronous and `capabilitiesSchema` deliberately
 * carries no `auth` key to gate on (D1's Risks; `capabilities.test.ts:213`). So `null` here did not
 * make the section "read as absent" — it left a live nav entry, titled *Account* and described
 * *"Sign out of this cezar deployment"*, that opens a blank pane. On the npm zero-config default —
 * the MOST common deployment, and the one D13 just made org-capable — that is every local user's
 * experience of this feature, and a blank pane behind a real nav item reads as a broken build, not
 * as a deployment without sessions.
 *
 * Original reasoning, preserved: *"a deliberately quieter degradation than `teams-panel.tsx`'s
 * 'Sign-in isn't set up on this deployment' explainer. That pane still has something honest to say
 * about EVERY probe outcome (workspaces are a real, documented feature this deployment either has
 * or doesn't); this one exists to hold exactly one action, and on a deployment with nothing to sign
 * out of there is nothing to say about its absence either."* — true of the content, but the choice
 * was between an explainer and a blank pane, never between an explainer and nothing at all.
 */
export function AccountPanel() {
  const probe = useQuery({
    queryKey: ['settings', 'account', 'available'] as const,
    queryFn: ({ signal }) => probeAccountAvailable(signal),
  })

  if (probe.isPending || probe.isError) return null
  if (probe.data !== true) {
    return (
      <p data-slot="account-unavailable" className="p-4 text-[13px] text-soft-foreground md:p-6">
        This cezar deployment has no sign-in, so there is no session to end. Accounts appear here
        once the server is started with an authentication provider configured.
      </p>
    )
  }
  return <AccountBody />
}

function AccountBody() {
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      // A full navigation, not a client-side one: logout ends the session this whole SPA's
      // in-memory query cache was built against, so the honest reset is a fresh document load —
      // the same discipline `onboarding.tsx#SignInStep`'s `<a href="/auth/login">` already applies
      // to the opposite direction (a real navigation, not a client-side route change).
      window.location.assign('/')
    },
  })

  return (
    <div
      data-slot="account-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField title="Sign out" hint="Ends your session on this cezar deployment.">
        <div>
          <Button
            type="button"
            variant="outline"
            data-slot="account-sign-out"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <LogOutIcon className="size-[15px]" aria-hidden="true" />
            {signOut.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
          {signOut.isError ? (
            <p data-slot="account-sign-out-error" role="alert" className="mt-2 text-[13px] text-danger">
              {signOut.error instanceof Error ? signOut.error.message : 'could not sign out'}
            </p>
          ) : null}
        </div>
      </SettingsField>
    </div>
  )
}
