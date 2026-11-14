import type { PdfAttachmentPayload } from '../types/assistant';

export const MAX_PDF_BYTES = 5 * 1024 * 1024;

export async function readPdfAttachment(file: File): Promise<PdfAttachmentPayload> {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose a PDF file.');
  }
  if (file.size === 0 || file.size > MAX_PDF_BYTES) {
    throw new Error('PDFs must be between 1 byte and 5 MB.');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that PDF.'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read that PDF.'));
    reader.readAsDataURL(file);
  });
  const data = dataUrl.split(',')[1];
  if (!data || !data.startsWith('JVBERi')) {
    throw new Error('That file does not appear to be a valid PDF.');
  }

  return { name: file.name.slice(0, 160), mimeType: 'application/pdf', data };
}
