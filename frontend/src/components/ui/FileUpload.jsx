import { useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { validateUpload, normalizeUpload } from '../../lib/upload'

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
export default function FileUpload({ onFile, value, accept = '.pdf,.docx', maxMB = 5, disabled = false }) {
  const inputRef = useRef(null)
  const dragDepth = useRef(0)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState('')
  const [internalFile, setInternalFile] = useState(null)

  const controlled = value !== undefined
  const file = controlled ? value : internalFile

  function commit(next) {
    if (!controlled) setInternalFile(next)
    onFile?.(next)
  }

  function handle(fileList) {
    if (!fileList || fileList.length === 0) return          // picker cancelled — not an error
    if (fileList.length > 1) { setError('Please upload one file at a time.'); return }
    const f = fileList[0]
    const problem = validateUpload(f, maxMB)
    if (problem) { setError(problem); return }              // previous selection stays as-is
    setError('')
    commit(normalizeUpload(f))
  }

  function openPicker() {
    if (!disabled) inputRef.current?.click()
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-label={file ? `Selected file ${file.name}. Press to replace.` : 'Upload your resume (PDF or DOCX)'}
        onClick={openPicker}
        onKeyDown={e => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openPicker() }
        }}
        onDrop={e => {
          e.preventDefault(); dragDepth.current = 0; setDrag(false)
          if (!disabled) handle(e.dataTransfer.files)
        }}
        onDragOver={e => e.preventDefault()}
        onDragEnter={e => { e.preventDefault(); dragDepth.current++; setDrag(true) }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDrag(false) }}
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
              Drop your resume here or <span className="text-blue-600">browse</span>
            </p>
            <p className="text-xs text-gray-500 mt-1">PDF or DOCX, max {maxMB}MB</p>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
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
          onClick={() => { setError(''); commit(null) }}
          className="mt-1 text-xs text-gray-500 hover:text-red-600 underline"
        >
          Remove file
        </button>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
