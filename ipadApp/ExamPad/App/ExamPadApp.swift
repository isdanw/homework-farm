//
//  ExamPadApp.swift
//  App 入口 + 根视图（侧边栏：学习计划 / 考卷中心 / 单元复习 / 单元卡片 / 设置）
//

import SwiftUI

@main
struct ExamPadApp: App {
    @State private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(settings)
        }
    }
}

enum SidebarSection: Hashable, CaseIterable, Identifiable {
    case plans, library, review, cards, settings
    var id: Self { self }
    var title: String {
        switch self {
        case .plans: return "学习计划"
        case .library: return "考卷中心"
        case .review: return "单元复习"
        case .cards: return "单元卡片"
        case .settings: return "设置"
        }
    }
    var icon: String {
        switch self {
        case .plans: return "list.bullet.clipboard"
        case .library: return "doc.text"
        case .review: return "repeat"
        case .cards: return "rectangle.stack"
        case .settings: return "gearshape"
        }
    }
}

struct RootView: View {
    @Environment(AppSettings.self) private var settings
    @State private var selection: SidebarSection? = .library

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $selection)
        } detail: {
            switch selection ?? .library {
            case .plans: StudyPlanView().environment(settings)
            case .library: LibraryView().environment(settings)
            case .review:
                ReviewView().environment(settings)
            case .cards: CardsView().environment(settings)
            case .settings: SettingsView().environment(settings)
            }
        }
    }
}

struct SidebarView: View {
    @Binding var selection: SidebarSection?

    var body: some View {
        List(selection: $selection) {
            ForEach(SidebarSection.allCases) { item in
                Label(item.title, systemImage: item.icon)
                    .tag(item as SidebarSection?)
            }
        }
        .navigationTitle("考卷")
        .listStyle(.sidebar)
    }
}

/// 尚未实现的板块占位（第二期）
struct PlaceholderView: View {
    let title: String
    let note: String
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "hammer")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(note)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 导航路由（考卷中心内部使用，由 LibraryView 的 NavigationStack 承载）
enum Route: Hashable {
    case answer(ExamDetail)
    case report(Submission)
    case recycled(String)
    case pdfWrite(ExamDetail)
}
