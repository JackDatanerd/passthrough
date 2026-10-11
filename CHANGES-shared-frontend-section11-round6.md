# Shared frontend (section 11) — round 6

Bugs
- B1 Admin step-up password prompt rendered UNDER the refund/ban/payout dialog that asked for it. `Modal` now portals into
  <body> (later dialog = on top); the prompt is rebuilt on Modal/Form/PasswordInput/Button.
- B2 `GET /scan/:id/download-draft-pdf` gets the long timeout and is never auto-retried (a retry started a second render).
- B3 `useApi`: a failure always surfaces (only a call pushed aside by `replace:true` is ignored); new `keepAlive` option;
  Partners/payout modals are non-dismissible while saving.
- Session end resets its guard even if the redirect is cancelled; step-up token cleared on logout/session end and sent only
  on non-GET requests.
- Toast: pause no longer sticks after a keyboard dismiss. Navbar "More" menu closes on link tap. copyToClipboard restores
  focus / works on iOS. Input/Textarea/Select show a disabled state. vitest dedupes React.

Feature gaps
- Modal `size` prop; focus returns to the trigger even when content autofocuses.
- `hooks/useCopy` replaces six hand-rolled "Copied" timers.
- `formatNumber`; browser-locale dates/numbers now use formatDate/formatDateTime/formatNumber.
- Select-page checkbox is a real Checkbox with a mixed state; four raw selects + one textarea use the shared components.
- Removed `components/ui/DataTable.jsx` (used nowhere): delete the file when applying (tar cannot delete).

Left as is: modal background `inert` (toasts live in #root), AdminLeads notes textarea + CSV picker, lib/quota.js time format.
