import Foundation
import PDFKit
import AppKit

// Receives a bounded PDF snapshot over stdin and emits one PNG page as JSON.
// Neither the original PDF nor a temporary copy is written by this helper.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty && input.count <= 32 * 1024 * 1024 else { fail("PDF input is empty or exceeds the preview limit") }
guard CommandLine.arguments.count == 3,
      let number = Int(CommandLine.arguments[1]), number > 0,
      let maxPixels = Int(CommandLine.arguments[2]), (64...1600).contains(maxPixels) else { fail("Invalid preview parameters") }
guard let document = PDFDocument(data: input) else { fail("Not a valid PDF") }
guard !document.isLocked else { fail("PDF is locked") }
guard number <= document.pageCount, let page = document.page(at: number - 1) else { fail("Page is out of range") }
let bounds = page.bounds(for: .cropBox)
guard bounds.width.isFinite && bounds.height.isFinite && bounds.width > 0 && bounds.height > 0 else { fail("Invalid page bounds") }
let scale = CGFloat(maxPixels) / max(bounds.width, bounds.height)
let width = max(1, Int((bounds.width * scale).rounded()))
let height = max(1, Int((bounds.height * scale).rounded()))
let image = page.thumbnail(of: NSSize(width: width, height: height), for: .cropBox)
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]),
      png.count <= 4 * 1024 * 1024 else { fail("Could not produce a bounded page preview") }
let response: [String: Any] = ["page": number, "pages": document.pageCount,
    "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh,
    "mime_type": "image/png", "data_base64": png.base64EncodedString()]
guard let output = try? JSONSerialization.data(withJSONObject: response) else { fail("Could not encode preview") }
FileHandle.standardOutput.write(output)
