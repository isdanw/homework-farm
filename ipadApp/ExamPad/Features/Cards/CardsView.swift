//
//  CardsView.swift
//  单元卡片：复习卡浏览 + 翻面看答案（只读）
//  数据来自 examService listCards（读 hw_farm_user.cards）
//

import SwiftUI

struct CardsView: View {
    @Environment(AppSettings.self) private var settings
    @State private var cards: [CardItem] = []
    @State private var filterSubject: String = "all"
    @State private var loading = false
    @State private var errorText: String?

    private var subjects: [String] {
        let set = Set(cards.map { $0.subjectName.isEmpty ? "其他" : $0.subjectName })
        return ["all"] + set.sorted()
    }

    private var filtered: [CardItem] {
        guard filterSubject != "all" else { return cards }
        return cards.filter { ($0.subjectName.isEmpty ? "其他" : $0.subjectName) == filterSubject }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("学科", selection: $filterSubject) {
                    ForEach(subjects, id: \.self) { s in
                        Text(s == "all" ? "全部" : s).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)

                if let errorText {
                    ErrorBanner(text: errorText)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                } else if cards.isEmpty && !loading {
                    emptyState
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                } else {
                    List(filtered) { card in
                        CardRow(card: card)
                    }
                }
            }
            .navigationTitle("单元卡片")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .overlay { if loading { ProgressView() } }
            .task { await load() }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "rectangle.stack")
                .font(.largeTitle).foregroundStyle(.tertiary)
            Text("还没有复习卡").foregroundStyle(.secondary)
            Text("在微信小程序端生成复习卡（导学诊断 / 建单元必会库自动产出）后，绑定账号即可在此复习")
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
            cards = try await ExamAPI(client: client).listCards()
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = "加载失败：\(error.localizedDescription)"
        }
    }
}

/// 单张复习卡：点按翻面（正面↔答案）
struct CardRow: View {
    let card: CardItem
    @State private var flipped = false

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { flipped.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(card.topic.isEmpty ? "（未标注知识点）" : card.topic)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(card.boxLabel)
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                    if card.isDue {
                        Text("到期")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }
                Text(flipped ? (card.back.isEmpty ? "（无答案）" : card.back) : card.front)
                    .font(flipped ? .callout : .body)
                    .foregroundStyle(flipped ? .secondary : .primary)
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}
