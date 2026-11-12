//
//  AnswerView.swift
//  在线作答页：整份试卷渲染在一张白纸上（真实试卷样式）+ Apple Pencil 作答
//
//  设计要点（对齐真实试卷，参考用户提供的「口答练习1.pdf」）：
//  - 所有题目直接「印刷」在同一张白纸上：试卷名居中做卷头，题目按 1. 2. 3. 编号
//    排版，跟纸质试卷一样；不再是「白卡片 + 题目 + 独立大页」的 App 式布局。
//  - 短小的计算/填空题自动两列并排（像真实口算卷的格子），长题/选择题占整行。
//  - 每题下方是**紧凑**的作答框（按题型给高度：填空 70 / 计算 100 / 简答 150 /
//    画图 200），不再是整张 A4 的大空白。
//  - 作答框自带 钢笔/橡皮/撤销/清空 小工具条（不用系统 PKToolPicker，多画布
//    不会互相抢占导致第二题起无法书写）。
//  - 保存自动：离开题目或提交时静默上传，无需手动保存。
//

import SwiftUI
import PencilKit

struct AnswerView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    let exam: ExamDetail
    @State private var draft: AnswerDraft
    @State private var index = 0
    @State private var submitting = false
    @State private var errorText: String?
    @State private var showConfirm = false
    @State private var drawings: [String: PKDrawing] = [:]
    @State private var savingDrawingQid: String?
    @State private var graded: Submission?

    init(exam: ExamDetail) {
        self.exam = exam
        _draft = State(initialValue: AnswerDraft(exam: exam))
    }

    private var current: ExamQuestion? {
        exam.questions.indices.contains(index) ? exam.questions[index] : nil
    }

    /// 组卷行：相邻的「短小计算/填空题」两列并排（像口算卷格子），其余整行
    private var rows: [[Int]] {
        var out: [[Int]] = []
        var i = 0
        let qs = exam.questions
        while i < qs.count {
            if isCompact(qs[i]), i + 1 < qs.count, isCompact(qs[i + 1]) {
                out.append([i, i + 1])
                i += 2
            } else {
                out.append([i])
                i += 1
            }
        }
        return out
    }

    /// 是否可并排：短题干的计算/填空题（选项题/长题不并排）
    private func isCompact(_ q: ExamQuestion) -> Bool {
        if q.isChoice { return false }
        guard q.type == .fill || q.type == .calc else { return false }
        let stem = q.stem.trimmingCharacters(in: .whitespacesAndNewlines)
        return !stem.isEmpty && stem.count <= 16
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                sheet
            }
            .background(Color(.systemGroupedBackground))
            Divider()
            footer
        }
        .navigationTitle(exam.name)
        .navigationBarTitleDisplayMode(.inline)
        // 试卷页锁定亮色模式：白纸黑字，不随系统暗色模式变化
        // （否则 PencilCanvas 书写态会触发 PencilKit 暗色渲染 bug，画布变黑）
        .preferredColorScheme(.light)
        .alert("还有题目未作答", isPresented: $showConfirm) {
            Button("返回继续作答", role: .cancel) {}
            Button("仍然提交") { Task { await forceSubmit() } }
        } message: {
            Text(checkText)
        }
        .alert("批改失败", isPresented: .constant(errorText != nil)) {
            Button("好") { errorText = nil }
        } message: {
            Text(errorText ?? "")
        }
        .fullScreenCover(item: $graded) { sub in
            NavigationStack {
                ReportView(submission: sub) { dismiss() }
            }
        }
        .sheet(isPresented: $showPaperPages) {
            PaperPagesView(pageRefs: exam.pageRefs, examName: exam.name)
        }
        .onChange(of: index) { old, new in
            // 离开上一题时静默保存手写内容
            guard old != new, exam.questions.indices.contains(old) else { return }
            Task { await flush(qid: exam.questions[old].id) }
        }
        .onDisappear {
            if exam.questions.indices.contains(index) {
                Task { await flush(qid: exam.questions[index].id) }
            }
        }
    }

    @State private var showPaperPages = false

    // MARK: - 一张白纸（整份试卷）

    private var sheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            paperTitle
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(rows.indices, id: \.self) { r in
                    rowView(rows[r])
                }
            }
            .padding(.top, 14)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white)
        .cornerRadius(10)
        .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
        .padding(14)
    }

    /// 卷头：试卷名居中 + 学科/题量（模拟真实试卷抬头）
    private var paperTitle: some View {
        VStack(spacing: 4) {
            Text(exam.name)
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                if !exam.subjectName.isEmpty { Text(exam.subjectName) }
                Text("共 \(exam.questions.count) 题")
                Text("姓名：________")
            }
            .font(.footnote).foregroundStyle(.secondary)
            if !exam.pageRefs.isEmpty {
                Button {
                    showPaperPages = true
                } label: {
                    Label("对照原卷（\(exam.pageRefs.count) 页）", systemImage: "doc.text.magnifyingglass")
                        .font(.footnote)
                }
                .buttonStyle(.bordered)
                .padding(.top, 2)
            }
            Text("用 Apple Pencil 在作答框内书写，写完自动保存")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 1)
        }
    }

    @ViewBuilder
    private func rowView(_ idxs: [Int]) -> some View {
        if idxs.count == 1 {
            questionCell(index: idxs[0])
        } else {
            HStack(alignment: .top, spacing: 10) {
                questionCell(index: idxs[0])
                questionCell(index: idxs[1])
            }
        }
    }

    private func questionCell(index i: Int) -> some View {
        let q = exam.questions[i]
        return PaperQuestion(
            question: q,
            subject: exam.subject,
            number: i + 1,
            compact: isCompact(q),
            choice: draft.choice(for: q.id),
            onChoice: { draft.setChoice($0, for: q.id) },
            drawing: Binding(
                get: { drawings[q.id] ?? PKDrawing() },
                set: { drawings[q.id] = $0 }
            ),
            hasImage: !draft.images(for: q.id).isEmpty || draft.imageBase64(for: q.id) != nil,
            busy: savingDrawingQid == q.id
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 头/尾

    private var header: some View {
        HStack {
            Text("\(index + 1) / \(max(exam.questions.count, 1))")
                .font(.subheadline.monospacedDigit())
            ProgressView(value: Double(draft.answeredCount),
                         total: Double(max(draft.total, 1)))
                .frame(maxWidth: 220)
            Text("已答 \(draft.answeredCount)")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            if !exam.subjectName.isEmpty {
                Text(exam.subjectName).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private var footer: some View {
        HStack {
            Button("上一题") { index = max(0, index - 1) }
                .disabled(index == 0)
            Spacer()
            if index < exam.questions.count - 1 {
                Button("下一题") { index += 1 }.buttonStyle(.borderedProminent)
            } else {
                Button(submitting ? "批改中…" : "提交批改") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(submitting)
            }
        }
        .padding(16)
    }

    private var checkText: String {
        let c = draft.submitCheck()
        return "还有 \(c.unansweredTitles.count) 题未作答（共 \(c.total) 题）。未作答会按 0 分计入总评。"
    }

    // MARK: - 自动保存 / 提交

    /// 单题静默上传：仅当「有笔迹且尚未保存」时上传，已保存则跳过
    private func flush(qid: String) async {
        let drawing = drawings[qid] ?? PKDrawing()
        guard PencilExporter.hasContent(drawing) else { return }
        if !draft.images(for: qid).isEmpty || draft.imageBase64(for: qid) != nil { return }
        savingDrawingQid = qid
        defer { if savingDrawingQid == qid { savingDrawingQid = nil } }
        do {
            guard let client = settings.makeClient() else {
                throw APIError(code: "config", message: settings.configIssue ?? "未配置服务")
            }
            guard let data = PencilExporter.jpegData(from: drawing) else { return }
            let fid = try await ExamAPI(client: client)
                .uploadFile(data, kind: "handwriting", ext: "jpg", contentType: "image/jpeg")
            draft.setImages([fid], for: qid)
            draft.setImageBase64(nil, for: qid)
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "手写图上传失败：\(error.localizedDescription)"
        }
    }

    /// 提交前把所有有笔迹但未保存的题目全部上传
    private func flushAll() async {
        for q in exam.questions {
            let d = drawings[q.id] ?? PKDrawing()
            guard PencilExporter.hasContent(d) else { continue }
            if !draft.images(for: q.id).isEmpty || draft.imageBase64(for: q.id) != nil { continue }
            savingDrawingQid = q.id
            defer { if savingDrawingQid == q.id { savingDrawingQid = nil } }
            do {
                guard let client = settings.makeClient() else {
                    throw APIError(code: "config", message: settings.configIssue ?? "未配置服务")
                }
                guard let data = PencilExporter.jpegData(from: d) else { continue }
                let fid = try await ExamAPI(client: client)
                    .uploadFile(data, kind: "handwriting", ext: "jpg", contentType: "image/jpeg")
                draft.setImages([fid], for: q.id)
            } catch let err as APIError {
                errorText = err.userHint
            } catch {
                errorText = "手写图上传失败：\(error.localizedDescription)"
            }
        }
    }

    private func submit() async {
        await flushAll()
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue
            return
        }
        if !draft.isComplete {
            showConfirm = true
            return
        }
        await grade(client: client)
    }

    /// 二次确认后的强制提交（跳过完整性检查）
    private func forceSubmit() async {
        await flushAll()
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue
            return
        }
        await grade(client: client)
    }

    private func grade(client: APIClient) async {
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            let (sub, _) = try await ExamAPI(client: client)
                .grade(examClientId: exam.resourceId, answers: draft.makeAnswerRecords())
            graded = sub
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "提交失败：\(error.localizedDescription)"
        }
    }
}

// MARK: - 试卷上的单个题目（印刷体排版 + 紧凑作答框）

struct PaperQuestion: View {
    let question: ExamQuestion
    let subject: String
    let number: Int
    /// 是否处于两列并排的紧凑格（影响作答框高度与分值展示）
    var compact: Bool = false
    let choice: String?
    let onChoice: (String) -> Void
    @Binding var drawing: PKDrawing
    let hasImage: Bool
    var busy: Bool = false

    @StateObject private var handle = CanvasHandle()
    @State private var isEraser = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 题号 + 题干：直接印刷在纸上
            HStack(alignment: .top, spacing: 6) {
                Text("\(number).")
                    .font(.body.monospacedDigit())
                    .foregroundStyle(.primary)
                Text(question.stem)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if !compact && question.points > 0 {
                    Spacer()
                    Text("(\(question.points)分)")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }

            // 题图（结构化 figure 原生绘制）：只在题干与作答区之间，不参与手写层
            if let fig = question.figure, !fig.items.isEmpty {
                FigureView(spec: fig, maxHeight: compact ? 120 : 220)
                    .padding(.leading, compact ? 0 : 20)
            }

            if question.isChoice {
                choiceList
            } else {
                writingArea
            }
        }
        .padding(10)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.18)))
    }

    // MARK: 选择题（像试卷一样的选项列表，点选作答）

    private var choiceList: some View {
        VStack(spacing: 8) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { idx, opt in
                let label = question.label(at: idx)
                Button { onChoice(label) } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: choice == label ? "largecircle.fill.circle" : "circle")
                            .font(.footnote)
                            .foregroundStyle(choice == label ? Color.accentColor : Color.secondary)
                        Text(label + ". " + opt)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
                .background(choice == label ? Color.accentColor.opacity(0.08) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    // MARK: 答题线底图 + 透明手写层（方案 A：写在线上，还原纸质卷）

    /// 答题线样式：竖式题→方格；语文（写/拼音）→田字格；其余→横线
    private var lineStyle: AnswerLineStyle {
        if compact { return .ruled(lines: 1) }   // 两列并排的口算格：单行，写一个答案
        let s = question.stem
        let isVertical = (question.type == .calc || question.type == .fill)
            && (s.contains("竖式") || s.contains("笔算") || s.contains("列竖式"))
        if isVertical { return .grid(rows: 3, cols: 6) }
        if subject == "chinese" && (question.type == .fill || question.type == .draw) {
            return .tianzi(cells: question.type == .fill ? 3 : 6)
        }
        switch question.type {
        case .fill: return .ruled(lines: 2)
        case .calc: return .ruled(lines: 3)
        case .essay: return .ruled(lines: 6)
        case .draw: return .ruled(lines: 4)
        default: return .ruled(lines: 3)
        }
    }

    private var writingHeight: CGFloat {
        lineStyle.height()
    }

    private var writingArea: some View {
        VStack(alignment: .leading, spacing: 6) {
            toolBar
            ZStack {
                AnswerLinesView(style: lineStyle)
                PencilCanvas(drawing: $drawing, handle: handle, clearBackground: true)
            }
            .frame(height: writingHeight)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            // 答题线在底层、手写层透明叠上：橡皮只擦笔迹、不擦线（对齐纸质卷）
        }
    }

    /// 小工具条：钢笔 / 橡皮 / 撤销 / 清空（不依赖系统 PKToolPicker，多题互不干扰）
    private var toolBar: some View {
        HStack(spacing: 6) {
            toolButton(icon: "pencil.tip", active: !isEraser) {
                isEraser = false
                handle.setPen()
            }
            toolButton(icon: "eraser", active: isEraser) {
                isEraser = true
                handle.setEraser()
            }
            toolButton(icon: "arrow.uturn.backward", active: false) { handle.undo() }
            toolButton(icon: "trash", active: false) { handle.clear() }
            Spacer()
            statusBadge
        }
    }

    private func toolButton(icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 28, height: 24)
        }
        .buttonStyle(.bordered)
        .tint(active ? Color.accentColor : Color.secondary)
    }

    @ViewBuilder
    private var statusBadge: some View {
        if busy {
            Label("保存中", systemImage: "icloud.and.arrow.up")
                .font(.caption2).foregroundStyle(.secondary)
        } else if hasImage {
            Label("已保存", systemImage: "checkmark.circle.fill")
                .font(.caption2).foregroundStyle(.green)
        }
    }
}
