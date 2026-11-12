//
//  PaperPagesView.swift
//  原卷页面查看：云存储 fileID → 临时 URL → 分页浏览（作答/复核时对照原卷）
//

import SwiftUI

struct PaperPagesView: View {
    let pageRefs: [String]
    var examName: String = ""

    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var urls: [String] = []
    @State private var errorText: String?
    @State private var page = 0

    var body: some View {
        NavigationStack {
            Group {
                if urls.isEmpty && errorText == nil {
                    ProgressView("正在取回原卷页面…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorText {
                    ContentUnavailableView("无法加载原卷", systemImage: "photo.badge.exclamationmark",
                                           description: Text(errorText))
                } else {
                    VStack(spacing: 0) {
                        TabView(selection: $page) {
                            ForEach(Array(urls.enumerated()), id: \.offset) { i, url in
                                ZoomableImage(urlString: url)
                                    .tag(i)
                            }
                        }
                        .tabViewStyle(.page(indexDisplayMode: .automatic))
                        Divider()
                        Text("第 \(page + 1) / \(urls.count) 页")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                    }
                }
            }
            .navigationTitle(examName.isEmpty ? "原卷" : examName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        guard let client = settings.makeClient() else {
            errorText = settings.configIssue ?? "未配置服务"
            return
        }
        do {
            urls = try await ExamAPI(client: client).fileURLs(pageRefs)
            if urls.isEmpty { errorText = "未取到原卷页面地址，可稍后重试" }
        } catch let err as APIError {
            errorText = err.userHint
        } catch {
            errorText = error.localizedDescription
        }
    }
}

/// 可双指缩放的远程图片
struct ZoomableImage: View {
    let urlString: String
    @State private var scale: CGFloat = 1

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            AsyncImage(url: URL(string: urlString)) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                        .scaleEffect(scale)
                        .gesture(
                            MagnificationGesture()
                                .onChanged { scale = min(max($0, 1), 5) }
                        )
                        .onTapGesture { scale = scale > 1 ? 1 : 2 }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failure:
                    ContentUnavailableView("页面加载失败", systemImage: "wifi.exclamationmark")
                default:
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .background(Color(.systemGroupedBackground))
    }
}
