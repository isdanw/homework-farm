//
//  APIClient.swift
//  云函数通道客户端（云函数 URL 化 /examapi）
//
//  契约（与云函数 normalizeHttpEvent 对称）：
//    POST {baseURL}
//      Content-Type: application/json
//      x-exam-token: <EXAM_HTTP_TOKEN>
//      body: {"action":"...","uid":"ipad_xxx", ...}
//    ←  {"ok":true, ...}  或  {"ok":false,"code":"...","msg":"..."}
//
//  设计约束：
//  - 错误一律抛 APIError 并原样带出后端 msg，绝不吞错、不伪造成功
//  - URLSession 可注入 → 单测用 URLProtocol 打桩，不依赖真实网络
//

import Foundation

struct APIError: Error, LocalizedError, Equatable {
    let code: String
    let message: String

    var errorDescription: String? { message }

    /// 面向用户的中文提示（保持与云端 msg 同源，只做排版不改语义）
    var userHint: String {
        switch code {
        case "unauthorized": return "访问令牌无效或缺失，请在「设置」中填写正确令牌。"
        case "no_pack": return "AI 资源包未开通，请到云开发控制台购买「Token Credits 资源包」。"
        case "no_identity": return "无法解析身份，请检查设置页的访问令牌。"
        case "network": return "网络连接失败，请检查网络后重试。"
        case "not_found": return message
        default: return message
        }
    }
}

/// 统一响应外壳：先解 ok/code/msg，再把业务字段解到 T
private struct Envelope<T: Decodable>: Decodable {
    let ok: Bool
    let code: String?
    let msg: String?
}

final class APIClient {
    let baseURL: URL
    let token: String
    let uid: String
    private let session: URLSession

    init(baseURL: URL, token: String, uid: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.uid = uid
        self.session = session
    }

    /// 发起一次 action 调用；失败抛 APIError
    func call<T: Decodable>(_ action: String,
                            _ payload: [String: Any] = [:],
                            as type: T.Type) async throws -> T {
        let data = try await raw(action, payload)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            // 解不出业务结构时，至少把原始 JSON 交出来，避免静默失败
            let snippet = String(data: data, encoding: .utf8) ?? ""
            throw APIError(code: "decode_error",
                            message: "响应解析失败（\(action)）：" + String(snippet.prefix(200)))
        }
    }

    /// 只拿到原始 JSON 字典（用于 ok/code/msg 判定后再自行取字段的场景）
    func raw(_ action: String, _ payload: [String: Any] = [:]) async throws -> Data {
        var body = payload
        body["action"] = action
        // 身份：每次请求都带上 uid；绑定后云函数优先用绑定映射
        if body["uid"] == nil { body["uid"] = uid }

        var req = URLRequest(url: baseURL)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { req.setValue(token, forHTTPHeaderField: "x-exam-token") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
            throw APIError(code: "network", message: "网络连接失败：\(e.localizedDescription)")
        }

        let http = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(http) else {
            throw APIError(code: "http_\(http)", message: "服务返回 HTTP \(http)")
        }

        // 先判业务外壳
        if let env = try? JSONDecoder().decode(Envelope<EmptyBox>.self, from: data) {
            if !env.ok {
                throw APIError(code: env.code ?? "unknown",
                               message: env.msg ?? "服务端返回失败")
            }
        }
        return data
    }

    /// COS 直传 PUT（配合 signUpload 签发的凭证使用）。
    /// 注意：凭证由 node-sdk getUploadMetadata 按 PUT 请求签发（内部硬编码 method:'put'），
    /// 因此必须用 PUT + 请求头鉴权，不能改成 multipart POST（会报 SignatureDoesNotMatch）。
    func put(_ url: URL, headers: [String: String], body: Data) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.timeoutInterval = 180
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
            throw APIError(code: "network", message: "网络连接失败：\(e.localizedDescription)")
        }
        let http = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(http) else {
            let snippet = String(data: data, encoding: .utf8) ?? ""
            throw APIError(code: "upload_http_\(http)",
                           message: "文件上传失败（HTTP \(http)）" + (snippet.isEmpty ? "" : "：" + String(snippet.prefix(120))))
        }
    }

    /// 占位类型：只用来读 ok/code/msg，业务字段另行解析
    struct EmptyBox: Decodable {}
}

