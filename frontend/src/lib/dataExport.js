// Helpers for the account data export (GET /api/profile/export), which the
// server splits into parts of a few hundred scans each so one response never has
// to hold a huge account at once. Pure so the rules can be tested.

// Part 1 keeps the historical name; later parts are numbered.
export const exportFileName = (part) => `passthrough-my-data${part > 1 ? `-part-${part}` : ''}.json`

// How many parts the account's export has. The server says so in the
// X-Export-Parts header (exposed to the browser via CORS) and inside the file
// (`export.parts`); the file is the fallback if a proxy or a CORS setting hides
// the header, so a large account can never be left thinking it has everything.
// Anything unreadable is 1.
export async function exportPartsFrom(res) {
  const header = Number(res?.headers?.['x-export-parts'])
  if (Number.isInteger(header) && header >= 1) return header
  try {
    const parsed = JSON.parse(await res.data.text())
    const parts = Number(parsed?.export?.parts)
    return Number.isInteger(parts) && parts >= 1 ? parts : 1
  } catch (_) {
    return 1
  }
}
