const PALETTES = [
  { id:'clinical',   bg:'#FAFBFC', primary:'#1E40AF', accent:'#E2E8F0', text:'#1F2937' },
  { id:'obsidian',   bg:'#0F172A', primary:'#38BDF8', accent:'#1E293B', text:'#F1F5F9' },
  { id:'forest',     bg:'#F0FDF4', primary:'#166534', accent:'#DCFCE7', text:'#14532D' },
  { id:'terracotta', bg:'#FFF7ED', primary:'#9A3412', accent:'#FED7AA', text:'#431407' },
  { id:'slate',      bg:'#F8FAFC', primary:'#475569', accent:'#E2E8F0', text:'#0F172A' },
  { id:'plum',       bg:'#FAF5FF', primary:'#7C3AED', accent:'#EDE9FE', text:'#2E1065' },
  { id:'gold',       bg:'#FFFBEB', primary:'#B45309', accent:'#FDE68A', text:'#451A03' },
  { id:'rose',       bg:'#FFF1F2', primary:'#BE123C', accent:'#FCE7F3', text:'#4C0519' },
  { id:'teal',       bg:'#F0FDFA', primary:'#0F766E', accent:'#CCFBF1', text:'#134E4A' },
  { id:'midnight',   bg:'#F8F9FF', primary:'#1E1B4B', accent:'#E0E7FF', text:'#1E1B4B' },
  { id:'copper',     bg:'#FDF8F6', primary:'#92400E', accent:'#FDE8D8', text:'#1C0A00' },
  { id:'sage',       bg:'#F7FAF7', primary:'#2D6A4F', accent:'#D8F3DC', text:'#1B4332' },
  { id:'navy',       bg:'#F0F4FF', primary:'#1D3461', accent:'#D6E4FF', text:'#0D1B2A' },
  { id:'graphite',   bg:'#FAFAFA', primary:'#374151', accent:'#F3F4F6', text:'#111827' },
  { id:'wine',       bg:'#FDF2F8', primary:'#831843', accent:'#FCE7F3', text:'#500724' },
  { id:'ocean',      bg:'#F0F9FF', primary:'#0369A1', accent:'#BAE6FD', text:'#0C4A6E' },
  { id:'amber',      bg:'#FFFBF0', primary:'#B45309', accent:'#FEF3C7', text:'#451A03' },
  { id:'charcoal',   bg:'#F9FAFB', primary:'#111827', accent:'#E5E7EB', text:'#111827' },
  { id:'violet',     bg:'#F5F3FF', primary:'#5B21B6', accent:'#EDE9FE', text:'#2E1065' },
  { id:'coral',      bg:'#FFF5F5', primary:'#C53030', accent:'#FED7D7', text:'#63171B' },
]

const FONTS = [
  { id:'classic',   heading:'Merriweather',        body:'Source+Sans+3',     hPt:24, bPt:10.5 },
  { id:'modern',    heading:'Playfair+Display',     body:'Inter',             hPt:22, bPt:10   },
  { id:'clean',     heading:'Raleway',              body:'Open+Sans',         hPt:23, bPt:10.5 },
  { id:'editorial', heading:'Libre+Baskerville',    body:'Lato',              hPt:22, bPt:10   },
  { id:'tech',      heading:'Space+Grotesk',        body:'DM+Sans',           hPt:23, bPt:10   },
  { id:'refined',   heading:'Cormorant+Garamond',   body:'Nunito',            hPt:26, bPt:10.5 },
  { id:'precise',   heading:'Josefin+Sans',         body:'Mulish',            hPt:22, bPt:10   },
  { id:'warm',      heading:'Crimson+Text',         body:'Source+Sans+3',     hPt:25, bPt:11   },
]

const INDUSTRY = {
  healthcare: ['clinical','slate','teal','ocean','midnight'],
  legal:      ['slate','gold','obsidian','midnight','charcoal'],
  finance:    ['slate','navy','obsidian','midnight','graphite'],
}

function djb2(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i) | 0
  return Math.abs(h)
}

function getDesignTokens(userId, scanId, industry = 'default') {
  const seed     = djb2((userId || 'anon') + scanId)
  const allowed  = INDUSTRY[industry] || null
  const filtered = allowed ? PALETTES.filter(p => allowed.includes(p.id)) : PALETTES
  return {
    palette: filtered[seed % filtered.length],
    fonts:   FONTS[seed % FONTS.length]
  }
}

module.exports = { getDesignTokens }
