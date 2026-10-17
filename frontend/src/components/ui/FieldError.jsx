// The red message under a form control. Input, Select, Textarea and Checkbox each hand-wrote this <p>, as did about 75 other places
// (pages and forms) — with the live-region role added or forgotten case by case. `role="alert"` makes the message spoken the moment
// it appears; `id` is what the control's aria-describedby points at. Renders nothing for an empty message.
//
//   <FieldError id={`${inputId}-error`}>{error}</FieldError>
export default function FieldError({ id, children, className = 'text-xs text-red-600' }) {
  if (children === null || children === undefined || children === false || children === '') return null
  return <p id={id} role="alert" className={className}>{children}</p>
}
