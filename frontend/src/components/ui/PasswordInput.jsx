import { forwardRef, useState } from 'react'
import Input from './Input'
import { cn } from '../../lib/utils'

// A password field with a Show/Hide toggle. Typing a 72-byte-limited password twice
// (new + confirm) on a phone keyboard is where most failed sign-ups and lockouts
// start; being able to look at what was typed removes the guesswork.
const PasswordInput = forwardRef(function PasswordInput({ className, ...props }, ref) {
  const [shown, setShown] = useState(false)
  return (
    <Input
      ref={ref}
      {...props}
      type={shown ? 'text' : 'password'}
      // Only matters while the text is visible: stop the keyboard "fixing" it.
      {...(shown ? { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } : {})}
      className={cn('pr-16', className)}
      endAdornment={
        <button
          type="button"
          onClick={() => setShown(s => !s)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-gray-500 hover:text-gray-800 rounded-r-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      }
    />
  )
})

export default PasswordInput
