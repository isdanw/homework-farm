//
//  StudyPlanView.swift
//  学习计划：单元必会库列表（按学科分组）+ 每单元必会知识点详情
//  数据来自 examService listUnits / getUnitKps（读 hw_farm_user 切片）
//

import SwiftUI

struct StudyPlanView: View {
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
                                    Button { path.append(u.id) } label: {
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
            .navigationTitle("学习计划")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .overlay { if loading { ProgressView() } }
            .task { await load() }
            .navigationDestination(for: String.self) { unitId in
                UnitDetailView(unitId: unitId)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "list.bullet.clipboard")
                .font(.largeTitle).foregroundStyle(.tertiary)
            Text("还没有学习计划").foregroundStyle(.secondary)
            Text("在微信小程序端建立「单元必会库」后，绑定账号即可在此查看；或在小程序生成学习计划")
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

/// 单个单元必会库详情：列出每单元的必会知识点（正面/反面）
struct UnitDetailView: View {
    let unitId: String
    @Environment(AppSettings.self) private var settings
    @State private var unit: UnitKpDetail?
    @State private var loading = false
    @State private var errorText: String?

    var body: some View {
        Group {
            if let unit {
                if unit.points.isEmpty {
                    Text("该单元暂无必会点").foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(unit.points.sorted { $0.order < $1.order }) { p in
                        VStack(alignment: .leading, spacing: 8) {
                            if !p.topic.isEmpty {
                                Text(p.topic).font(.subheadline.weight(.semibold))
                            }
                            if !p.front.isEmpty {
                                Text(p.front).font(.body)
                            }
                            if !p.back.isEmpty {
                                Text(p.back)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .padding(.top, 2)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            } else if loading {
                ProgressView()
            } else if let errorText {
                Text(errorText).font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(unit?.title.isEmpty == false ? unit!.title : "单元必会点")
        .task { await load() }
    }

    private func load() async {
        guard let client = settings.makeClient() else { return }
        loading = true
        defer { loading = false }
        do {
            unit = try await ExamAPI(client: client).getUnitKps(unitId: unitId)
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "加载失败：\(error.localizedDescription)"
        }
    }
}
