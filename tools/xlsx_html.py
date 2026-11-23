"""把 Excel 文件的每个工作表转成 HTML 表格（网页预览用）。用法：python xlsx_html.py 文件.xlsx"""
import html
import os
import sys
import zipfile

import openpyxl

MAX_ROWS, MAX_COLS = 500, 40
MAX_SHEETS, MAX_CELL_CHARS, MAX_HTML_CHARS = 20, 2000, 2_000_000


def main():
    # XLSX is a ZIP archive. Bound expansion before openpyxl loads shared strings
    # and metadata; a small compressed file can otherwise exhaust the host.
    if os.path.getsize(sys.argv[1]) > 64 * 1024 * 1024:
        raise ValueError('工作簿过大，请下载后查看')
    with zipfile.ZipFile(sys.argv[1]) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(e.file_size for e in entries) > 128 * 1024 * 1024:
            raise ValueError('工作簿解压后过大，请下载后查看')
    wb = openpyxl.load_workbook(sys.argv[1], data_only=True, read_only=True)
    out = []
    chars = 0
    for ws in wb.worksheets[:MAX_SHEETS]:
        out.append(f'<h3>{html.escape(ws.title)}</h3><div class="xwrap"><table class="xl">')
        rows = min(MAX_ROWS + 1, ws.max_row or MAX_ROWS + 1)
        cols = min(MAX_COLS, ws.max_column or MAX_COLS)
        for r, row in enumerate(ws.iter_rows(max_row=rows, max_col=cols, values_only=True)):
            if r >= MAX_ROWS:
                out.append(f'<tr><td colspan="{MAX_COLS}">…（只显示前 {MAX_ROWS} 行，完整内容请下载）</td></tr>')
                break
            cells = ['' if v is None else (f'{v:g}' if isinstance(v, float) else str(v))[:MAX_CELL_CHARS] for v in row[:MAX_COLS]]
            while cells and cells[-1] == '':
                cells.pop()
            tag = 'th' if r == 0 else 'td'
            rendered = '<tr>' + ''.join(f'<{tag}>{html.escape(c)}</{tag}>' for c in cells) + '</tr>'
            chars += len(rendered)
            if chars > MAX_HTML_CHARS:
                out.append('<tr><td>预览已截断，完整内容请下载。</td></tr>')
                break
            out.append(rendered)
        out.append('</table></div>')
        if chars > MAX_HTML_CHARS:
            break
    if len(wb.worksheets) > MAX_SHEETS:
        out.append(f'<p>只预览前 {MAX_SHEETS} 个工作表，完整内容请下载。</p>')
    wb.close()
    sys.stdout.reconfigure(encoding='utf-8')
    print(''.join(out))


if __name__ == '__main__':
    main()
