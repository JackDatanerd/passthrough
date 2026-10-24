import { useId } from 'react'
import Fieldset from './Fieldset'
import Radio from './Radio'

// A group of radios as one control: <Fieldset> + legend, one shared `name`, and the checked state derived from `value`.
//
//   <RadioGroup legend="Which version to save" srOnlyLegend value={version} onChange={setVersion} size="sm"
//     options={[{ value: 'original', label: 'Your resume as it was' }, { value: 'delivered', label: 'The fixed version' }]} />
// `onChange(value)` gets the chosen option's value. An option may carry `description` and `disabled`. `className` lays the radios out
// (default: a column).
export default function RadioGroup({
  legend, srOnlyLegend, legendClassName, hint, error, name, value, onChange, options = [], size = 'md', disabled = false, className = 'flex flex-col gap-2',
  // Optional: classes for each option's row, as a string or (option, checked) => string (the scan page draws its choices as cards).
  optionClassName,
}) {
  const autoName = useId()
  const groupName = name || autoName
  return (
    <Fieldset legend={legend} srOnlyLegend={srOnlyLegend} legendClassName={legendClassName} hint={hint} error={error} className={className}>
      {options.map(o => (
        <Radio
          key={String(o.value)} size={size} label={o.label} description={o.description}
          name={groupName} value={String(o.value)} checked={value === o.value}
          wrapperClassName={typeof optionClassName === 'function' ? optionClassName(o, value === o.value) : optionClassName}
          // A group held while a save runs keeps focus (aria-disabled, change swallowed) instead of the native attribute, which drops a keyboard user onto <body>.
          disabled={!!o.disabled} aria-disabled={disabled && !o.disabled ? true : undefined}
          onChange={() => { if (!disabled) onChange?.(o.value) }}
        />
      ))}
    </Fieldset>
  )
}
