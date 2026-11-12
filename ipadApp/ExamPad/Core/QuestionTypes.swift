//
//  QuestionTypes.swift
//  题型库：与云函数 examService 的 QUESTION_TYPES 同源（云端为唯一真相源，客户端不硬编码）
//
//  设计约束：
//  - 拉不到 / 该学科×年级没有题型 → types 为空，出卷入口自动隐藏题型区（零回归）
//  - 手动配比才回传；不回传时云端按整库自动混排
//

import Foundation

/// 云端题型条目（name=题型名，hint=题干格式要求，type=QuestionType 枚举值）
struct QuestionTypeItem: Decodable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let hint: String
    let type: String

    private enum CodingKeys: String, CodingKey { case name, hint, type }

    init(name: String, hint: String, type: String) {
        self.name = name; self.hint = hint; self.type = type
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        hint = (try? c.decode(String.self, forKey: .hint)) ?? ""
        type = (try? c.decode(String.self, forKey: .type)) ?? "fill"
    }
}

/// 用户手动指定的题型配比（name=题型名，count=该题型的题数）
struct QuestionTypeMix: Codable, Hashable, Identifiable {
    var id: String { name }
    var name: String
    var count: Int

    init(name: String, count: Int) {
        self.name = name; self.count = count
    }
}

enum QuestionTypeMixHelper {
    /// 按目标题量在题型库上轮转均分（配比稳定可预期：前 N 个题型各多 1 题）
    static func distribute(_ types: [QuestionTypeItem], total: Int) -> [QuestionTypeMix] {
        guard !types.isEmpty, total > 0 else { return [] }
        var out = types.map { QuestionTypeMix(name: $0.name, count: 0) }
        for i in 0..<total { out[i % out.count].count += 1 }
        return out.filter { $0.count > 0 }
    }

    static func total(_ mix: [QuestionTypeMix], allowed: Set<String>? = nil) -> Int {
        valid(mix, allowed: allowed).reduce(0) { $0 + $1.count }
    }

    /// 有效配比：剔除空名、0 题，以及（给了 allowed 时）不在题型库里的名字。
    /// allowed 让客户端口径与云端 normTypeMix 一致——否则库外题型会被算进题量。
    static func valid(_ mix: [QuestionTypeMix], allowed: Set<String>? = nil) -> [QuestionTypeMix] {
        mix.filter { !$0.name.isEmpty && $0.count > 0 && (allowed == nil || allowed!.contains($0.name)) }
    }

    /// 云端期望的载荷：[["name":"口算","count":4], ...]
    static func payload(_ mix: [QuestionTypeMix], allowed: Set<String>? = nil) -> [[String: Any]] {
        valid(mix, allowed: allowed).map { ["name": $0.name, "count": $0.count] }
    }
}
