import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { validateUpload, normalizeUpload } from '../../lib/upload'
import { announce } from '../../lib/announce'
import useFileDropGuard from '../../hooks/useFileDropGuard'

// Resume dropzone.
//
// Pass `value` (the File currently held by the parent) to make it controlled.
// It used to keep its own private copy of the selected file, so when the parent
// unmounted it (switching "Upload" -> "Start from scratch" -> back) the dropzone
// reset to "Drop your resume here" while the parent still held the old file —
// and submitted a resume the user could no longer see.
//
// Other changes: keyboard-operable (it was mouse-only — the real <input> is
// display:none and the dropzone div wasn't focusable); Cancel in the OS picker
// no longer shows a bogus "No file selected" error; a Remove button; empty files
// are rejected; the drag highlight no longer flickers over child elements; and
// the file's MIME type is normalised to match its extension so the API's
// `file.type` check agrees with this component's extension check.
// `prompt` / `typesText` are the visible copy and ARE the spoken name (a role="button" is named from its content);
// `ariaLabel` is OPTIONAL extra spoken context, read as the control's description; the defaults are the resume wording.
//
// SHARED FRONTEND (section 11 re-audit, bug): the dropzone's aria-label used to REPLACE its visible text ("Upload your resume (PDF or
// DOCX)" over a visible "Drop your resume here or browse…", and "Press to replace" over a visible "Click to replace"). A person
// driving the page by voice ("click Drop your resume here") named a control that did not carry that name (WCAG 2.5.3, Label in
// Name; axe: label-content-name-mismatch, serious). There is no aria-label on the zone any more: it is named from what is on screen,
// and any extra context goes in aria-describedby.
// (What is actually accepted is decided by lib/upload.js — PDF and DOCX — and `accept` only filters the picker.)
//
// Not just for resumes: `extensions` (lower-case, no dot; default PDF + DOCX) decides what is accepted AND what the picker
// offers (`accept` is derived from it unless given), and `validate(file)` may return an extra message to refuse a file
// (a size cap that is not `maxMB`, say). Pair it with matching `typesText` / `prompt` / `ariaLabel` copy.
export default function FileUpload({
  onFile, value, extensions = ['pdf', 'docx'], accept, maxMB = 5, disabled = false, validate,
  prompt = 'Drop your resume here', typesText = 'PDF or DOCX', ariaLabel,
  // 'card' is the scan page's look: a plain dashed drop area, and once a file is held, a green chip with Replace / Remove.
  look = 'default',
}) {
  const acceptAttr = accept ?? extensions.map(e => `.${e}`).join(',')
  const descId = useId()
  const inputRef = useRef(null)
  const zoneRef = useRef(null)
  const dragDepth = useRef(0)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState('')
  const [internalFile, setInternalFile] = useState(null)

  // A rejection message describes the last file the person tried; once the parent swaps or clears the
  // file (a form reset, switching modes) it would otherwise linger under a different state.
  useEffect(() => { setError('') }, [value])

  // A file dropped a little OUTSIDE the dropzone would make the browser open it in this tab, replacing the app (hooks/useFileDropGuard).
  useFileDropGuard()

  const wantsFocus = useRef(false)
  const controlled = value !== undefined
  const file = controlled ? value : internalFile

  // The zone is not on the page while a file is held (card look), so focus waits for it to come back.
  useEffect(() => { if (wantsFocus.current && !file) { wantsFocus.current = false; zoneRef.current?.focus() } }, [file])

  function commit(next) {
    if (!controlled) setInternalFile(next)
    onFile?.(next)
  }

  function handle(fileList) {
    if (!fileList || fileList.length === 0) return          // picker cancelled — not an error
    if (fileList.length > 1) { setError('Please upload one file at a time.'); return }
    const f = fileList[0]
    const problem = validateUpload(f, maxMB, extensions) || (typeof validate === 'function' ? validate(f) : null)
    if (problem) { setError(problem); return }              // previous selection stays as-is
    setError('')
    const next = normalizeUpload(f)
    commit(next)
    announce(`Selected ${next?.name || f.name}`)   // the visible text swap alone is silent to a screen reader
  }

  function openPicker() {
    if (!disabled) inputRef.current?.click()
  }

  if (look === 'card') {
    const ext = (file?.name || '').split('.').pop().toUpperCase().slice(0, 4)
    const kb = file?.size ? (file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`) : ''
    // Round 27: the held-file chip is a drop target too. Only the empty zone was, so dragging a replacement onto the chip was refused
    // (the drop guard shows "not allowed") while the default look replaces the file when one is dropped on it.
    const dropProps = {
      onDrop: e => { e.preventDefault(); dragDepth.current = 0; setDrag(false); if (!disabled) handle(e.dataTransfer.files) },
      onDragOver: e => { e.preventDefault(); if (disabled && e.dataTransfer) e.dataTransfer.dropEffect = 'none' },
      onDragEnter: e => { e.preventDefault(); if (disabled) return; dragDepth.current++; setDrag(true) },
      onDragLeave: () => { if (disabled) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDrag(false) },
    }
    const hidden = (
      <input ref={inputRef} type="file" accept={acceptAttr} disabled={disabled} className="hidden" tabIndex={-1}
        onChange={e => { handle(e.target.files); e.target.value = '' }} />
    )
    return (
      <div>
        {ariaLabel && <span id={descId} className="sr-only">{ariaLabel}</span>}
        {file ? (
          <div data-testid="file-chip" data-file-dropzone="" {...dropProps}
            className={cn('flex items-center gap-2.5 rounded-xl border-[1.5px] px-3 py-2.5 text-sm transition-colors', drag ? 'border-blue-700 bg-blue-50' : 'border-green-700 bg-green-50')}>
            <span aria-hidden="true" className="grid h-9 w-[30px] shrink-0 place-items-center rounded-[5px] border border-gray-300 bg-white text-[10px] font-extrabold text-blue-700">{ext}</span>
            <span className="min-w-0 flex-1">
              <b className="block truncate text-gray-900">{file.name}</b>
              <small className="text-gray-500">{kb ? `${kb} \u00b7 ready to scan` : 'Ready to scan'}</small>
            </span>
            {!disabled && (
              <>
                <button type="button" onClick={openPicker} className="text-[13px] text-blue-700 underline underline-offset-2">Replace</button>
                <button type="button" onClick={() => { setError(''); wantsFocus.current = true; commit(null); announce('File removed') }} className="text-[13px] text-blue-700 underline underline-offset-2">Remove file</button>
              </>
            )}
            {hidden}
          </div>
        ) : (
          <div
            ref={zoneRef} data-file-dropzone="" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
            aria-describedby={ariaLabel ? descId : undefined}
            onClick={e => { if (e.target === inputRef.current) return; openPicker() }}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openPicker() } }}
            {...dropProps}
            className={cn('rounded-xl border-2 border-dashed px-3.5 py-5 text-center text-sm text-gray-600 transition-colors focus:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-200',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer', drag ? 'border-blue-700 bg-blue-50' : 'border-gray-300 bg-white hover:border-blue-700 hover:bg-blue-50')}
          >
            <b className="mb-0.5 block text-[15px] text-ink">{prompt}, or <span className="text-blue-700">browse</span></b>
            <small className="text-gray-500">{typesText}, max {maxMB}MB</small>
            {hidden}
          </div>
        )}
        {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      {ariaLabel && <span id={descId} className="sr-only">{ariaLabel}</span>}
      <div
        ref={zoneRef}
        data-file-dropzone=""
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-describedby={ariaLabel ? descId : undefined}
        // input.click() bubbles back up to this div; ignore it rather than lean on the
        // browser's re-entrancy guard to stop a second picker request.
        onClick={e => { if (e.target === inputRef.current) return; openPicker() }}
        onKeyDown={e => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openPicker() }
        }}
        onDrop={e => {
          e.preventDefault(); dragDepth.current = 0; setDrag(false)
          if (!disabled) handle(e.dataTransfer.files)
        }}
        onDragOver={e => {
          e.preventDefault()
          // A disabled zone must not advertise itself as a drop target (the drop is ignored).
          if (disabled && e.dataTransfer) e.dataTransfer.dropEffect = 'none'
        }}
        // BUG FIX (audit): these two previously ignored `disabled`, so
        // dragging a file over a disabled dropzone still lit it up blue as
        // if it were droppable — onDrop already correctly no-ops when
        // disabled, but nothing told the drag-enter/leave handlers not to
        // bother tracking depth or flipping the highlight in the first place.
        onDragEnter={e => { e.preventDefault(); if (disabled) return; dragDepth.current++; setDrag(true) }}
        onDragLeave={() => {
          if (disabled) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDrag(false)
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed',
          'p-8 transition-colors text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          drag
            ? 'border-blue-400 bg-blue-50'
            : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
        )}
      >
        <svg className="h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
        </svg>
        {file ? (
          <div>
            <p className="text-sm font-medium text-green-700 break-all">{file.name}</p>
            <p className="text-xs text-gray-500 mt-1">Click to replace</p>
          </div>
        ) : (
          <div>
            <p className="text-sm font-medium text-gray-700">
              {prompt} or <span className="text-blue-600">browse</span>
            </p>
            <p className="text-xs text-gray-500 mt-1">{typesText}, max {maxMB}MB</p>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={acceptAttr}
          disabled={disabled}
          className="hidden"
          tabIndex={-1}
          onChange={e => {
            handle(e.target.files)
            e.target.value = ''       // so choosing the SAME file again still fires onChange
          }}
        />
      </div>
      {file && !disabled && (
        <button
          type="button"
          onClick={() => {
            setError(''); commit(null)
            announce('File removed')
            // This button unmounts with the file; without a destination focus would fall to <body>.
            zoneRef.current?.focus()
          }}
          className="mt-1 text-xs text-gray-500 hover:text-red-600 underline"
        >
          Remove file
        </button>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
