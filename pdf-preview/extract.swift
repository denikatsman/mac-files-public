import Foundation
import PDFKit

// PDF bytes arrive over stdin. This helper never opens or writes a file path.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty && input.count <= 32 * 1024 * 1024 else { fail("PDF input is empty or exceeds the preview limit") }
guard CommandLine.arguments.count == 5,
      let startPage = Int(CommandLine.arguments[1]), startPage > 0,
      let startOffset = Int(CommandLine.arguments[2]), startOffset >= 0,
      let maxPages = Int(CommandLine.arguments[3]), (1...8).contains(maxPages),
      let maxChars = Int(CommandLine.arguments[4]), (1...65536).contains(maxChars) else { fail("Invalid extraction parameters") }
guard let document = PDFDocument(data: input) else { fail("Not a valid PDF") }
guard !document.isLocked else { fail("PDF is locked") }
guard startPage <= document.pageCount else { fail("Page is out of range") }

var currentPage = startPage
var offset = startOffset
var remaining = maxChars
var pagesRead = 0
var pageResults: [[String: Any]] = []
while currentPage <= document.pageCount && pagesRead < maxPages && remaining > 0 {
    guard let page = document.page(at: currentPage - 1) else { fail("Could not read PDF page") }
    let pageText = page.string ?? ""
    let length = pageText.count
    guard offset <= length else { fail("Character offset is out of range") }
    let start = pageText.index(pageText.startIndex, offsetBy: offset)
    let take = min(remaining, length - offset)
    let end = pageText.index(start, offsetBy: take)
    pageResults.append(["page": currentPage, "text": String(pageText[start..<end])])
    pagesRead += 1
    remaining -= take
    if offset + take < length {
        offset += take
        break
    }
    currentPage += 1
    offset = 0
}
let hasMore = currentPage <= document.pageCount
let output: [String: Any] = [
    "page_count": document.pageCount, "pages": pageResults, "has_more": hasMore,
    "next_page": hasMore ? currentPage as Any : NSNull(),
    "next_char_offset": hasMore ? offset as Any : NSNull()
]
guard let data = try? JSONSerialization.data(withJSONObject: output) else { fail("Could not encode PDF text") }
FileHandle.standardOutput.write(data)
