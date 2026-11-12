//
//  DocxExtractor.swift
//  .docx 纯文本提取（零第三方依赖）
//
//  原理：docx = zip 包（deflate），取 word/document.xml，
//  按 </w:p> 切段落、<w:t> 抓文本。iOS 自带 Compression 框架即可解 raw deflate。
//  不支持：.doc 老二进制格式、加密文档、zip64。
//

import Foundation
import Compression

enum DocxExtractor {

    enum Err: Error, LocalizedError {
        case badZip, notFound, unsupported, inflateFailed, tooLarge

        var errorDescription: String? {
            switch self {
            case .badZip: return "无法读取该 Word 文件（不是有效的 .docx）"
            case .notFound: return "该文档缺少正文数据（word/document.xml）"
            case .unsupported: return "该文档使用了不支持的压缩或加密方式，请另存为普通 .docx"
            case .inflateFailed: return "文档数据解压失败"
            case .tooLarge: return "文档过大，无法解析"
            }
        }
    }

    private static let maxRawBytes = 24 * 1024 * 1024   // 解压后正文上限 24MB（防炸弹）

    /// 提取纯文本（段落按行分隔）
    static func extractText(from data: Data) throws -> String {
        let xmlData = try unzipEntry(data, path: "word/document.xml")
        guard let xml = String(data: xmlData, encoding: .utf8) ?? String(data: xmlData, encoding: .isoLatin1) else {
            throw Err.badZip
        }
        return plainText(fromXML: xml)
    }

    // MARK: - zip 解包（EOCD → 中央目录 → 定位条目 → 解压）

    static func unzipEntry(_ data: Data, path: String) throws -> Data {
        guard data.count > 22 else { throw Err.badZip }

        func u16(_ o: Int) -> Int { Int(data[o]) | (Int(data[o + 1]) << 8) }
        func u32(_ o: Int) -> Int { u16(o) | (u16(o + 2) << 16) }

        // 从尾部找 EOCD 签名 0x06054b50（含注释最多回溯 64KB+22）
        var eocd = -1
        let lower = max(0, data.count - 22 - 65_536)
        var i = data.count - 22
        while i >= lower {
            if data[i] == 0x50, data[i + 1] == 0x4b, data[i + 2] == 0x05, data[i + 3] == 0x06 {
                eocd = i
                break
            }
            i -= 1
        }
        guard eocd >= 0 else { throw Err.badZip }

        let entryCount = u16(eocd + 10)
        var cd = u32(eocd + 16)
        for _ in 0..<max(entryCount, 1) {
            guard cd + 46 <= data.count, u32(cd) == 0x02014b50 else { throw Err.badZip }
            let method = u16(cd + 10)
            let compSize = u32(cd + 20)
            let uncompSize = u32(cd + 24)
            let nameLen = u16(cd + 28)
            let extraLen = u16(cd + 30)
            let commentLen = u16(cd + 32)
            let localOffset = u32(cd + 42)
            let nameStart = cd + 46
            guard nameStart + nameLen <= data.count else { throw Err.badZip }
            let name = String(data: data.subdata(in: nameStart..<(nameStart + nameLen)), encoding: .utf8) ?? ""

            if name == path {
                // zip64 / 加密不支持（普通 docx 不会遇到）
                guard compSize != 0xFFFFFFFF, uncompSize != 0xFFFFFFFF, localOffset != 0xFFFFFFFF else { throw Err.unsupported }
                guard uncompSize <= maxRawBytes else { throw Err.tooLarge }
                guard localOffset + 30 <= data.count, u32(localOffset) == 0x04034b50 else { throw Err.badZip }
                let lNameLen = u16(localOffset + 26)
                let lExtraLen = u16(localOffset + 28)
                let dataStart = localOffset + 30 + lNameLen + lExtraLen
                guard dataStart + compSize <= data.count else { throw Err.badZip }
                let comp = data.subdata(in: dataStart..<(dataStart + compSize))
                switch method {
                case 0: return comp                       // stored
                case 8: return try inflate(comp, expectedSize: uncompSize)  // deflate
                default: throw Err.unsupported
                }
            }
            cd += 46 + nameLen + extraLen + commentLen
        }
        throw Err.notFound
    }

    /// raw deflate 解压（Apple 的 COMPRESSION_ZLIB 即无 zlib 头的 deflate）
    static func inflate(_ comp: Data, expectedSize: Int) throws -> Data {
        let cap = expectedSize > 0 ? expectedSize : max(comp.count * 8, 1 << 16)
        guard cap <= maxRawBytes else { throw Err.tooLarge }
        var dst = [UInt8](repeating: 0, count: cap)
        let written: Int = dst.withUnsafeMutableBufferPointer { db -> Int in
            comp.withUnsafeBytes { sb -> Int in
                guard let sp = sb.baseAddress?.assumingMemoryBound(to: UInt8.self),
                      let dp = db.baseAddress else { return 0 }
                return compression_decode_buffer(dp, cap, sp, comp.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written > 0 else { throw Err.inflateFailed }
        return Data(dst[0..<written])
    }

    // MARK: - OOXML → 纯文本

    /// 按 </w:p> 切段；段内用 <w:t> 抓文本；<w:tab/> 转空格、<w:br/> 转换行
    static func plainText(fromXML xml: String) -> String {
        var s = xml
            .replacingOccurrences(of: "<w:tab/>", with: " ")
            .replacingOccurrences(of: "<w:br/>", with: "\n")
        // 去掉段内非 w:t 的富文本标签干扰（如 w:instrText 域代码）
        s = s.replacingOccurrences(of: "<w:instrText", with: "<w:disabled")
        let regex = try! NSRegularExpression(pattern: "<w:t(?:\\s[^>]*)?>(.*?)</w:t>",
                                             options: [.dotMatchesLineSeparators])
        var lines: [String] = []
        for para in s.components(separatedBy: "</w:p>") {
            let ns = para as NSString
            let matches = regex.matches(in: para, options: [],
                                        range: NSRange(location: 0, length: ns.length))
            guard !matches.isEmpty else { continue }
            let text = matches.map { decodeEntities(ns.substring(with: $0.range(at: 1))) }.joined()
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { lines.append(trimmed) }
        }
        return lines.joined(separator: "\n")
    }

    static func decodeEntities(_ s: String) -> String {
        s.replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}
