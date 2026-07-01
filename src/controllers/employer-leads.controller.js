const { z }  = require('zod')
const { getSupabase } = require('../config/supabase')

const schema = z.object({
  name:         z.string().min(1).max(100),
  company:      z.string().min(1).max(200),
  email:        z.string().email(),
  roleCategory: z.string().max(100).optional()
})

async function createLead(c) {
  const body = await c.req.json()
  const data = schema.parse(body)
  const supabase = getSupabase(c.env)
  const { error } = await supabase.from('employer_leads').insert({
    name:          data.name,
    company:       data.company,
    email:         data.email,
    role_category: data.roleCategory || null,
    source:        'verification_page'
  })
  if (error) throw error
  return c.json({ success: true, message: "We'll be in touch." })
}

module.exports = { createLead }
