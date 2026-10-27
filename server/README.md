# Server details

The server exposes a read-only MCP file browser over stdio or a loopback-only Streamable HTTP development endpoint. See the [project README](../README.md) for setup, privacy, and security guidance.

`open_browser` supplies the MCP Apps interface. `browse_directory`, `file_info`, `read_file`, `search_files`, and `read_pdf_text` can also be used without it. The `read_file_chunk` and `read_pdf_page` tools are app-only and return bytes in tool metadata.

Text reads are paginated at UTF-8 character boundaries. Continue using `next_offset` and `expected_version`. Filename and content searches are bounded and resumable: repeat the same arguments with `next_cursor`. Cursors expire after five minutes of inactivity. Results include counters for unreadable entries, skipped symbolic links, and binary or non-UTF-8 files; general search does not extract text from PDFs or Office files.

File transfers return at most 256 KiB per chunk and use a version token to detect changes between chunks. The interface assembles files up to 32 MiB in memory. Host support determines whether the resulting file can be saved.

PDF page rendering and selectable-text extraction use macOS PDFKit through the sibling `pdf-preview` helper. PDF snapshots are limited to 32 MiB, and a shared limit admits two concurrent PDF requests. PDFKit's expanded internal memory is not capped by the snapshot size limit. Scanned PDFs are not OCRed.
