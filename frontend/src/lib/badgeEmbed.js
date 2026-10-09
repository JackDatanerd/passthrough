// The embed snippets for a verification badge (ScanResult.jsx shows them).
//
// ROUND-6 (feature gap, Section 7): only Markdown (with the SVG) was offered. Gmail, classic Outlook,
// LinkedIn and most ATS profile fields do not display an SVG image, so a candidate could not put the
// badge in an e-mail signature at all. The PNG variant works everywhere; the HTML snippet wraps it in
// a link to the live page, sized to the badge's 20px height. The Markdown keeps the sharper SVG.
//
// `root` is the absolute API base (no trailing slash), `code` the verification code, `pageUrl` the
// public page the badge links to. Every interpolated value is escaped for the context it lands in.
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function buildBadgeEmbeds(root, code, pageUrl) {
  const base = `${String(root).replace(/\/+$/, '')}/verify/${encodeURIComponent(code)}`
  const svg = `${base}/badge.svg`
  const png = `${base}/badge.png`
  return {
    image: svg,
    png,
    markdown: `[![Passthrough badge](${svg})](${pageUrl})`,
    html: `<a href="${escAttr(pageUrl)}"><img src="${escAttr(png)}" alt="Passthrough badge" height="20" style="border:0"></a>`,
  }
}
