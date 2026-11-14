import { FileText, Paperclip, X } from 'lucide-react';
import { MAX_PDF_BYTES } from '../utils/pdfAttachment';

interface PdfAttachmentFieldProps {
  file: File | null;
  error: string;
  disabled?: boolean;
  onChange: (file: File | null, error: string) => void;
}

export function PdfAttachmentField({ file, error, disabled = false, onChange }: PdfAttachmentFieldProps) {
  const handleFile = (next: File | undefined) => {
    if (!next) return;
    if (!next.name.toLowerCase().endsWith('.pdf')) {
      onChange(null, 'Choose a PDF file.');
    } else if (next.size > MAX_PDF_BYTES) {
      onChange(null, 'PDFs must be 3 MB or smaller.');
    } else {
      onChange(next, '');
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        {file ? (
          <>
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#0B1220] px-2 py-1 text-[11px] text-[#cbd5e1]">
              <FileText className="h-3.5 w-3.5 shrink-0 text-[#60A5FA]" aria-hidden="true" />
              <span className="max-w-48 truncate">{file.name}</span>
            </span>
            <button type="button" onClick={() => onChange(null, '')} disabled={disabled} aria-label="Remove attached PDF" className="rounded p-1 text-[#94A3B8] hover:text-white disabled:opacity-50">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </>
        ) : (
          <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#F8FAFC] ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Attach PDF</span>
            <input type="file" accept="application/pdf,.pdf" disabled={disabled} className="sr-only" onChange={(event) => handleFile(event.target.files?.[0])} />
          </label>
        )}
        <span className="text-[10px] text-[#64748B]">Up to 3 MB Ã‚Â· processed by your configured AI provider; avoid confidential files</span>
      </div>
      {error && <p role="alert" className="px-2 text-[11px] text-[#FCA5A5]">{error}</p>}
    </div>
  );
}
