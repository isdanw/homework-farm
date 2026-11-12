//
//  SettingsView.swift
//  身份 / 访问令牌 / 账号绑定 / 连接测试
//

import SwiftUI

struct SettingsView: View {
    @Environment(AppSettings.self) private var settings
    @State private var bindToken = ""
    @State private var identity: Identity?
    @State private var status: String?
    @State private var busy = false
    @State private var isError = false

    // 手写识别（视觉模型）：**跟随网页端配置**，本机只读展示 + 测试连接。
    // 配置唯一维护入口 = 网页端看板（vision_config[openid]，双端同一份）。
    // 历史教训：早期版本在本机放「模型服务选择器 + API Key 输入 + 保存」，
    // 选择器数据源是云函数静态内置清单（与用户实际配置无关），且本地保存会
    // 覆盖网页端配置——已全部移除，勿再加回。
    @State private var visionCfg: VisionConfig?
    @State private var visionCfgLoaded = false
    @State private var visStatus: String?
    @State private var visIsError = false
    @State private var visBusy = false

    var body: some View {
        Form {
            Section("本机身份") {
                LabeledContent("设备标识", value: settings.uid)
                    .font(.footnote.monospaced())
                if let identity {
                    LabeledContent("云端身份", value: identity.display)
                        .font(.footnote)
                }
                Button("重新检测身份") { Task { await check() } }
                    .font(.footnote)
            }

            Section("访问配置") {
                TextField("服务地址（留空用默认）", text: Bindable(settings).endpointOverride)
                    .font(.footnote.monospaced())
                SecureField("访问令牌", text: Bindable(settings).token)
                    .font(.footnote.monospaced())
                Text("默认地址：\(settings.defaultEndpoint.isEmpty ? "未配置" : settings.defaultEndpoint)")
                    .font(.caption2).foregroundStyle(.tertiary)
                Text("令牌与地址只保存在本机 Keychain / UserDefaults，不上传。")
                    .font(.caption2).foregroundStyle(.tertiary)
            }

            Section("连接测试") {
                Button("测试连接") { Task { await check() } }
                    .disabled(busy)
                if let status {
                    Label(status, systemImage: isError ? "xmark.circle" : "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(isError ? .red : .green)
                }
            }

            Section("绑定微信账号（可选）") {
                TextField("粘贴「网页看板」生成的网页口令（或整条链接）", text: $bindToken)
                    .font(.footnote.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("绑定") { Task { await bind() } }
                    .disabled(busy || bindToken.isEmpty)
                Text("在小程序「网页看板」页点「复制口令」后粘贴此处即可；若误复制了整条链接也能自动识别。绑定后本机与微信小程序共享同一份考卷/错题数据；不绑定则以独立账号运行，数据仅本机可见。")
                    .font(.caption2).foregroundStyle(.tertiary)
            }

            Section("手写识别（视觉模型）") {
                if !visionCfgLoaded {
                    Text("正在读取网页端配置…").font(.caption).foregroundStyle(.tertiary)
                } else if let cfg = visionCfg, !cfg.model.isEmpty {
                    LabeledContent("状态", value: cfg.enabled ? "已启用" : "已停用")
                    LabeledContent("模型服务", value: Self.providerName(cfg.provider))
                    LabeledContent("模型", value: cfg.model)
                    if !cfg.apiKey.isEmpty {
                        LabeledContent("API Key", value: Self.maskKey(cfg.apiKey))
                    }
                    Button("测试连接") { Task { await testVision() } }
                        .disabled(visBusy)
                    if let s = visStatus {
                        Label(s, systemImage: visIsError ? "xmark.circle" : "checkmark.circle")
                            .font(.footnote)
                            .foregroundStyle(visIsError ? .red : .green)
                    }
                    Text("以上配置在网页端看板维护，本机自动跟随（两端共用同一账号）；此页仅查看与测试。")
                        .font(.caption2).foregroundStyle(.tertiary)
                } else {
                    Text("尚未配置视觉模型。请在网页端看板「视觉模型」中配置并保存，本机会自动跟随，无需在此设置。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .task { await check() }
        .task { await loadVisionConfig() }
    }

    private func check() async {
        guard let client = settings.makeClient() else {
            status = settings.configIssue
            isError = true
            return
        }
        busy = true
        defer { busy = false }
        let api = ExamAPI(client: client)
        do {
            identity = try await api.resolve()
            status = "连接正常"
            isError = false
        } catch let err as APIError {
            status = err.userHint
            isError = true
        } catch {
            status = error.localizedDescription
            isError = true
        }
    }

    private func loadVisionConfig() async {
        guard !visionCfgLoaded else { return }
        visionCfgLoaded = true
        guard let client = settings.makeClient() else {
            visStatus = settings.configIssue
            visIsError = true
            return
        }
        do {
            visionCfg = try await ExamAPI(client: client).getVisionConfig()
        } catch {
            // 读取失败不阻断主界面；点「测试连接」时会再判定
            visStatus = "读取网页端配置失败：\(error.localizedDescription)"
            visIsError = true
        }
    }

    private func testVision() async {
        guard let client = settings.makeClient() else {
            visStatus = settings.configIssue
            visIsError = true
            return
        }
        guard let cfg = visionCfg, !cfg.model.isEmpty else {
            visStatus = "尚未配置视觉模型，请先在网页端看板配置"
            visIsError = true
            return
        }
        visBusy = true
        defer { visBusy = false }
        do {
            let sample = try await ExamAPI(client: client).testVision(cfg)
            visStatus = sample.isEmpty ? "连接成功" : "连接成功：\(sample)"
            visIsError = false
        } catch let err as APIError {
            visStatus = err.userHint
            visIsError = true
        } catch {
            visStatus = error.localizedDescription
            visIsError = true
        }
    }

    private func bind() async {
        guard let client = settings.makeClient() else {
            status = settings.configIssue
            isError = true
            return
        }
        // 容错：用户可能粘贴「网页口令」本身，也可能误粘贴整条直达链接（含 ?tok=）。
        // 统一规整为裸令牌：去首尾空格/换行、去引号、若含 tok= 则自动提取。
        let token = SettingsView.normalizeBindToken(bindToken)
        guard !token.isEmpty else {
            status = "请粘贴小程序「网页看板」生成的网页口令（或整条链接也可）"
            isError = true
            return
        }
        busy = true
        defer { busy = false }
        do {
            let openid = try await ExamAPI(client: client).bind(token: token)
            bindToken = ""
            identity = try? await ExamAPI(client: client).resolve()
            status = openid.isEmpty ? "绑定成功" : "绑定成功：\(openid)"
            isError = false
        } catch let err as APIError {
            status = err.userHint
            isError = true
        } catch {
            status = error.localizedDescription
            isError = true
        }
    }

    /// 从用户粘贴的内容里规整出裸令牌
    static func normalizeBindToken(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // 去掉被夹带的引号
        if (s.hasPrefix("\"") && s.hasSuffix("\"")) || (s.hasPrefix("'") && s.hasSuffix("'")) {
            s = String(s.dropFirst().dropLast())
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        // 形如链接时，提取 tok= 之后的令牌（取到 & # ? 或结尾为止）
        if let range = s.range(of: "tok=") {
            let after = String(s[range.upperBound...])
            let end = after.firstIndex(where: { $0 == "&" || $0 == "#" || $0 == "?" }) ?? after.endIndex
            s = String(after[..<end])
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// provider id → 展示名（覆盖网页端三平台 + 云函数内置清单 + 兜底原样展示）
    static func providerName(_ id: String) -> String {
        switch id {
        case "deepseek": return "DeepSeek"
        case "siliconflow": return "硅基流动 SiliconFlow"
        case "custom": return "自定义（OpenAI 兼容）"
        case "qwen-vl": return "通义千问 VL"
        case "glm-4v": return "智谱 GLM-4V"
        case "doubao-vl": return "豆包视觉"
        case "gpt-4o": return "OpenAI GPT-4o"
        case "gemini": return "Google Gemini"
        default: return id.isEmpty ? "未知" : id
        }
    }

    /// API Key 打码：只露头尾各 4 位
    static func maskKey(_ k: String) -> String {
        guard k.count > 8 else { return String(repeating: "•", count: max(k.count, 4)) }
        return "\(k.prefix(4))••••••\(k.suffix(4))"
    }
}