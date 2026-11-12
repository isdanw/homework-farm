//
//  ReviewView.swift
//  单元复习闭环：选单元 → 出同类题（genUnitReview）→ 作答/批改（复用 AnswerView）→ 掌握度 + 错题回顾
//  数据来自 examService：单元必会点（readFarmUser）、错题（tutor_mistakes，与考卷中心同源）
//

import SwiftUI

/// 统一的错误提示条（配置/网络/接口失败时用，避免被空态掩盖）
struct ErrorBanner: View {
    let text: String
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle).foregroundStyle(.orange)
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 340)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.vertical, 30)
        }
    }
}

/// 复习页内部导航路由
enum ReviewRoute: Hashable {
    case detail(UnitKp)
    case answer(ExamDetail)
}

struct ReviewView: View {
    @Environment(AppSettings.self) private var settings
    @State private var units: [UnitKp] = []
    @State private var loading = false
    @State private var errorText: String?
    @State private var path = NavigationPath()

    private var grouped: [(key: String, items: [UnitKp])] {
        let dict = Dictionary(grouping: units) { ($0.subjectName.isEmpty ? "其他" : $0.subjectName) }
        return dict.map { ($0.key, $0.value.sorted { $0.title < $1.title }) }
            .sorted { $0.key < $1.key }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let errorText {
                    ErrorBanner(text: errorText)
                } else if units.isEmpty && !loading {
                    emptyState
                } else {
                    List {
                        ForEach(grouped, id: \.key) { group in
                            Section(group.key) {
                                ForEach(group.items) { u in
                                    Button { path.append(ReviewRoute.detail(u)) } label: {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(u.displayName).font(.headline)
                                                if !u.grade.isEmpty {
                                                    Text(u.grade).font(.caption).foregroundStyle(.secondary)
                                                }
                                            }
                                            Spacer()
                                            Text("\(u.pointCount) 个必会点")
                                                .font(.caption).foregroundStyle(.tertiary)
                                            Image(systemName: "chevron.right")
                                                .font(.caption).foregroundStyle(.tertiary)
                                        }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("单元复习")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .overlay { if loading { ProgressView() } }
            .task { await load() }
            .navigationDestination(for: ReviewRoute.self) { route in
                switch route {
                case .detail(let u): UnitReviewDetailView(unit: u, path: $path)
                case .answer(let exam): AnswerView(exam: exam)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "repeat")
                .font(.largeTitle).foregroundStyle(.tertiary)
            Text("还没有可复习的单元").foregroundStyle(.secondary)
            Text("在微信小程序端建立「单元必会库」后，绑定账号即可在此按单元复习；或先去做几份测验卷积累错题")
                .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 30)
    }

    private func load() async {
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue
            return
        }
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            units = try await ExamAPI(client: client).listUnits()
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "加载失败：\(error.localizedDescription)"
        }
    }
}

/// 单单元复习详情：掌握度 + 开始复习测验 + 错题回顾
struct UnitReviewDetailView: View {
    let unit: UnitKp
    @Binding var path: NavigationPath
    @Environment(AppSettings.self) private var settings

    @State private var detail: UnitKpDetail?
    @State private var mistakes: [MistakeItem] = []
    @State private var loading = false
    @State private var generating = false
    @State private var errorText: String?
    // 题型库（云端 QUESTION_TYPES）+ 手动配比：复习卷同样按学校题型出
    @State private var qTypes: [QuestionTypeItem] = []
    @State private var mixEnabled = false
    @State private var typeMix: [QuestionTypeMix] = []
    private let reviewCount = 8

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let errorText {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                        Text(errorText).font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                }
                // 头部
                VStack(alignment: .leading, spacing: 4) {
                    Text(unit.displayName).font(.title2.bold())
                    HStack(spacing: 8) {
                        if !unit.subjectName.isEmpty { Tag(unit.subjectName) }
                        if !unit.grade.isEmpty { Tag(unit.grade) }
                        Tag("\(unit.pointCount) 个必会点")
                    }
                }

                // 掌握度
                masteryCard

                // 题型（本年级真实学校题型；手动指定则按配比出）
                if !qTypes.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("题型").font(.headline)
                        QuestionTypeMixEditor(types: qTypes, enabled: $mixEnabled,
                                              mix: $typeMix, target: reviewCount)
                    }
                    .padding(14)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }

