import { isUuidString } from '@/lib/utils/uuid'
import { loadProjectActivity } from '@/lib/utils/project-activity'
import { canReadProject } from '@/lib/utils/project-access'
import { amendmentImpact, baseContractValue } from '@/lib/utils/contract-value'
import { computeContractPosition } from '@/lib/reports/contract-position'
import { getSessionStrict, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import ProjectDetail from '@/components/projects/ProjectDetail'
import { plainTextToRichHtml } from '@/lib/utils/plain-to-rich'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; new?: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  // FIX (deep audit, section 7 — cross-tenant leak): this ran with no
  // session check and no workspace filter at all, unlike the page
  // component below (which checks both). Any request for
  // /projects/<uuid> — authenticated or not, any workspace — leaked that
  // project's name via the page <title>, independent of whether the page
  // body then redirected or 404'd. Scope it exactly like the page does.
  const session = await getSessionStrict()
  if (!session) return { title: 'Project' }
  if (!isUuidString(id)) return { title: 'Project' }
  const service = createServiceClient()
  // FIX (Projects & Dashboard pass 2, B5): workspace scoping alone still let a limited-access member (VIEW_OWN_PROJECTS,
  // not on this project) read its name from the tab title while the page body 404s. Same visibility rule as the page.
  // canReadProject throws on a failed lookup (approvals pass 3, B1) — a tab title must never take the page down.
  try {
    if (!(await canReadProject(service, session, id))) return { title: 'Project' }
  } catch { return { title: 'Project' } }
  const { data: p } = await (service as any)
    .from('projects').select('name').eq('id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null).maybeSingle()
  return { title: p?.name || 'Project' }
}

export default async function ProjectPage({ params, searchParams }: Props) {
  const { id } = await params
  const { tab = 'overview', new: isNew } = await searchParams
  const session = await getSessionStrict()
  if (!session) redirect('/login')

  // A mistyped / truncated id is a plain 404, not a 22P02 thrown into the error boundary (lib/utils/uuid.ts).
  if (!isUuidString(id)) notFound()

  const service = createServiceClient()

  // ── Fetch project ─────────────────────────────────────────────────────
  // FIX (deep audit, section 7 — flagship finding): this select's inline
  // documentation had been pasted *inside* the template literal instead of
  // above it, so the "// FIX (section-10 audit, 10-G1): ..." comment lines
  // were sent to PostgREST as literal characters of the select= query
  // string, not stripped as a JS comment. That string isn't valid select
  // syntax, so the query failed on every single request, `project` came
  // back null, and `if (!project) notFound()` below fired unconditionally
  // — every project's detail page 404'd for every user. Moved the comment
  // back above the query (kept verbatim below) and confirmed the select
  // string is now a single clean template literal with no embedded prose.
  //
  // The original 10-G1 finding this was documenting: counter_amount/
  // counter_note were written by the client portal and read by the
  // accept-counter route — but appeared in NO component anywhere. The CO
  // card rendered a primary "Accept counter" button next to the ORIGINAL
  // total, so the agency was accepting a negotiated figure it had never
  // been shown, and the client's reasoning was nowhere in the product.
  // Fetch them so the card can show what's being accepted.
  // FIX (section-12 audit, flagship finding): tax_rate/tax_inclusive
  // weren't selected on change_orders here at all, so BillingTab's "bill
  // against this CO" picker had no way to carry an accepted CO's own tax
  // terms onto the invoice, even if it wanted to — see the matching fix
  // in components/invoices/BillingTab.tsx's pickSource().
  // FIX (section-9 audit, feature gap): sow_documents.metadata is selected so
  // ProjectDetail's "Regenerate from brief" action can prefill GenerateSowModal
  // from metadata.brief/paymentStructure/revisionRounds. Small jsonb object,
  // already readable by anyone who can read the SOW itself.
  // FIX (Projects & Dashboard independent pass 6 — B1): project_scope_snapshot.last_updated_by ('signing' |
  // 'amendment' | 'scope_adjustment') was not selected, so the Overview tab's "Scope snapshot" provenance label
  // (ProjectDetail.tsx — "Updated by amendment" / "Manually adjusted" / "From signed SOW") always fell through to
  // "From signed SOW", even right after an accepted change order or a manual scope adjustment rewrote the snapshot.
  // NEVER put // comments inside the select template literal below: they are
  // sent to PostgREST verbatim, the query fails, and every project 404s.
  // FIX (Projects & Dashboard pass 10, B1): `error` was ignored and the read used .single(), so a failed read -> `project` null -> notFound():
  // a transient database failure showed the "not found" page for a project that exists. maybeSingle() + a thrown error (app/error.tsx).
  const { data: project, error: projectErr } = await (service as any)
    .from('projects')
    .select(`
      id, name, disc, type, status, stall_reason, stalled_at, contract_value, currency,
      start_date, internal_ref, retainer_duration_months, created_at, updated_at,
      client_id, created_by, workspace_id, guardian_email,
      clients(id, name, company_name, email, cc_emails, phone, notes),
      guardian_flags(id, status, severity, description, sow_reference, type, created_at, change_order_id, escalated_to, resolution),
      exceptions_log(id, deliverable, granted_what, granted_by, estimated_value, reason, flag_id, created_at, updated_at),
      change_orders(id, title, status, parent_co_id, total, subtotal, sent_at, accepted_at, version, document_number,
        counter_amount, counter_note, declined_reason, close_reason, tax_rate, tax_inclusive, is_retainer_renewal, is_credit),
      sow_documents(id, version, status, sent_at, signed_at, created_at, document_number, metadata),
      project_scope_snapshot(id, deliverables, out_of_scope, last_updated_at, last_updated_by)
    `)
    // FIX (re-audit, "current SOW" finding): the sow_documents/change_orders
    // embeds had no explicit order, so PostgREST returned them in whatever
    // order the underlying scan happened to produce — not guaranteed to be
    // version order. ProjectDetail's SowTab does `sows[0]` to decide which
    // SOW the Edit/Send/Withdraw/Remind buttons act on; without this, that
    // could silently be a stale/withdrawn version instead of the live one.
    .order('version', { ascending: false, foreignTable: 'sow_documents' })
    .order('version', { ascending: false, foreignTable: 'change_orders' })
    .order('created_at', { ascending: false, foreignTable: 'exceptions_log' })
    // FIX (Guardian section 13, pass 16 - B-D): the flags embed had no order, so the Guardian tab listed flags in arbitrary order that could reshuffle after an update.
    .order('created_at', { ascending: false, foreignTable: 'guardian_flags' })
    .eq('id', id)
    .eq('workspace_id', session.workspaceId)
    .is('deleted_at', null)
    .maybeSingle()

  if (projectErr) throw new Error(`Project page: project read failed: ${projectErr.message}`)
  if (!project) notFound()

  // FIX (re-audit, cosmetic-gate finding): viewFinancials/viewClientData
  // used to only control what the *client component* rendered, while the
  // server component fetched and shipped the raw data to the browser in
  // every RSC payload regardless of permission — same class of bug as the
  // clients/[id] page already guards against with canViewClientData. Now
  // computed up front so both the DB fetches below and the project object
  // itself can actually withhold the data, not just hide it in the UI.
  const viewFinancials  = hasPermission(session, 'VIEW_FINANCIALS')
  const viewClientData  = hasPermission(session, 'VIEW_CLIENT_DATA')

  if (!viewFinancials) {
    project.contract_value = null
    if (Array.isArray(project.change_orders)) {
      // counter_amount is financial data on the same footing as total —
      // withhold it from the same people (10-G1).
      project.change_orders = project.change_orders.map((co: any) => ({ ...co, total: null, subtotal: null, counter_amount: null }))
    }
  }
  // exceptions_log.estimated_value is the dollar value of scope given away —
  // financial data on the same footing as change-order totals. It was selected
  // above and only hidden by the ExceptionCard UI, so it still travelled to
  // the browser for members without VIEW_FINANCIALS.
  if (!viewFinancials && Array.isArray(project.exceptions_log)) {
    project.exceptions_log = project.exceptions_log.map((e: any) => ({ ...e, estimated_value: null }))
  }
  if (!viewClientData && project.clients) {
    const { id: clientId, name } = project.clients
    project.clients = { id: clientId, name } // strip email, cc_emails, phone, notes
  }

  // Check project access (own projects check)
  const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')
  if (!canViewAll) {
    // Same rule as every API route (project_members_active: the member must still be ACTIVE in this
    // workspace). This page used to run its own raw project_members query that ignored member status.
    if (!(await canReadProject(service, session, id))) notFound()
  }

  // ── Fetch payment milestones ──────────────────────────────────────────
  // FIX (re-audit): gated behind viewFinancials — was fetched unconditionally
  // and shipped to the client regardless of permission.
  // FIX (Projects & Dashboard pass 10, B1): a failed read left `milestones` null -> []: an open-ended retainer's effective total (months billed x rate)
  // collapsed to one month. A page that shows wrong money is worse than an error page, so a failed read throws.
  const { data: milestones = [], error: milestonesErr } = viewFinancials
    ? await (service as any)
        .from('payment_milestones')
        .select('*')
        .eq('project_id', id)
        .order('created_at', { ascending: true })
    : { data: [], error: null }
  if (milestonesErr) throw new Error(`Project page: milestones read failed: ${milestonesErr.message}`)

  // ── Fetch amendments ──────────────────────────────────────────────────
  // FIX (Projects & Dashboard pass 10, B1): a failed read showed an effective contract total with every accepted CO missing. Throws instead.
  const { data: amendmentsRaw = [], error: amendmentsErr } = await (service as any)
    .from('amendments')
    // FIX (Projects & Dashboard independent pass — B1): was select('*'), which carried every column to the browser —
    // including previous_contract_value (the monthly rate a retainer-renewal CO replaced, migration 061) and
    // pdf_path — while only financial_impact was redacted for a viewer without VIEW_FINANCIALS. Only what
    // amendmentImpact() needs is read here; the client-bound list is narrowed again below.
    .select('id, title, effective_at, added_deliverables, financial_impact, change_orders(is_retainer_renewal)')
    .eq('project_id', id)
    .order('created_at', { ascending: true })
  if (amendmentsErr) throw new Error(`Project page: amendments read failed: ${amendmentsErr.message}`)

  // financial_impact is a dollar figure — redact it the same way as the
  // rest of the financial surface when the viewer lacks VIEW_FINANCIALS.
  // Narrowed to the fields the Overview/SOW tabs render (no raw embed, no storage path, no prior rate).
  const amendments = (amendmentsRaw || []).map((a: any) => ({
    id: a.id, title: a.title, effective_at: a.effective_at, added_deliverables: a.added_deliverables,
    financial_impact: viewFinancials ? a.financial_impact : null,
  }))

  // ── Fetch team members ────────────────────────────────────────────────
  // FIX (Projects & Dashboard independent pass, round 2): this was the one place in the
  // codebase that joined workspace_members without `!inner` + `.eq('workspace_members.status',
  // 'active')` — every other embed of this table (GET /api/projects, the Dashboard, the Projects
  // list, /api/invoices, /api/search, /api/clients) filters to active members this same way.
  // project_members rows are never cleaned up when a member is deactivated (see
  // lib/utils/project-access.ts's own comment on this), so a departed team member stayed
  // permanently visible here — full name, email, avatar, a working Remove button — indistinguishable
  // from someone still active. The same unfiltered `team` array is also what feeds the Escalate-flag
  // and Escalate-CO modals' "Escalate to" dropdowns (see ProjectDetail.tsx), so a deactivated
  // colleague could be picked as an escalation target; the API already rejects that server-side
  // ("not an active member of this workspace"), but the dropdown shouldn't offer them in the first
  // place. Filtering here fixes both surfaces from their one shared source.
  // FIX (Projects & Dashboard pass 10, B1): a failed read showed an empty team (and empty Escalate-to dropdowns). Throws instead.
  const { data: team = [], error: teamErr } = await (service as any)
    .from('project_members')
    .select('id, added_at, workspace_members!inner(id, users!workspace_members_user_id_fkey(id, name, email, avatar_url))')
    .eq('project_id', id)
    .eq('workspace_members.status', 'active')
  if (teamErr) throw new Error(`Project page: team read failed: ${teamErr.message}`)

  // ── Fetch activity ────────────────────────────────────────────────────
  // audit_log.project_id (migration 056) attaches SOW / CO / flag / Guardian-check / invoice events to
  // their project, not just project.* rows.
  // Shaped server-side by lib/utils/project-activity.ts (sentences only — raw metadata never reaches the
  // browser; money only for VIEW_FINANCIALS). "Load more" pages through /api/projects/[id]/activity.
  const { rows: activity, hasMore: activityHasMore } =
    await loadProjectActivity(service, session.workspaceId, id, viewFinancials)
      .catch((e: unknown) => { console.error('Project page: activity load failed:', e); return { rows: [], hasMore: false } })

  // ── Fetch invoices (Phase 4a) ────────────────────────────────────────
  // FIX (re-audit): gated behind viewFinancials, same as milestones above.
  // FIX (Projects & Dashboard pass 10, B1): a failed read left `invoices` null. With SEND_INVOICES that null went straight to BillingTab (which
  // calls invoices.some(...) and crashes the Billing tab); without it the map() fell back to "No invoices yet" — a wrong answer about money
  // either way. Throws instead.
  const { data: invoices = [], error: invoicesErr } = viewFinancials
    ? await (service as any)
        .from('invoices')
        // FIX (section-12 fix round): subtotal/disputed_at/dispute_note added —
        // subtotal so BillingTab can compute remaining billable amount against
        // a SOW/CO (the cumulative over-billing fix), disputed_at/dispute_note
        // so a client's portal dispute is actually visible somewhere in the
        // agency's own UI instead of only firing a one-time notification.
        // FIX (section-12 re-audit — feature gap): payment_claimed_at/
        // payment_claim_reference/payment_claim_cleared_at added for the exact same
        // reason disputed_at/dispute_note were — api/portal/invoice/[token]/paid's
        // "I've paid this" claim fired one notification and then had zero trace
        // anywhere in this UI, unlike a dispute right next to it in the same table.
        .select('id, milestone_id, sow_id, co_id, invoice_number, title, amount, amount_paid, subtotal, currency, status, due_date, sent_at, paid_at, voided_at, disputed_at, dispute_note, dispute_resolved_at, dispute_resolution_note, payment_claimed_at, payment_claim_reference, payment_claim_cleared_at, token, created_at')
        .eq('project_id', id)
        .order('created_at', { ascending: false })
    : { data: [], error: null }
  if (invoicesErr) throw new Error(`Project page: invoices read failed: ${invoicesErr.message}`)

  // FIX (independent pass 3): `token` above is the raw, unauthenticated client-portal
  // link for each invoice — same shape as the SOW `token` the section-9 re-audit already
  // dropped from its own select for exactly this reason ("no frontend consumer ever read
  // sow.token from this response... pure over-exposure"). Nothing in BillingTab reads
  // inv.token except the "Copy link" button, which should only be offered to someone who
  // can actually act as the sender (SEND_INVOICES) — VIEW_FINANCIALS is a much broader,
  // often read-only grant (reporting/oversight roles). Without this, any such viewer could
  // copy the link straight out of the page source and act on the portal as the client:
  // file a dispute, or — now that /api/portal/invoice/[token]/paid exists — file a false
  // "I've paid this" claim that pings finance and pauses the real client's overdue
  // reminders. Redacted per-row rather than dropped from the query so BillingTab's other
  // consumers of `invoices` (which don't need SEND_INVOICES) keep working unchanged.
  const canSendInvoices = hasPermission(session, 'SEND_INVOICES')
  const invoicesForClient = canSendInvoices
    ? invoices
    : (invoices || []).map((inv: any) => ({ ...inv, token: null }))

  // ── Contract position for the Billing tab (Phase 4) ───────────────────
  // Computed live (lib/reports/contract-position.ts — the function the invoice PDFs, send path and
  // over-contract check use) and handed to BillingTab as one row in the snapshot shape it already reads.
  // The nightly snapshot history must NOT be read here: ascending + limit(90) returns the OLDEST 90 rows, so
  // a project older than ~90 days froze on its day-90 figures, and every figure lagged by up to a day.
  // If the live computation fails it returns null and BillingTab falls back to summing the invoices it has.
  const livePosition = viewFinancials ? await computeContractPosition(service, id) : null
  const reconciliation = livePosition
    ? [{
        contracted_value: livePosition.contractedValue,
        invoiced_to_date: livePosition.invoicedToDate,
        paid_to_date:     livePosition.paidToDate,
        at_risk_value:    livePosition.atRiskValue,
        snapshot_date:    new Date().toISOString().slice(0, 10),
      }]
    : []

  // Effective contract value — the shared definition (lib/utils/contract-value.ts): base (monthly rate ×
  // term for retainers) + amendments, minus retainer-renewal amendments (a renewal replaces the rate; it
  // must not also be added on top). All three are financial figures: withheld without VIEW_FINANCIALS.
  // An OPEN-ENDED retainer (no term) has no fixed total: its contract is the months committed so far
  // (one retainer_monthly milestone each) — see baseContractValue.
  const retainerMonthsBilled = (milestones || []).filter((m: any) => m.type === 'retainer_monthly').length
  const baseValue        = viewFinancials ? baseContractValue(project, retainerMonthsBilled) : null
  const amendmentTotal   = viewFinancials ? amendmentImpact(amendmentsRaw, project.type) : null
  const effectiveContractValue = viewFinancials
    ? Math.max(0, (baseValue as number) + (amendmentTotal as number))
    : null

  // ── Fetch in-flight approval requests (Phase 3) ─────────────────────────
  // Keyed by "sow:<id>" / "co:<id>" so ProjectDetail can look one up per
  // document without a join — a SOW/CO's status stays 'draft' while an
  // approval chain is pending, so this is the only signal the UI has that
  // a draft is actually "sent for approval" rather than just untouched.
  // FIX (fix round, section-11 flagship finding): only ever matched
  // status='pending' — a request that fully cleared approval but then
  // failed to auto-send (status='approved', send_failed_at set —
  // migration 053) is invisible here too, even though the underlying
  // document is still sitting at 'draft' the same way a pending one is.
  // Before this fix, the ONLY place that state was visible to anyone but
  // the original requester was the one-time email/notification sent at
  // decision time — nothing on the project's own SOW/CO/Billing tab ever
  // showed it. Broadened to match both states; sendFailed/sendFailedReason
  // let ProjectDetail render the retry banner instead of the ordinary
  // "awaiting approval" one.
  // FIX (approvals independent pass, B1): `error` was ignored, so a failed read hid the "awaiting approval" / retry banner
  // on every document tab (and made Send look available again). The page still renders, but the failure is logged.
  const { data: pendingApprovalRows = [], error: pendingApprovalErr } = await (service as any)
    .from('approval_requests')
    .select('id, document_type, document_id, current_step, total_steps, send_failed_at, send_failed_reason, requested_by')
    .eq('project_id', id)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
  if (pendingApprovalErr) console.error('Project page: pending approvals read failed — approval banners are missing:', pendingApprovalErr.message)

  const pendingApprovals: Record<string, { id: string; current_step: number; total_steps: number; sendFailed: boolean; sendFailedReason: string | null; canManage: boolean }> = {}
  for (const r of pendingApprovalRows || []) {
    pendingApprovals[`${r.document_type}:${r.document_id}`] = {
      id: r.id, current_step: r.current_step, total_steps: r.total_steps,
      sendFailed: !!r.send_failed_at, sendFailedReason: r.send_failed_reason || null,
      // FIX (section-11 audit, independent pass — B5): retry-send and cancel are requester-or-admin on the
      // server (403 otherwise). The project tabs offered those buttons to anyone holding the send
      // permission, so everyone else got a refusal after clicking. Computed here so the buttons match.
      canManage: r.requested_by === session.id || hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'),
    }
  }

  // FIX (doc-completeness audit): workspace.default_payment_instructions
  // was set in Settings but never read anywhere — the new-invoice form
  // always started blank. Fetch it so BillingTab can prefill.
  // FIX (Settings independent pass 16, B1): the agency's bank / wire instructions were read for EVERY member who opens a
  // project and handed to ProjectDetail (a Client Component), so they sat in the page payload of people who can't even
  // see the Billing tab. Settings withholds the same field from anyone without MANAGE_WORKSPACE_SETTINGS. Only a member
  // who can create invoices (SEND_INVOICES — the only place the prefill is used) gets it.
  let workspaceBilling: { default_payment_instructions?: string | null } | null = null
  if (hasPermission(session, 'SEND_INVOICES')) {
    const { data } = await (service as any)
      .from('workspaces')
      .select('default_payment_instructions')
      .eq('id', session.workspaceId)
      .single()
    workspaceBilling = data
  }

  // FEATURE (Settings & Team round): workspace billing defaults (migration 076) — read separately and
  // tolerantly, like the client-reminder columns in Settings, so a deploy that runs ahead of the
  // migration shows a plain invoice form instead of failing the whole project page.
  let billingDefaults = { taxRate: 0, taxInclusive: false, paymentTermsDays: null as number | null }
  {
    const { data: bd, error: bdErr } = await (service as any)
      .from('workspaces')
      .select('default_tax_rate,default_tax_inclusive,default_payment_terms_days')
      .eq('id', session.workspaceId)
      .maybeSingle()
    if (!bdErr && bd) {
      // FIX (section-12 re-audit — bug): default_tax_rate defaults to 0 and
      // default_tax_inclusive defaults to true INDEPENDENTLY (migration 076), so a
      // workspace that has never visited Settings → Billing defaults fed BillingTab's
      // CreateInvoiceModal a taxInclusive:true default alongside a 0% rate — a
      // combination invoices.tax_inclusive's own column default (false) rejects, and
      // that lib/documents/tax-defaults.ts's workspaceTaxDefaults() (this same
      // setting's other consumer) already refuses to return, on the explicit rule
      // that only a configured, POSITIVE rate carries an inclusive flag. Mirrors the
      // matching fix in app/api/workspace/billing-defaults/route.ts (used by the CO
      // editor's own client-side fetch of the same setting).
      const rate = Number(bd.default_tax_rate) || 0
      billingDefaults = {
        taxRate: rate,
        taxInclusive: rate > 0 ? (bd.default_tax_inclusive ?? true) : false,
        paymentTermsDays: bd.default_payment_terms_days ?? null,
      }
    }
  }

  return (
    <ProjectDetail
      project={project}
      milestones={milestones || []}
      amendments={amendments || []}
      team={team || []}
      activity={activity || []}
      invoices={invoicesForClient}
      reconciliation={reconciliation || []}
      defaultPaymentInstructions={plainTextToRichHtml(workspaceBilling?.default_payment_instructions)}
      billingDefaults={billingDefaults}
      effectiveContractValue={effectiveContractValue}
      baseContractValue={baseValue}
      amendmentImpact={amendmentTotal}
      activityHasMore={activityHasMore}
      initialTab={tab}
      isNewProject={isNew === '1'}
      session={session}
      pendingApprovals={pendingApprovals}
      permissions={{
        editSow: hasPermission(session, 'EDIT_SOW'),
        sendSow: hasPermission(session, 'SEND_SOW'),
        createCo: hasPermission(session, 'CREATE_CHANGE_ORDERS'),
        sendCo: hasPermission(session, 'SEND_CHANGE_ORDERS'),
        approveFlags: hasPermission(session, 'APPROVE_FLAGS'),
        grantExceptions: hasPermission(session, 'GRANT_EXCEPTIONS'),
        markComplete: hasPermission(session, 'MARK_PROJECT_COMPLETE'),
        // Edit details / pause / resume (PATCH /api/projects/[id]).
        editProject: hasPermission(session, 'CREATE_PROJECTS'),
        submitGuardian: hasPermission(session, 'SUBMIT_GUARDIAN_CHECKS'),
        viewGuardianHistory: hasPermission(session, 'ACCESS_GUARDIAN_HISTORY'),
        assignTeam: hasPermission(session, 'ASSIGN_TEAM_MEMBERS'),
        viewFinancials: hasPermission(session, 'VIEW_FINANCIALS'),
        deleteProject: hasPermission(session, 'DELETE_PROJECTS'),
        sendInvoices: hasPermission(session, 'SEND_INVOICES'),
        // FIX (deep audit, section 7): DELETE /api/projects/[id]/messages/
        // [messageId] already lets an admin (MANAGE_WORKSPACE_SETTINGS)
        // delete anyone's message — moderation of a stray/inappropriate
        // post shouldn't require a database console — but no permission
        // for it ever reached the frontend, so the Discussion tab never
        // showed a delete affordance for anything but the author's own
        // messages.
        moderateMessages: hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'),
      }}
    />
  )
}