// MARK: - 业务响应外壳（字段全 optional，缺失不炸）

struct ListExamsResponse: Decodable {
    let ok: Bool
    let exams: [ExamSummary]?
    private enum CodingKeys: String, CodingKey { case ok, exams }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        exams = ok ? try c.decode([ExamSummary].self, forKey: .exams) : nil
    }
}

struct GetExamResponse: Decodable {
    let ok: Bool
    let exam: ExamDetail?
    private enum CodingKeys: String, CodingKey { case ok, exam }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        exam = ok ? try c.decode(ExamDetail.self, forKey: .exam) : nil
    }
}

struct GradeResponse: Decodable {
    let ok: Bool
    let submission: Submission?
    let mistakesAdded: Int
    private enum CodingKeys: String, CodingKey { case ok, submission, mistakesAdded }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        submission = ok ? try c.decode(Submission.self, forKey: .submission) : nil
        mistakesAdded = (try? c.decode(Int.self, forKey: .mistakesAdded)) ?? 0
    }
}

struct ListSubmissionsResponse: Decodable {
    let ok: Bool
    let submissions: [SubmissionSummaryItem]?
    private enum CodingKeys: String, CodingKey { case ok, submissions }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        submissions = ok ? try c.decode([SubmissionSummaryItem].self, forKey: .submissions) : nil
    }
}

struct GetSubmissionResponse: Decodable {
    let ok: Bool
    let submission: Submission?
    private enum CodingKeys: String, CodingKey { case ok, submission }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        submission = ok ? try c.decode(Submission.self, forKey: .submission) : nil
    }
}

struct ResolveResponse: Decodable {
    let ok: Bool
    let identity: Identity?
    private enum CodingKeys: String, CodingKey { case ok, identity }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        identity = ok ? try c.decode(Identity.self, forKey: .identity) : nil
    }
}

struct BindResponse: Decodable {
    let ok: Bool
    let openid: String?
    private enum CodingKeys: String, CodingKey { case ok, openid }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        openid = (try? c.decode(String.self, forKey: .openid)) ?? ""
    }
}

struct ListProvidersResponse: Decodable {
    let providers: [ProviderMeta]?
    private enum CodingKeys: String, CodingKey { case providers }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        providers = (try? c.decode([ProviderMeta].self, forKey: .providers)) ?? []
    }
}

struct ProviderMeta: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let model: String
    let host: String
    let needsBase64: Bool
}

struct VisionConfigResponse: Decodable {
    let ok: Bool
    let config: VisionConfig?
    private enum CodingKeys: String, CodingKey { case ok, config }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        config = (try? c.decode(VisionConfig.self, forKey: .config))
    }
}

struct SaveVisionConfigResponse: Decodable {
    let ok: Bool
    let code: String?
    let msg: String?
    private enum CodingKeys: String, CodingKey { case ok, code, msg }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        code = (try? c.decode(String.self, forKey: .code))
        msg = (try? c.decode(String.self, forKey: .msg))
    }
}

struct TestVisionResponse: Decodable {
    let ok: Bool
    let code: String?
    let msg: String?
    let sample: String?
    private enum CodingKeys: String, CodingKey { case ok, code, msg, sample }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        code = (try? c.decode(String.self, forKey: .code))
        msg = (try? c.decode(String.self, forKey: .msg))
        sample = (try? c.decode(String.self, forKey: .sample))
    }
}

// MARK: - 上传试卷 / 复核

/// parseUpload 返回的结构化卷草稿（未落库，iPad 预览编辑后再 saveExam）
struct ExamDraft: Decodable, Hashable {
    let name: String
    let examType: String
    let suggestedDuration: Int
    let knowledgePoints: [String]
    let questions: [ExamQuestion]
    let answersMarkdown: String

    private enum CodingKeys: String, CodingKey {
        case name, examType, suggestedDuration, knowledgePoints, questions, answersMarkdown
    }

