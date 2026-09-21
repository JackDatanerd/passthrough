// Real <form> wrapper. The app had no <form> elements at all — every submit
// button was a plain onClick — which meant: pressing Enter in a field did
// nothing, mobile keyboards' "Go" key did nothing, native type="email"
// validation never ran, and password managers (which key off a form) offered
// to save nothing.
//
// Use with a `type="submit"` Button and NO onClick on that button, otherwise
// the handler runs twice. `noValidate` keeps the pages' own error messages in
// charge rather than switching on the browser's.
export default function Form({ onSubmit, children, className, ...props }) {
  return (
    <form
      noValidate
      className={className}
      onSubmit={e => { e.preventDefault(); onSubmit?.(e) }}
      {...props}
    >
      {children}
    </form>
  )
}