                // 开始复习测验
                Button {
                    Task { await startReview() }
                } label: {
                    HStack {
                        if generating {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "play.circle.fill")
                        }
                        Text(generating ? "正在生成复习卷…" : "开始复习测验")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(.white)
                }
                .disabled(generating)
                .buttonStyle(.plain)

                // 错题回顾
                mistakeSection
            }
            .padding(16)
        }
        .navigationTitle("单元复习")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await reload() } } label: { Image(systemName: "arrow.clockwise") }
            }
        }
        .overlay { if loading { ProgressView() } }
        .task { await reload() }
    }

    // MARK: 掌握度

    private var masteryCard: some View {
        let total = unit.pointCount
        let activeTopics = Set(mistakes.filter { $0.isActive }.map { $0.topic })
        let mastered = max(0, total - activeTopics.count)
        let pct = total > 0 ? Int(round(Double(mastered) / Double(total) * 100)) : 0
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("掌握度").font(.headline)
                Spacer()
                Text("\(pct)%").font(.headline).foregroundStyle(pct >= 80 ? .green : (pct >= 50 ? .orange : .red))
            }
            ProgressView(value: Double(pct), total: 100)
                .tint(pct >= 80 ? .green : (pct >= 50 ? .orange : .red))
            Text("已掌握 \(mastered) / \(total) 个必会点（按活跃错题反推）")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: 错题回顾

    private var mistakeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("错题回顾").font(.headline)
            if mistakes.isEmpty {
                Text(loading ? "加载中…" : "暂无活跃错题，继续保持！")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                ForEach(mistakes) { m in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(m.topic.isEmpty ? "（未标注知识点）" : m.topic)
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            if !m.errorType.isEmpty {
                                Text(m.errorType)
                                    .font(.caption2)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Color.orange.opacity(0.15), in: Capsule())
                            }
                        }
                        if !m.errorDesc.isEmpty {
                            Text(m.errorDesc).font(.callout).foregroundStyle(.secondary)
                        }
                        if !m.suggestion.isEmpty {
                            Text("建议：\(m.suggestion)")
                                .font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }

    // MARK: 动作

    private func startReview() async {
        guard let client = settings.makeClient() else { return }
        generating = true
        errorText = nil
        defer { generating = false }
        do {
            let exam = try await ExamAPI(client: client)
                .genUnitReview(subject: unit.subject, grade: unit.grade, unitId: unit.id,
                               count: reviewCount,
                               questionTypes: mixEnabled ? typeMix : [],
                               allowedTypeNames: Set(qTypes.map { $0.name }))
            path.append(ReviewRoute.answer(exam))
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "生成复习卷失败：\(error.localizedDescription)"
        }
    }

    private func reload() async {
        guard let client = settings.makeClient() else { return }
        loading = true
        defer { loading = false }
        let api = ExamAPI(client: client)
        let d = try? await api.getUnitKps(unitId: unit.id)
        detail = d
        // 题型库：按单元学科×年级拉（失败静默 → 隐藏题型区，保持旧行为）
        if qTypes.isEmpty {
            qTypes = (try? await api.listQuestionTypes(subject: unit.subject, grade: unit.grade)) ?? []
        }
        let topics = (d?.points ?? []).map { $0.topic }.filter { !$0.isEmpty }
        do {
            mistakes = try await api.listMistakes(subject: unit.subject, topics: topics)
        } catch {
            mistakes = []
        }
    }
}