    /// 显式成员初始化（自定义 init(from:) 会抑制成员初始化器的合成）
    init(name: String, examType: String, suggestedDuration: Int,
         knowledgePoints: [String], questions: [ExamQuestion], answersMarkdown: String) {
        self.name = name
        self.examType = examType
        self.suggestedDuration = suggestedDuration
        self.knowledgePoints = knowledgePoints
        self.questions = questions
        self.answersMarkdown = answersMarkdown
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? "上传试卷"
        examType = (try? c.decode(String.self, forKey: .examType)) ?? "unit_test"
        suggestedDuration = (try? c.decode(Int.self, forKey: .suggestedDuration)) ?? 30
        knowledgePoints = (try? c.decode([String].self, forKey: .knowledgePoints)) ?? []
        questions = (try? c.decode([ExamQuestion].self, forKey: .questions)) ?? []
        answersMarkdown = (try? c.decode(String.self, forKey: .answersMarkdown)) ?? ""
    }
}

struct ParseUploadResponse: Decodable {
    let ok: Bool
    let code: String?
    let msg: String?
    let draft: ExamDraft?
    private enum CodingKeys: String, CodingKey { case ok, code, msg, draft }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        code = (try? c.decode(String.self, forKey: .code))
        msg = (try? c.decode(String.self, forKey: .msg))
        draft = ok ? try? c.decode(ExamDraft.self, forKey: .draft) : nil
    }
}

struct UploadPageImageResponse: Decodable {
    let ok: Bool
    let code: String?
    let msg: String?
    let fileID: String?
    private enum CodingKeys: String, CodingKey { case ok, code, msg, fileID }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        code = (try? c.decode(String.self, forKey: .code))
        msg = (try? c.decode(String.self, forKey: .msg))
        fileID = (try? c.decode(String.self, forKey: .fileID)) ?? nil
    }
}

// MARK: - COS 直传（signUpload 签发凭证 → PUT 文件字节直传云存储）

struct UploadMeta: Decodable, Hashable {
    let url: String
    let authorization: String
    let token: String
    let fileId: String
    let cosFileId: String
    let cloudPath: String

    private enum CodingKeys: String, CodingKey {
        case url, authorization, token, fileId, cosFileId, cloudPath
    }

    init(url: String, authorization: String, token: String,
         fileId: String, cosFileId: String, cloudPath: String) {
        self.url = url; self.authorization = authorization; self.token = token
        self.fileId = fileId; self.cosFileId = cosFileId; self.cloudPath = cloudPath
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        url = (try? c.decode(String.self, forKey: .url)) ?? ""
        authorization = (try? c.decode(String.self, forKey: .authorization)) ?? ""
        token = (try? c.decode(String.self, forKey: .token)) ?? ""
        fileId = (try? c.decode(String.self, forKey: .fileId)) ?? ""
        cosFileId = (try? c.decode(String.self, forKey: .cosFileId)) ?? ""
        cloudPath = (try? c.decode(String.self, forKey: .cloudPath)) ?? ""
    }
}

struct SignUploadResponse: Decodable {
    let ok: Bool
    let code: String?
    let msg: String?
    let upload: UploadMeta?
    private enum CodingKeys: String, CodingKey { case ok, code, msg, upload }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        code = (try? c.decode(String.self, forKey: .code))
        msg = (try? c.decode(String.self, forKey: .msg))
        upload = ok ? try? c.decode(UploadMeta.self, forKey: .upload) : nil
    }
}

struct FileUrlsResponse: Decodable {
    let ok: Bool
    let urls: [String]
    private enum CodingKeys: String, CodingKey { case ok, urls }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        urls = ok ? ((try? c.decode([String].self, forKey: .urls)) ?? []) : []
    }
}

struct ReviewResponse: Decodable {
    let ok: Bool
    let code: String?
    let msg: String?
    let submission: Submission?
    let overridden: Int
    let mistakesRemoved: Int
    let mistakesAdded: Int
    private enum CodingKeys: String, CodingKey {
        case ok, code, msg, submission, overridden, mistakesRemoved, mistakesAdded
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        code = (try? c.decode(String.self, forKey: .code))
        msg = (try? c.decode(String.self, forKey: .msg))
        submission = ok ? try? c.decode(Submission.self, forKey: .submission) : nil
        overridden = (try? c.decode(Int.self, forKey: .overridden)) ?? 0
        mistakesRemoved = (try? c.decode(Int.self, forKey: .mistakesRemoved)) ?? 0
        mistakesAdded = (try? c.decode(Int.self, forKey: .mistakesAdded)) ?? 0
    }
}