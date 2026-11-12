//
//  LibraryView.swift
//  试卷中心：未作答试卷 + 已回收（已提交批改）试卷
//

import SwiftUI

struct LibraryView: View {
    @Environment(AppSettings.self) private var settings
    @State private var exams: [ExamSummary] = []
    @State private var recycled: [SubmissionSummaryItem] = []
    @State private var loading = false
    @State private var errorText: String?
    @State private var showGenerate = false
    @State private var showImport = false
    @State private var path = NavigationPath()
    /// 刚导入的 PDF 本地渲染页图（透传给 PDFWriteView，免二次下载；进 destination 后即用）
    @State private var pendingPages: [UIImage] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                sectionHeader("生成测验", note: "按薄弱点自动组卷")
                Button {
                    showGenerate = true
                } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "wand.and.stars")
                            .font(.title2)
                            .frame(width: 34, height: 34)
                            .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("AI 生成测验卷").font(.headline)
                            Text("依据画像与近期错题组卷").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)

                Button {
                    showImport = true
                } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "doc.badge.plus")
                            .font(.title2)
                            .frame(width: 34, height: 34)
                            .background(Color.teal.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("导入 PDF 试卷").font(.headline)
                            Text("导入后直接在卷面上书写作答").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)

                if let issue = settings.configIssue {
                    Section {
                        Label(issue, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }

                if let errorText {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(errorText).font(.footnote).foregroundStyle(.red)
                            Button("重试") { Task { await load() } }
                                .font(.footnote.weight(.semibold))
                        }
                    }
                }

                if !exams.isEmpty {
                    sectionHeader("我的考卷", note: "\(exams.count) 份")
                    ForEach(exams) { e in
                        Button { open(e) } label: { ExamRow(exam: e) }
                            .buttonStyle(.plain)
                    }
                }

                if !recycled.isEmpty {
                    sectionHeader("已回收的考卷", note: "已提交并批改")
                    ForEach(recycled) { s in
                        Button {
                            path.append(Route.recycled(s.clientId))
                        } label: { RecycledRow(item: s) }
                        .buttonStyle(.plain)
                    }
                }

                if exams.isEmpty && recycled.isEmpty && !loading {
                    Section {
                        VStack(spacing: 10) {
                            Image(systemName: "doc.text").font(.largeTitle).foregroundStyle(.tertiary)
                            Text("还没有考卷").foregroundStyle(.secondary)
                            Text("点上方「AI 生成测验卷」开始，或在微信小程序端生成后绑定账号共享")
                                .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 30)
                    }
                }
            }
            .navigationTitle("考卷中心")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink { SettingsView() } label: { Image(systemName: "gearshape") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .refreshable { await load() }
            .overlay { if loading { ProgressView() } }
            .sheet(isPresented: $showGenerate) {
                GenerateSheet { exam in
                    showGenerate = false
                    path.append(Route.answer(exam))
                }
            }
            .sheet(isPresented: $showImport) {
                ImportPaperView { exam, pages in
                    showImport = false
                    pendingPages = pages
                    path.append(Route.pdfWrite(exam))
                }
            }
        .navigationDestination(for: Route.self) { route in
            switch route {
                case .answer(let exam): AnswerView(exam: exam)
                case .report(let sub): ReportView(submission: sub)
                case .recycled(let id): RecycledReportView(submissionClientId: id)
                case .pdfWrite(let exam): PDFWriteView(exam: exam, localPages: pendingPages)
                }
            }
        }
        .task { await load() }
    }

    // MARK: - 数据

    private func load() async {
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue
            return
        }
        loading = true
        errorText = nil
        defer { loading = false }
        let api = ExamAPI(client: client)
        do {
            async let e = api.listExams()
            async let s = api.listSubmissions()
            exams = try await e
            recycled = try await s
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "加载失败：\(error.localizedDescription)"
        }
    }

    private func open(_ e: ExamSummary) {
        guard e.canAnswer else { return }
        // PDF 导入卷：每页一题的「直写卷」，走 PDFWriteView（原卷页 + 手写层）
        if e.origin == "pdf_write" {
            Task {
                guard let client = settings.makeClient() else { return }
                do {
                    let exam = try await ExamAPI(client: client).getExam(resourceId: e.resourceId)
                    pendingPages = []
                    path.append(Route.pdfWrite(exam))
                } catch let err as APIError {
                    errorText = err.userHint
                } catch {
                    errorText = "打开失败：\(error.localizedDescription)"
                }
            }
            return
        }
        Task {
            guard let client = settings.makeClient() else { return }
            do {
                let exam = try await ExamAPI(client: client).getExam(resourceId: e.resourceId)
                path.append(Route.answer(exam))
            } catch let err as APIError {
                errorText = err.userHint
            } catch {
                errorText = "打开失败：\(error.localizedDescription)"
            }
        }
    }

    private func sectionHeader(_ title: String, note: String) -> some View {
        Section {
            EmptyView()
        } header: {
            HStack {
                Text(title)
                Spacer()
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - 行视图

struct ExamRow: View {
    let exam: ExamSummary
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(exam.name).font(.headline).lineLimit(1)
                HStack(spacing: 6) {
                    if !exam.subjectName.isEmpty { Tag(exam.subjectName) }
                    if !exam.examTypeLabel.isEmpty { Tag(exam.examTypeLabel) }
                    if exam.qCount > 0 { Tag("\(exam.qCount) 题") }
                    if exam.pageCount > 0 { Tag("原卷\(exam.pageCount)页") }
                    Tag(exam.originLabel)
                }
            }
            Spacer()
            Image(systemName: exam.canAnswer ? "pencil.and.outline" : "eye")
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

struct RecycledRow: View {
    let item: SubmissionSummaryItem
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.examName).font(.headline).lineLimit(1)
                HStack(spacing: 6) {
                    if !item.subjectName.isEmpty { Tag(item.subjectName) }
                    Tag("正确率 \(item.summary.rate)%")
                    if !DateFmt.string(item.createdAt).isEmpty { Tag(DateFmt.string(item.createdAt)) }
                }
            }
            Spacer()
            Text("\(item.summary.gotPoints)/\(item.summary.totalPoints)")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

struct Tag: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.secondary.opacity(0.15), in: Capsule())
    }
}