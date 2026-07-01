import { useRef, useState } from 'react'
import { cn } from '../../lib/utils'

export default function FileUpload({ onFile, accept = '.pdf,.docx', maxMB = 5 }) {
  const inputRef   = useRef(null)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState('')
  const [file,  setFile ] = useState(null)

  function validate(f) {
    if (!f) return 'No file selected.'
    const ext = f.name.split('.').pop().toLowerCase()
    if (!['pdf','docx'].includes(ext)) return 'Only PDF and DOCX files accepted.'
    if (f.size > maxMB * 1024 * 1024) return `File too large. Max ${maxMB}MB.`
    return null
  }

  function handle(f) {
    const err = validate(f)
    if (err) { setError(err); return }
    setError('')
    setFile(f)
    onFile(f)
  }

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]) }}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed',
          'cursor-pointer p-8 transition-colors text-center',
          drag
            ? 'border-blue-400 bg-blue-50'
            : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
        )}
      >
        <svg className="h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
        </svg>
        {file ? (
          <div>
            <p className="text-sm font-medium text-green-700">{file.name}</p>
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
          className="hidden"
          onChange={e => handle(e.target.files[0])}
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
