// Every email_logs.template value a partner-facing email is logged under. adminAnonymizePartner purges the mail history of a
// removed partner by THIS list, so a partner email logged under a label that is missing here would keep the removed
// partner's address in email_logs forever. tests/partners.mailTemplates.test.js reads email.service.js and fails if any
// partner-facing send() uses a label that is not listed - add the label here in the same change.
// (Several different notices share 'partner_status_changed': rate change, code limit, code expiry, code change, terms
// accepted, payout correction, membership ended. Giving one of them its own label means adding that label here too.)
module.exports = [
  'partner_application_received', 'partner_application_rejected', 'partner_balance_adjusted',
  'partner_commission_reversed', 'partner_conversion_earned', 'partner_dashboard_link_regenerated',
  'partner_email_changed', 'partner_link_regenerated', 'partner_links_recovery', 'partner_links_self_reset',
  'partner_payout_details_changed', 'partner_payout_details_request', 'partner_status_changed',
  'partner_terms_update', 'payout_sent', 'referral_code_created'
]
