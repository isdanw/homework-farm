//
//  Identity.swift
//  本机稳定身份（uid）—— 存 Keychain，不采集任何个人信息
//
//  对齐设计文档决策①「不强制绑定」：
//  - 首次启动生成本机 uid，云函数无绑定时用 'ipad_' + uid 作独立命名空间
//  - 之后可在设置页输入小程序生成的令牌执行 bind，绑定后与微信 openid 共享数据
//

import Foundation
import Security

enum IdentityStore {
    private static let service = "xyz.yiyo.exampad.identity"
    private static let account = "uid"

    /// 取本机 uid；不存在则生成并写入 Keychain
    static func uid() -> String {
        // 自动化/多账号测试：simctl launch <bundle> -examUID xxx 时优先用参数值（不落 Keychain）
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-examUID"), i + 1 < args.count, !args[i + 1].isEmpty {
            return args[i + 1]
        }
        if let saved = read(), !saved.isEmpty { return saved }
        let fresh = newUID()
        write(fresh)
        return fresh
    }

    /// 生成形如 ipad_a1b2c3d4 的标识（无个人信息、无设备指纹采集）
    static func newUID() -> String {
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var suffix = ""
        for _ in 0..<8 {
            suffix.append(chars.randomElement()!)
        }
        return "ipad_" + suffix
    }

    // MARK: - Keychain

    private static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }

    private static func write(_ value: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query.merging(attrs) { $1 } as CFDictionary, nil)
        }
    }

    /// 仅供测试/账号重置：清掉本机身份
    static func reset() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}