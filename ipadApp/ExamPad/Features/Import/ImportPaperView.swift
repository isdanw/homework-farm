//
//  ImportPaperView.swift
//  导入 PDF 试卷 → 直接书写作答（无 AI 解析）
//
//  流程（用户拍板 2026-10-25）：选 PDF → 本地渲染页面 → 上传页图 → 入库 →
//  进入「PDFWriteView」在原卷页面上用 Apple Pencil 书写 → 提交后整页视觉阅卷。
//
//  与旧版「上传试卷」的区别（旧版已废弃）：
//  - 不需要 PDF 有文字层——扫描件、拍照导出的 PDF 都能用
//  - 不调用 AI 解析题目，导入过程不联网解析、不依赖 AI 资源包
//  - 题目就是「原卷页面」本身，每页对应一个书写页
//

import SwiftUI
import UIKit
import PDFKit
import UniformTypeIdentifiers

struct ImportPaperView: View {
    var onSaved: (ExamDetail, [UIImage]) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AppSettings.self) private var settings

    private enum Step { case pick, working }
    @State private var step: Step = .pick
    @State private var workingMsg: String?
    @State private var errorText: String?
    @State private var showPicker = false

    @State private var subject = "math"
    @State private var grade = "一年级"
    @State private var fileName = ""

    private let subjects = [("math", "数学"), ("chinese", "语文"), ("english", "英语")]

    /// 单份 PDF 最多导入的页数（服务端 questions/pageRefs 上限 30，这里保守取 20，
    /// 兼顾上传耗时与阅卷 token 成本）
    private let maxPages = 20

    var body: some View {
        NavigationStack {
            Group {
                if step == .working, let msg = workingMsg {
                    workingView(msg)
                } else {
                    pickView
                }
            }
            .navigationTitle("导入 PDF 试卷")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .alert("导入失败", isPresented: .constant(errorText != nil)) {
                Button("好") { errorText = nil }
            } message: {
                Text(errorText ?? "")
            }
            .fileImporter(
                isPresented: $showPicker,
                allowedContentTypes: [.pdf],
                allowsMultipleSelection: false
            ) { result in
                handlePick(result)
            }
        }
    }

    // MARK: - 选择文件

    private var pickView: some View {
        Form {
            Section("试卷信息") {
                Picker("学科", selection: $subject) {
                    ForEach(subjects, id: \.0) { Text($0.1).tag($0.0) }
                }
                TextField("年级（如：一年级）", text: $grade)
            }
            Section {
                Button {
                    showPicker = true
                } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "doc.badge.plus")
                            .font(.title2)
                            .frame(width: 40, height: 40)
                            .background(Color.teal.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("选择 PDF 试卷").font(.headline)
                            Text("选完后直接在卷面上书写作答").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                }
            }
            Section("说明") {
                Label("导入不解析内容，也不需要 PDF 有文字层——扫描件同样可用", systemImage: "checkmark.circle")
                    .font(.footnote).foregroundStyle(.secondary)
                Label("导入后每页变成一张可书写卷面，用 Apple Pencil 直接写答案", systemImage: "pencil.and.scribble")
                    .font(.footnote).foregroundStyle(.secondary)
                Label("提交后按页自动阅卷；无视觉模型时转人工复核", systemImage: "checkmark.seal")
                    .font(.footnote).foregroundStyle(.secondary)
                Label("最多导入 \(maxPages) 页", systemImage: "number")
                    .font(.footnote).foregroundStyle(.tertiary)
            }
        }
    }

    private func workingView(_ msg: String) -> some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text(msg).font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - 流程

    private func handlePick(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let e):
            errorText = "选择文件失败：\(e.localizedDescription)"
        case .success(let urls):
            guard let url = urls.first else { return }
            fileName = url.deletingPathExtension().lastPathComponent
            step = .working
            workingMsg = "读取文件…"
            Task { await process(url) }
        }
    }

    private func process(_ url: URL) async {
        do {
            guard let client = settings.makeClient() else {
                throw APIError(code: "config", message: settings.configIssue ?? "未配置服务")
            }
            let api = ExamAPI(client: client)

            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)

            guard let doc = PDFDocument(data: data) else {
                throw APIError(code: "bad_pdf", message: "无法读取该 PDF 文件（可能已损坏或加密）")
            }
            guard doc.pageCount > 0 else {
                throw APIError(code: "bad_pdf", message: "该 PDF 没有页面")
            }

            // 本地渲染页图（白底 JPEG）并上传云存储 → pageRefs；同时保留本地位图供书写页直接用
            let pageLimit = min(doc.pageCount, maxPages)
            var refs: [String] = []
            var images: [UIImage] = []
            for i in 0..<pageLimit {
                workingMsg = "存档第 \(i + 1) / \(pageLimit) 页…"
                guard let page = doc.page(at: i) else { continue }
                guard let img = Self.pageImage(page) else {
                    throw APIError(code: "render_fail", message: "第 \(i + 1) 页渲染失败，请更换 PDF 或稍后重试")
                }
                guard let data = img.jpegData(compressionQuality: 0.7), !data.isEmpty else {
                    throw APIError(code: "render_fail", message: "第 \(i + 1) 页压缩失败，请稍后重试")
                }
                refs.append(try await api.uploadFile(data, kind: "page", ext: "jpg", contentType: "image/jpeg"))
                images.append(img)
            }
            guard !refs.isEmpty else {
                throw APIError(code: "empty", message: "没有可用页面")
            }
            if doc.pageCount > maxPages {
                // 如实告知：只导入了前 maxPages 页，不静默丢弃
                errorText = "该 PDF 共 \(doc.pageCount) 页，已导入前 \(maxPages) 页（其余未导入）"
            }

            // 每页一题（id: p1..pn，stem: 第N页）——试卷本身就是「原卷页图」
            let questions: [ExamQuestion] = refs.indices.map { i in
                ExamQuestion(id: "p\(i + 1)", type: .draw, stem: "第\(i + 1)页",
                             options: [], answer: "", points: 0, kp: "", difficulty: 1)
            }
            let draft = ExamDraft(
                name: fileName.isEmpty ? "导入的试卷" : fileName,
                examType: "unit_test",
                suggestedDuration: max(10, refs.count * 5),
                knowledgePoints: [],
                questions: questions,
                answersMarkdown: "")

            workingMsg = "保存试卷…"
            let exam = try await api.saveUploadedExam(
                clientId: "paper_ipad_" + String(Int(Date().timeIntervalSince1970 * 1000)),
                name: draft.name,
                subject: subject,
                subjectName: subjects.first { $0.0 == subject }?.1 ?? "",
                grade: grade,
                draft: draft,
                pageRefs: refs,
                origin: "pdf_write")

            workingMsg = nil
            step = .pick
            dismiss()
            onSaved(exam, images)
        } catch let err as APIError {
            fail(err.userHint)
        } catch {
            fail("导入失败：\(error.localizedDescription)")
        }
    }

    private func fail(_ msg: String) {
        workingMsg = nil
        step = .pick
        errorText = msg
    }

    // MARK: - PDF 页面图

    /// PDF 页 → 白底 UIImage（书写底图 + 阅卷原卷参考，经 COS 直传上云）
    static func pageImage(_ page: PDFPage) -> UIImage? {
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        let targetWidth: CGFloat = 1400
        let scale = min(targetWidth / max(bounds.width, 1), 3)
        let size = CGSize(width: max(bounds.width * scale, 1), height: max(bounds.height * scale, 1))
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            page.draw(with: .mediaBox, to: ctx.cgContext)
        }
    }

    /// PDF 页 → 白底 JPEG Data（兼容旧调用）
    static func pageImageData(_ page: PDFPage) -> Data? {
        guard let img = pageImage(page) else { return nil }
        return img.jpegData(compressionQuality: 0.7)
    }
}
