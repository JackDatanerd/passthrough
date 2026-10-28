// The Passthrough tile as a verification mark: the logo's tile with a gold check (verified) or a grey tile with no check (anything else).
// One drawing in every place a credential shows: the resume PDF's hallmark, the badge, the share card and this page. The check is drawn
// ONLY when `verified` is true, so the mark can never say more than the page's headline. Under ~28px it uses the compact cut.
// Keep the geometry in sync with src/services/pdfSignature.service.js (TILE_BARS / TILE_CHECK) and src/lib/badgePng.js (tileCoverage).
export default function VerifiedMark({ verified = false, size = 64, className = '' }) {
  const full = size >= 40
  const bars = full ? 'M11 6.5v6M11 19.5v6M21 6.5v6M21 19.5v6' : 'M9.5 6.5v4M9.5 21.5v4M22.5 6.5v4M22.5 21.5v4'
  const check = full ? 'M4.5 16h7.4l3.9 4.4L26.2 9.8' : 'M7.5 16.4l5.8 5.6L25 10.6'
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <rect width="32" height="32" rx="8" fill={verified ? '#1E40AF' : '#6B7280'} />
      <path d={bars} stroke={verified ? '#FFFFFF' : '#D1D5DB'} strokeWidth={full ? 2.6 : 3} strokeLinecap="round" fill="none" />
      {verified && <path d={check} stroke="#FFE27A" strokeWidth={full ? 2.7 : 3.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />}
    </svg>
  )
}
