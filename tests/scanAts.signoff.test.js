import { describe, it, expect } from 'vitest'
const { applyLetterFrame } = require('../src/services/claude.service.js')

describe('applyLetterFrame sign-off replacement', () => {
  const frame = t => applyLetterFrame(t, { recipient: '', name: 'Jane Doe', uk: false })
  it('replaces a sign-off followed by the name', () => {
    expect(frame('Dear X,\n\nBody.\n\nSincerely,\nJane Doe')).toBe('Dear Hiring Manager,\n\nBody.\n\nSincerely,\nJane Doe')
  })
  it('replaces a sign-off followed by a name AND extra lines instead of appending a second one', () => {
    const out = frame('Dear X,\n\nBody.\n\nBest regards,\nJane Doe\nSenior Analyst\njane@x.com')
    expect(out).toBe('Dear Hiring Manager,\n\nBody.\n\nSincerely,\nJane Doe')
  })
  it('appends one when the model wrote none', () => {
    expect(frame('Dear X,\n\nBody.')).toBe('Dear Hiring Manager,\n\nBody.\n\nSincerely,\nJane Doe')
  })
})
