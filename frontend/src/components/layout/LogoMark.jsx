// The Passthrough mark: a filter (two bars, each with a gap) and the arrow that passes through it.
// Inline SVG, so it inherits no font and costs no request. Decorative: the wordmark next to it carries the name.
// Keep in sync with public/favicon.svg (the favicon set is the same drawing, with heavier strokes for 16px).
export default function LogoMark({ className = 'w-[30px] h-[30px]' }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <rect width="32" height="32" rx="8" fill="#1E40AF" />
      <path d="M11 6.5v6M11 19.5v6M21 6.5v6M21 19.5v6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M4.5 16h22.5m-5.5-5.5 5.5 5.5-5.5 5.5" stroke="#FFE27A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
