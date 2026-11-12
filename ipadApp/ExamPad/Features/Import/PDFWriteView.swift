//
//  PDFWriteView.swift
//  PDF 直写作答：原卷页图为底 + 透明 Pencil 手写层，逐页书写 → 提交整页视觉阅卷
//
//  流程（用户拍板 2026-10-25）：类似网页打开 PDF，直接在卷面上书写，最后阅卷。
//  - 页面图来自导入时上传的原卷页（pageRefs）；刚导入的卷直接透传本地渲染图，免二次下载
//  - 手写层用 PencilKit（transparent 背景叠加在页图上）；只认 Apple Pencil，防误触
//  - 提交时把「页图 + 笔迹」合成为一张 JPEG 上传 → 调 gradePaper 逐页视觉阅卷
//

import SwiftUI
import PencilKit
import UIKit

struct PDFWriteView: View {
    let exam: ExamDetail
    /// 导入瞬间透传的本地渲染页图（避免刚导入就重复下载）；重新打开考卷时为空 → 走云端下载
    var localPages: [UIImage] = []

    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var pageImages: [UIImage] = []
    @State private var drawings: [PKDrawing] = []
    @State private var page = 0
    @State private var loading = false
    @State private var submitting = false
    @State private var errorText: String?
    @State private var showSubmitConfirm = false
    @State private var submission: Submission?
    @State private var erasing = false
    @State private var handle = CanvasHandle()

    private var pageCount: Int { pageImages.count }

    var body: some View {
        Group {
            if loading {
                ProgressView("正在取回试卷页面…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorText {
                ErrorBanner(text: errorText)
            } else if pageImages.isEmpty {
                ContentUnavailableView("没有可书写的页面", systemImage: "doc")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 0) {
                    TabView(selection: $page) {
                        ForEach(pageImages.indices, id: \.self) { i in
                            pageView(i)
                                .tag(i)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .automatic))

                    Divider()
                    toolBar
                }
            }
        }
        .navigationTitle(exam.name.isEmpty ? "作答" : exam.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if hasBlankPage { showSubmitConfirm = true } else { Task { await submit() } }
                } label: {
                    if submitting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("提交阅卷").font(.headline)
                    }
                }
                .disabled(submitting || pageImages.isEmpty)
            }
        }
        .task { await loadPages() }
        .fullScreenCover(item: $submission) { sub in
            NavigationStack {
                ReportView(submission: sub) { [dismiss] in
                    // 阅卷完成 → 回到考卷中心（该卷已进入「已回收」）
                    dismiss()
                }
            }
        }
        .alert("还有空白页", isPresented: $showSubmitConfirm) {
            Button("仍要提交") { Task { await submit() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("有 \(blankCount) 页没有任何书写。空白页会标为「未提交该页」进入错题本，确定提交吗？")
        }
    }

    // MARK: - 单页（原卷页图 + 透明手写层）

    private func pageView(_ i: Int) -> some View {
        Image(uiImage: pageImages[i])
            .resizable()
            .scaledToFit()
            .overlay {
                // 手写层与页图完全同矩形 → 笔迹坐标与页图线性对应（提交合成时按比例缩放）
                PencilCanvas(drawing: $drawings[i], handle: handle, clearBackground: true)
            }
            .background(Color(.systemGroupedBackground))
    }

    // MARK: - 底部工具条

    private var toolBar: some View {
        HStack(spacing: 28) {
            Button {
                erasing = false
                handle.setPen()
            } label: {
                Image(systemName: "pencil.tip")
                    .font(.title3)
                    .foregroundStyle(erasing ? Color.secondary : Color.accentColor)
            }
            Button {
                erasing = true
                handle.setEraser()
            } label: {
                Image(systemName: "eraser")
                    .font(.title3)
                    .foregroundStyle(erasing ? Color.accentColor : Color.secondary)
            }
            Button { handle.undo() } label: {
                Image(systemName: "arrow.uturn.backward").font(.title3)
            }
            Button { handle.clear() } label: {
                Image(systemName: "trash").font(.title3)
            }
            Spacer()
            Text("第 \(page + 1) / \(pageCount) 页")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }

    // MARK: - 数据

    private func loadPages() async {
        // 刚导入：直接透传本地渲染图
        if !localPages.isEmpty, localPages.count == exam.pageRefs.count {
            pageImages = localPages
            drawings = Array(repeating: PKDrawing(), count: localPages.count)
            return
        }
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue
            return
        }
        loading = true
        defer { loading = false }
        do {
            let urls = try await ExamAPI(client: client).fileURLs(exam.pageRefs)
            guard !urls.isEmpty else {
                errorText = "未取到试卷页面，请稍后重试"
                return
            }
            var images: [UIImage] = []
            for u in urls {
                if let url = URL(string: u), let (d, _) = try? await URLSession.shared.data(from: url),
                   let img = UIImage(data: d) {
                    images.append(img)
                }
            }
            guard !images.isEmpty else {
                errorText = "试卷页面下载失败，请检查网络后重试"
                return
            }
            pageImages = images
            drawings = Array(repeating: PKDrawing(), count: images.count)
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "加载失败：\(error.localizedDescription)"
        }
    }

    // MARK: - 提交

    private var blankCount: Int {
        drawings.indices.filter { !PencilExporter.hasContent(drawings[$0]) }.count
    }

    private var hasBlankPage: Bool { blankCount > 0 }

    private func submit() async {
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue
            return
        }
        submitting = true
        defer { submitting = false }
        do {
            let api = ExamAPI(client: client)
            var answers: [PaperAnswer] = []
            for i in drawings.indices where PencilExporter.hasContent(drawings[i]) {
                guard pageImages.indices.contains(i),
                      let data = Self.compose(pageImage: pageImages[i], drawing: drawings[i]) else { continue }
                let fileId = try await api.uploadFile(data, kind: "handwriting", ext: "jpg", contentType: "image/jpeg")
                answers.append(PaperAnswer(qid: "p\(i + 1)", imageRefs: [fileId]))
            }
            let (sub, _) = try await api.gradePaper(examClientId: exam.resourceId, answers: answers)
            submission = sub
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "提交失败：\(error.localizedDescription)"
        }
    }

    /// 「原卷页图 + 笔迹」合成一张 JPEG（阅卷时视觉模型看到的就是"卷面上写字"的真实效果）
    static func compose(pageImage: UIImage, drawing: PKDrawing) -> Data? {
        guard PencilExporter.hasContent(drawing) else { return nil }
        let bounds = drawing.bounds
        guard bounds.width > 0.5, bounds.height > 0.5 else { return nil }
        let size = pageImage.size
        let sx = size.width / bounds.width     // 画布坐标 → 页图像素（画布与页图同矩形，两轴近似等比例）
        let sy = size.height / bounds.height
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { _ in
            pageImage.draw(in: CGRect(origin: .zero, size: size))
            let dImg = drawing.image(from: bounds, scale: sx)
            dImg.draw(in: CGRect(x: 0, y: 0, width: bounds.width * sx, height: bounds.height * sy))
        }
        return image.jpegData(compressionQuality: 0.7)
    }
}
