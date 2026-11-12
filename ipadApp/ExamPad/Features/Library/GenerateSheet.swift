//
//  GenerateSheet.swift
//  AI 生成测验卷表单
//

import SwiftUI

struct GenerateSheet: View {
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    var onDone: (ExamDetail) -> Void

    @State private var subject = "math"
    @State private var grade = "一年级"
    @State private var count = 10
    @State private var difficulty = 2
    @State private var examType = "unit_test"
    @State private var mode = "auto"
    @State private var topic = "综合"
    @State private var generating = false
    @State private var errorText: String?
    // 题型库（云端 QUESTION_TYPES，学科×年级真实题型）+ 手动配比
    @State private var qTypes: [QuestionTypeItem] = []
    @State private var mixEnabled = false
    @State private var typeMix: [QuestionTypeMix] = []

    private let subjects = [("math", "数学"), ("chinese", "语文"), ("english", "英语")]
    private let grades = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"]
    private let counts = [5, 8, 10, 12, 15, 20]
    private let difficulties = [(1, "基础"), (2, "标准"), (3, "拔高")]
    private let examTypes = [("unit_test", "单元测"), ("phase_test", "阶段测"),
                            ("diagnostic_test", "诊断"), ("special_test", "专项")]
    private let modes = [("auto", "自动（按学情混排题型）"), ("handwriting", "手写卷（全题型可手写）")]
    /// 专题随学科联动（key=传给云端的专题名，须与云函数 GEN_TOPICS 对齐）
    private let topicsBySubject: [String: [String]] = [
        "math": ["综合", "口算", "应用题", "图形", "钟表与时间", "比较与排序"],
        "chinese": ["综合", "拼音", "识字与词语", "阅读理解", "看图写话与写作", "古诗与背默"],
        "english": ["综合", "字母与发音", "单词", "句型", "阅读理解"]
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("学科") {
                    Picker("学科", selection: $subject) {
                        ForEach(subjects, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: subject) { _, _ in
                        // 学科切换时重置专题（各学科专题清单不同）
                        let list = topicsBySubject[subject] ?? ["综合"]
                        if !list.contains(topic) { topic = "综合" }
                        Task { await loadTypes() }
                    }
                }
                Section("年级与专题") {
                    Picker("年级", selection: $grade) {
                        ForEach(grades, id: \.self) { Text($0).tag($0) }
                    }
                    .onChange(of: grade) { _, _ in Task { await loadTypes() } }
                    Picker("专题", selection: $topic) {
                        ForEach(topicsBySubject[subject] ?? ["综合"], id: \.self) { Text($0) }
                    }
                    Text("出题范围按「年级重点」锚定不超纲；选「综合」按年级重点混排，选专题（如口算/阅读理解）则整卷围绕该专题。")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                Section("题量") {
                    Picker("题量", selection: $count) {
                        ForEach(counts, id: \.self) { Text("\($0) 题").tag($0) }
                    }
                }
                if !qTypes.isEmpty {
                    Section("题型") {
                        QuestionTypeMixEditor(types: qTypes, enabled: $mixEnabled,
                                              mix: $typeMix, target: count)
                    }
                }
                Section("难度") {
                    Picker("难度", selection: $difficulty) {
                        ForEach(difficulties, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.segmented)
                }
                Section("卷型") {
                    Picker("卷型", selection: $examType) {
                        ForEach(examTypes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }
                Section("作答模式") {
                    Picker("作答模式", selection: $mode) {
                        ForEach(modes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.menu)
                    Text("「手写卷」会让 AI 把所有题目都生成为可手写题型：学生像在真实 A4 纸上一样，全部用手写/Pencil 作答；若网页端看板已配置视觉模型（本机自动跟随），提交后将自动 OCR 识别并批改。")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                if let errorText {
                    Section {
                        Text(errorText).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("生成测验卷")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(generating ? "生成中…" : "生成") { Task { await generate() } }
                        .disabled(generating)
                }
            }
            .overlay { if generating { ProgressView() } }
            .task { await loadTypes() }
        }
    }

    /// 拉题型库（失败静默：该学科×年级没有题型时整块隐藏，保持旧行为）
    private func loadTypes() async {
        guard let client = settings.makeClient() else { return }
        let s = subject, g = grade
        do {
            let list = try await ExamAPI(client: client).listQuestionTypes(subject: s, grade: g)
            await MainActor.run {
                guard s == subject, g == grade else { return }   // 期间又切了学科/年级则丢弃
                qTypes = list
                typeMix = []
                mixEnabled = false
            }
        } catch {
            await MainActor.run { qTypes = [] }
        }
    }

    private func generate() async {
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue ?? "未配置服务"
            return
        }
        generating = true
        errorText = nil
        defer { generating = false }
        do {
            var p = ExamAPI.GenParams()
            p.subject = subject
            p.grade = grade
            p.count = count
            p.difficulty = difficulty
            p.examType = examType
            p.mode = mode
            p.topic = topic
            p.typeMix = mixEnabled ? typeMix : []
            p.allowedTypeNames = Set(qTypes.map { $0.name })
            let exam = try await ExamAPI(client: client).gen(p)
            onDone(exam)
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "生成失败：\(error.localizedDescription)"
        }
    }
}