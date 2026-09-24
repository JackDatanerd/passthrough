// Replaces crypto.randomInt with Web Crypto (lib/crypto.js), Prisma uniqueness
// check with a Supabase select, fs.readFileSync+createHash with hashBytes
// (caller passes the bytes already read from R2 — there's no file to read
// from disk anymore), and process.env.FRONTEND_URL with an explicit env param.

const c       = require('../config/constants')
const cryptoLib = require('../lib/crypto')

async function generateShortCode(supabase) {
  for (let i = 0; i < 10; i++) {
    const code = cryptoLib.randomShortCode(c.VERIFY_CODE_LENGTH, c.SHORT_CODE_CHARS)
    const { data, error } = await supabase
      .from('scans')
      .select('id')
      .eq('verification_code', code)
      .maybeSingle()
    if (error) throw new Error(`generateShortCode lookup failed: ${error.message}`)
    if (!data) return code
  }
  throw new Error('Could not generate unique short code')
}

// Replaces hashFile(filePath) — caller now passes the bytes directly
// (already in memory from generating the DOCX, no R2 round-trip needed).
async function hashBytes(bytes) {
  return cryptoLib.sha256Bytes(bytes)
}

function buildVerificationUrl(env, code) {
  return `${env.FRONTEND_URL}/v/${code}`
}

module.exports = { generateShortCode, hashBytes, buildVerificationUrl }
