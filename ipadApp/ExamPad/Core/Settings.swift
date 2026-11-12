//
//  Settings.swift
//  端点 / 访问令牌 / 批改路线的本地配置
//
//  优先级：设置页手动填写（Keychain）> Info.plist 注入（构建期）
//  这样令牌不必写死在源码里，换机器/换环境时在 App 内改一次即可。
//

import Foundation
import Observation

@Observable
final class AppSettings {
    private(set) var uid: String
    var endpointOverride: String { didSet { persistEndpoint() } }
    var token: String { didSet { persistToken() } }
    var gradeRoute: String { didSet { UserDefaults.standard.set(gradeRoute, forKey: Keys.route) } }

    let defaultEndpoint: String
    private let buildToken: String

    private enum Keys {
        static let endpoint = "exam.endpoint.override"
        static let route = "exam.grade.route"
    }

    init(bundle: Bundle = .main) {
        let info = bundle.infoDictionary ?? [:]
        buildToken = (info["EXAM_HTTP_TOKEN"] as? String) ?? ""
        defaultEndpoint = ((info["EXAM_API_BASE_URL"] as? String) ?? "")

            .trimmingCharacters(in: .whitespacesAndNewlines)

        uid = IdentityStore.uid()
        endpointOverride = UserDefaults.standard.string(forKey: Keys.endpoint) ?? ""
        gradeRoute = UserDefaults.standard.string(forKey: Keys.route) ?? "text"
        // 令牌存 Keychain（覆盖 build 注入值）
        if let saved = KeychainToken.read(), !saved.isEmpty {
            token = saved
        } else {
            token = buildToken
        }
    }

    /// 实际使用的端点（手填优先，回落 Info.plist）
    var endpoint: String {
        let e = endpointOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        if !e.isEmpty { return e }
        return defaultEndpoint
    }

    var endpointURL: URL? {
        let s = endpoint
        guard !s.isEmpty else { return nil }
        return URL(string: s.hasSuffix("/") ? String(s.dropLast()) : s)
    }

    var isConfigured: Bool { endpointURL != nil && !token.isEmpty }

    var configIssue: String? {
        if endpointURL == nil { return "未配置服务地址，请检查 Info.plist 的 EXAM_API_BASE_URL 或在设置中填写。" }
        if token.isEmpty { return "未配置访问令牌，请在设置中填写。" }
        return nil
    }

    func makeClient(session: URLSession = .shared) -> APIClient? {
        guard let url = endpointURL else { return nil }
        return APIClient(baseURL: url, token: token, uid: uid, session: session)
    }

    private func persistEndpoint() {
        UserDefaults.standard.set(endpointOverride, forKey: Keys.endpoint)
    }

    private func persistToken() {
        KeychainToken.write(token)
    }
}

/// 访问令牌的 Keychain 存储（独立于 uid，便于轮换而不换身份）
enum KeychainToken {
    private static let service = "xyz.yiyo.exampad.token"
    private static let account = "exam-http-token"

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        if value.isEmpty {
            SecItemDelete(query as CFDictionary)
            return
        }
        let attrs: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        if SecItemUpdate(query as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attrs) { $1 } as CFDictionary, nil)
        }
    }
}