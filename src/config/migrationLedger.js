// The name each migration from 0082 on records in applied_migrations (its own file name, minus .sql).
//
// Database round 5 (feature gap): the ledger's health check compared VERSION NUMBERS only. Files in this repo have been renumbered
// after commit (0076 -> 0081, 0083 -> 0084, 0096 -> 0098), and two different files once held the same number, so "version N is in
// the ledger" could mean a DIFFERENT migration than the one this code needs ran — a skipped migration passed the health check.
// The Worker cannot read the migrations directory, so the names live here; tests/migrations.numbering.test.js fails when this
// list and supabase/migrations/ disagree, so a new migration cannot ship without its line.
const LEDGER_NAMES = {
  82: '0082_database_round2',
  83: '0083_webhooks_round13',
  84: '0084_profile_dashboard_round13',
  85: '0085_partners_section4_round14',
  86: '0086_webhooks_round14',
  87: '0087_database_round3',
  88: '0088_scan_stage_progress',
  89: '0089_scan_ats_round10',
  90: '0090_webhooks_round16',
  91: '0091_database_round4',
  92: '0092_scan_ats_round11',
  93: '0093_partners_section4_round16',
  94: '0094_prompt_version',
  95: '0095_partners_section4_round17',
  96: '0096_paper_size',
  97: '0097_webhooks_round19',
  98: '0098_partners_section4_round18',
  99: '0099_partners_section4_round20',
  100: '0100_database_round5',
  101: '0101_doc_template_version',
  102: '0102_doc_look_3',
  103: '0103_webhooks_round24',
  104: '0104_cover_letter_limit',
  105: '0105_welcome_codes',
  106: '0106_webhooks_round25',
  107: '0107_partners_section4_round27',
  108: '0108_partners_section4_round28',
  109: '0109_model_stamp',
  110: '0110_webhooks_round27',
  111: '0111_partners_section4_round29',
  112: '0112_partners_section4_round33',
  113: '0113_payout_method_paypal',
  114: '0114_tax_id_sealed',
  115: '0115_partners_section4_round38',
  116: '0116_partners_section4_round39',
  117: '0117_partners_section4_round40',
  118: '0118_database_round6',
  119: '0119_human_demand_test',
  120: '0120_outcome_ask_first_delivery',
  121: '0121_credit_one_per_purchase',
}

module.exports = { LEDGER_NAMES }
