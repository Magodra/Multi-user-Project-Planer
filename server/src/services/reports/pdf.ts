/**
 * Minimal, deterministic PDF writer for text reports (no dependencies, no
 * timestamps in the output). Monospace text on A4 landscape pages.
 */

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 36;
const FONT_SIZE = 8;
const LINE_HEIGHT = 10;
export const PDF_COLUMNS = Math.floor((PAGE_WIDTH - 2 * MARGIN) / (FONT_SIZE * 0.6));
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT);

/** PDF string literal; non-Latin-1 characters are replaced with '?'. */
function pdfString(text: string): string {
  const latin1 = [...text].map((ch) => (ch.charCodeAt(0) <= 0xff ? ch : "?")).join("");
  return `(${latin1.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

export function renderTextPdf(title: string, lines: string[]): Buffer {
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE)
    pages.push(lines.slice(i, i + LINES_PER_PAGE));

  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // returns the 1-based object number
  const catalog = add("");
  const pagesObj = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
  );
  const info = add(`<< /Title ${pdfString(title)} /Producer (Multi-user Project Planner) >>`);
  const pageRefs: number[] = [];
  pages.forEach((pageLines, index) => {
    const text = [
      "BT",
      `/F1 ${FONT_SIZE} Tf`,
      `${LINE_HEIGHT} TL`,
      `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`,
      ...pageLines.map((l) => `${pdfString(l.slice(0, PDF_COLUMNS))} '`),
      "ET",
      "BT",
      `/F1 ${FONT_SIZE} Tf`,
      `${PAGE_WIDTH - MARGIN - 80} ${MARGIN / 2} Td`,
      `${pdfString(`Page ${index + 1} of ${pages.length}`)} Tj`,
      "ET",
    ].join("\n");
    const content = add(
      `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`,
    );
    pageRefs.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
