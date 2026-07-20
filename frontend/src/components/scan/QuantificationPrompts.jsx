// Phase 3 — static suggestions only, no regeneration loop in v1. Claude's
// rewriteResumeContent flags bullets that describe an outcome or improvement
// where a number would strengthen the line, but where the user didn't
// provide one — rather than inventing a metric (which the prompt explicitly
// forbids), it surfaces the gap here for the user to fill in themselves,
// manually, outside the app for now. A v1.1 version of this feature would
// let the user type a number in and regenerate the affected bullet; that's
// deliberately out of scope for this pass.
//
// Renders nothing if there are no prompts — this is the common case for
// well-quantified resumes, and for badge-only purchases (which never run
// the AI rewrite, so quantificationPrompts is always empty/null there).

export default function QuantificationPrompts({ prompts }) {
  if (!prompts || prompts.length === 0) return null

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <p className="text-sm font-semibold text-gray-900 mb-1">Strengthen these lines</p>
      <p className="text-xs text-gray-500 mb-4">
        These bullets could be more persuasive with a specific number — we won't invent one,
        but if you have it, add it yourself before applying.
      </p>
      <ul className="flex flex-col gap-3">
        {prompts.map((p, i) => (
          <li key={i} className="border-l-2 border-amber-200 pl-3">
            <p className="text-sm text-gray-800">{p.bullet}</p>
            <p className="text-xs text-amber-700 mt-0.5">{p.suggestion}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
