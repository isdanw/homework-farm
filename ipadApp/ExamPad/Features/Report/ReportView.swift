//
//  ReportView.swift
//  批改报告：总评 + 逐题诊断 + 人工复核（逐题确认/改判，服务端同步修正错题库）
//

import SwiftUI

struct ReportView: View {
    let submission: Submission
    var onClose: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var exam: ExamDetail?
    @Environment(AppSettings.self) private var settings

    /// 复核：服务端改判后返回的最新提交（nil 时展示原始 submission）
    @State private var live: Submission?
    @State private var reviewMode = false
    @State private var pendingOverride: (qid: String, toCorrect: Bool)?
    @State private var reviewingQid: String?
    @State private var reviewNote: String?

    private var display: Submission { live ?? submission }

    // 注意：不要在这里包 NavigationStack——被 push 进外层栈时内层栈会吞掉推送；
    // fullScreenCover 场景由调用方包 NavigationStack（见 PDFWriteView / AnswerView）
    var body: some View {
        List {
                summaryCard
                if !display.summary.weaknesses.isEmpty {
                    Section("薄弱点") {
                        FlowTags(items: display.summary.weaknesses)
                    }
                }
                if reviewMode {
                    Section {
                        Label("改判会立即写回服务端，并同步修正错题本：误判的撤销不入错题本、漏判的补录。",
                              systemImage: "person.checkmark")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        if let note = reviewNote {
                            Label(note, systemImage: "checkmark.seal")
                                .font(.footnote)
                                .foregroundStyle(.green)
                        }
                    }
                }
                Section {
                    ForEach(Array(display.results.enumerated()), id: \.element.qid) { idx, r in
                        QuestionResultRow(
                            index: idx + 1,
                            result: r,
                            question: exam?.questions.first { $0.id == r.qid },
                            userAnswer: display.answers.first { $0.qid == r.qid }?.text ?? "",
                            reviewMode: reviewMode,
                            busy: reviewingQid == r.qid,
                            onOverride: { toCorrect in
                                pendingOverride = (r.qid, toCorrect)
                            }
                        )
                    }
                } header: {
                    Text("逐题诊断")
                }
            }
            .navigationTitle("批改报告")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(reviewMode ? "退出复核" : "复核") {
                        reviewMode.toggle()
                        reviewNote = nil
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { if let onClose { onClose() } else { dismiss() } }
                }
            }
            .confirmationDialog(
                pendingOverride?.toCorrect == true ? "改判为正确" : "改判为错误",
                isPresented: .constant(pendingOverride != nil),
                titleVisibility: .visible
            ) {
                Button("确认改判") {
                    if let p = pendingOverride { Task { await applyOverride(qid: p.qid, toCorrect: p.toCorrect) } }
                    pendingOverride = nil
                }
                Button("取消", role: .cancel) { pendingOverride = nil }
            } message: {
                Text(pendingOverride?.toCorrect == true
                     ? "AI 判错但您认为作答正确：该题将按满分计，并从错题本移除。"
                     : "AI 判对但您认为作答错误：该题将记 0 分，并补录进错题本。")
            }
            .task { await loadExam() }
    }

    private var summaryCard: some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(display.summary.rate)")
                        .font(.system(size: 44, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text("%").font(.title2).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("正确率").font(.caption).foregroundStyle(.secondary)
                        Text("答对 \(display.summary.correctCount)/\(display.summary.total) 题")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(fmt(display.summary.gotPoints))/\(display.summary.totalPoints)")
                            .font(.title3.monospacedDigit())
                        Text("得分").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !display.summary.advice.isEmpty {
                    Text(display.summary.advice).font(.callout)
                }
                if display.reviewedAt != nil {
                    Label("已人工复核", systemImage: "checkmark.seal.fill")
                        .font(.caption).foregroundStyle(.green)
                }
                Text("判错题已自动回流到小程序端错题本，可在小程序「错题本」查看与订正；复核改判后错题本会同步修正。")
                    .font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - 数据

    private func loadExam() async {
        // 尽力而为：拿不到题目原文时报告仍可显示（只有诊断、没有题干）
        guard exam == nil, let client = settings.makeClient() else { return }
        try? await Task.sleep(nanoseconds: 0)
        exam = try? await ExamAPI(client: client).getExam(resourceId: display.examClientId)
    }

    private func applyOverride(qid: String, toCorrect: Bool) async {
        guard let client = settings.makeClient(), reviewingQid == nil else { return }
        reviewingQid = qid
        defer { reviewingQid = nil }
        do {
            let item = ExamAPI.ReviewItem(
                qid: qid,
                verdict: toCorrect ? "override_correct" : "override_wrong")
            let sub = try await ExamAPI(client: client)
                .reviewSubmission(submissionClientId: display.clientId, reviews: [item])
            live = sub
            let m = sub.results.first { $0.qid == qid }
            var note = toCorrect ? "已改判为正确" : "已改判为错误"
            if let m, let mark = m.review { note += "（\(mark.label)）" }
            reviewNote = note
        } catch let err as APIError {
            reviewNote = nil
            reviewError = err.userHint
        } catch {
            reviewNote = nil
            reviewError = "复核失败：\(error.localizedDescription)"
        }
    }

    @State private var reviewError: String?

    private func fmt(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }
}

/// 二次查看「已回收」试卷的报告（从云端拉取提交记录）
struct RecycledReportView: View {
    let submissionClientId: String
    @Environment(AppSettings.self) private var settings
    @State private var submission: Submission?
    @State private var errorText: String?

    var body: some View {
        Group {
            if let submission {
                ReportView(submission: submission)
            } else if let errorText {
                ContentUnavailableView("无法打开", systemImage: "exclamationmark.triangle",
                                       description: Text(errorText))
            } else {
                ProgressView("正在取回批改记录…")
            }
        }
        .task {
            guard let client = settings.makeClient() else {
                errorText = settings.configIssue ?? "未配置服务"
                return
            }
            do {
                submission = try await ExamAPI(client: client)
                    .getSubmission(clientId: submissionClientId)
            } catch let err as APIError {
                errorText = err.userHint
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}

// MARK: - 逐题行

struct QuestionResultRow: View {
    let index: Int
    let result: GradeResultItem
    let question: ExamQuestion?
    let userAnswer: String
    var reviewMode: Bool = false
    var busy: Bool = false
    var onOverride: ((Bool) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("\(index).").font(.headline.monospacedDigit())
                Image(systemName: result.correct ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(result.correct ? .green : .red)
                if let q = question { Tag(q.type.label) }
                if let mark = result.review {
                    Tag(mark.label)
                        .foregroundStyle(mark.verdict == "override_wrong" ? .red :
                                            mark.verdict == "override_correct" ? .green : .secondary)
                }
                Spacer()
                Text("\(fmt(result.score))/\(question?.points ?? 0) 分")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }

            if let stem = question?.stem, !stem.isEmpty {
                Text(stem).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }

            if let fig = question?.figure, !fig.items.isEmpty {
                FigureView(spec: fig, maxHeight: 160)
            }

            if question?.isChoice == true {
                Text("你的作答：\(displayAnswer)")
                    .font(.footnote)
                    .foregroundStyle(result.correct ? .green : .red)
                if !result.correct, let ans = question?.answerTextForDisplay {
                    Text("参考答案：\(ans)").font(.footnote).foregroundStyle(.secondary)
                }
            } else if !userAnswer.isEmpty {
                Text("你的作答：\(userAnswer)").font(.footnote)
            } else {
                Text("未作答").font(.footnote).foregroundStyle(.secondary)
            }

            let d = result.diagnosis
            if !d.errorDesc.isEmpty || !d.suggestion.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    if !d.display.isEmpty {
                        Tag(d.display).foregroundStyle(.orange)
                    }
                    if !d.errorDesc.isEmpty { Text("错因：\(d.errorDesc)").font(.caption) }
                    if !d.suggestion.isEmpty { Text("建议：\(d.suggestion)").font(.caption) }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            }

            if reviewMode, let onOverride {
                HStack(spacing: 10) {
                    if busy {
                        ProgressView().controlSize(.small)
                    }
                    if result.correct {
                        Button {
                            onOverride(false)
                        } label: {
                            Label("改判错误", systemImage: "arrow.uturn.backward")
                                .font(.footnote)
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                    } else {
                        Button {
                            onOverride(true)
                        } label: {
                            Label("改判正确", systemImage: "arrow.uturn.backward")
                                .font(.footnote)
                        }
                        .buttonStyle(.bordered)
                        .tint(.green)
                    }
                    if result.review == nil {
                        Text("认可 AI 判定则无需操作").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// 把 "B" 显示成 "B. 选项内容"
    private var displayAnswer: String {
        guard let q = question else { return userAnswer }
        let letters = ["A", "B", "C", "D", "E", "F"]
        guard let i = letters.firstIndex(of: userAnswer), i < q.options.count else { return userAnswer }
        return letters[i] + ". " + q.options[i]
    }

    private func fmt(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }
}

extension ExamQuestion {
    /// 参考答案的可读形式："B. 选项内容" 或原文
    var answerTextForDisplay: String? {
        if isChoice, let idx = correctOptionIndex, idx < options.count {
            return label(at: idx) + ". " + options[idx]
        }
        return answer.isEmpty ? nil : answer
    }
}

// MARK: - 流式标签

struct FlowTags: View {
    let items: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items, id: \.self) { Text($0).tag(compact: true) }
        }
    }
}

private extension View {
    func tag(compact: Bool) -> some View {
        self.font(.caption)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Color.orange.opacity(0.12), in: Capsule())
    }
}
