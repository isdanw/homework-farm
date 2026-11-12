//
//  ExamAPI.swift
//  业务动作封装（薄层）：把 APIClient 的 raw 响应映射成领域模型
//

import Foundation

/// PDF 直写卷的单页提交（qid=页码题号，imageRefs=「原卷+手写」合成页图的 fileID）
struct PaperAnswer {
    let qid: String
    let imageRefs: [String]
}

struct ExamAPI {
    let client: APIClient

    // MARK: 身份 / 绑定

    func resolve() async throws -> Identity {
        let r: ResolveResponse = try await client.call("resolve", as: ResolveResponse.self)
        return r.identity ?? Identity(openid: "", bound: false, kind: "none")
    }

    func bind(token: String) async throws -> String {
        let r: BindResponse = try await client.call(
            "bind", ["token": token], as: BindResponse.self)
        return r.openid ?? ""
    }

    // MARK: 试卷

    func listExams(subject: String = "") async throws -> [ExamSummary] {
        var payload: [String: Any] = [:]
        if !subject.isEmpty { payload["subject"] = subject }
        let r: ListExamsResponse = try await client.call("listExams", payload, as: ListExamsResponse.self)
        return r.exams ?? []
    }

    func getExam(resourceId: String) async throws -> ExamDetail {
        let r: GetExamResponse = try await client.call(
            "getExam", ["resourceId": resourceId], as: GetExamResponse.self)
        guard let exam = r.exam else { throw APIError(code: "not_found", message: "未找到该考卷") }
        return exam
    }

    // MARK: 生成

    struct GenParams {
        var subject: String = "math"
        var grade: String = "一年级"
        var count: Int = 10
        var difficulty: Int = 2
        var examType: String = "unit_test"
        var mode: String = "auto"
        var topic: String = "综合"
        var learnerCtx: String = ""
        /// 手动指定的题型配比（空=交给云端按年级题型库自动混排）
        var typeMix: [QuestionTypeMix] = []
        /// 题型库白名单（listQuestionTypes 拉回的题型名）；非空时配比只认白名单内的题型
        var allowedTypeNames: Set<String> = []
    }

    func gen(_ p: GenParams) async throws -> ExamDetail {
        // 手动配比优先：题量以配比合计为准（避免「题量10 / 配比共6」自相矛盾）
        let allowed: Set<String>? = p.allowedTypeNames.isEmpty ? nil : p.allowedTypeNames
        let mixPayload = QuestionTypeMixHelper.payload(p.typeMix, allowed: allowed)
        let mixTotal = QuestionTypeMixHelper.total(p.typeMix, allowed: allowed)
        var scope: [String: Any] = ["mode": p.mode,
                                    "count": mixTotal > 0 ? mixTotal : p.count,
                                    "difficulty": p.difficulty, "examType": p.examType,
                                    "topic": p.topic]
        if !mixPayload.isEmpty { scope["questionTypes"] = mixPayload }
        let payload: [String: Any] = [
            "subject": p.subject,
            "grade": p.grade,
            "clientId": "exam_ipad_" + String(Int(Date().timeIntervalSince1970 * 1000)),
            "createdBy": "ipad",
            "scope": scope,
            "planCtx": [String: Any](),
            "learnerCtx": p.learnerCtx
        ]
        let r: GetExamResponse = try await client.call("gen", payload, as: GetExamResponse.self)
        guard let exam = r.exam else { throw APIError(code: "parse_error", message: "出卷结果解析失败") }
        return exam
    }

    // MARK: 批改

    func grade(examClientId: String, answers: [AnswerRecord]) async throws -> (Submission, Int) {
        let payload: [String: Any] = [
            "examClientId": examClientId,
            "answers": answers.map { a -> [String: Any] in
                var m: [String: Any] = ["qid": a.qid, "text": a.text]
                if !a.imageRefs.isEmpty { m["imageRefs"] = a.imageRefs }
                // 手写图：base64 交云函数代传云存储（客户端无云存储直传凭据）
                if let b64 = a.imageBase64, !b64.isEmpty { m["imageBase64"] = b64 }
                return m
            },
            "route": "",
            "submissionClientId": "sub_ipad_" + String(Int(Date().timeIntervalSince1970 * 1000))
        ]
        let r: GradeResponse = try await client.call("grade", payload, as: GradeResponse.self)
        guard let sub = r.submission else { throw APIError(code: "grade_error", message: "批改未返回结果") }
        return (sub, r.mistakesAdded)
    }

    // MARK: 已回收

    func listSubmissions() async throws -> [SubmissionSummaryItem] {
        let r: ListSubmissionsResponse = try await client.call(
            "listSubmissions", as: ListSubmissionsResponse.self)
        return r.submissions ?? []
    }

    func getSubmission(clientId: String) async throws -> Submission {
        let r: GetSubmissionResponse = try await client.call(
            "getSubmission", ["submissionClientId": clientId], as: GetSubmissionResponse.self)
        guard let s = r.submission else { throw APIError(code: "not_found", message: "未找到该提交记录") }
        return s
    }

    // MARK: 视觉模型

    func listProviders() async throws -> [ProviderMeta] {
        let r: ListProvidersResponse = try await client.call("listProviders", as: ListProvidersResponse.self)
        return r.providers ?? []
    }

    func getVisionConfig() async throws -> VisionConfig? {
        let r: VisionConfigResponse = try await client.call("getVisionConfig", as: VisionConfigResponse.self)
        return r.config
    }

    func saveVisionConfig(_ cfg: VisionConfig) async throws {
        let payload: [String: Any] = [
            "provider": cfg.provider,
            "apiKey": cfg.apiKey,
            "model": cfg.model,
            "enabled": cfg.enabled
        ]
        let r: SaveVisionConfigResponse = try await client.call("saveVisionConfig", payload, as: SaveVisionConfigResponse.self)
        guard r.ok else { throw APIError(code: r.code ?? "save_error", message: r.msg ?? "保存失败") }
    }

    /// 用给定配置（不必落库）探测连通性；返回后端 sample 文本
    func testVision(_ cfg: VisionConfig) async throws -> String {
        let payload: [String: Any] = [
            "provider": cfg.provider,
            "apiKey": cfg.apiKey,
            "model": cfg.model
        ]
        let r: TestVisionResponse = try await client.call("testVision", payload, as: TestVisionResponse.self)
        guard r.ok else { throw APIError(code: r.code ?? "test_error", message: r.msg ?? "连接测试失败") }
        return r.sample ?? ""
    }

    // MARK: 上传试卷（Word/PDF）

    struct UploadParseParams {
        var rawText: String
        var subject: String
        var grade: String
        var name: String = ""
    }

    /// 上传卷文本 → AI 结构化草稿（不落库）
    func parseUpload(_ p: UploadParseParams) async throws -> ExamDraft {
        var payload: [String: Any] = ["rawText": p.rawText, "subject": p.subject, "grade": p.grade]
        if !p.name.isEmpty { payload["name"] = p.name }
        let r: ParseUploadResponse = try await client.call("parseUpload", payload, as: ParseUploadResponse.self)
        guard let draft = r.draft else {
            throw APIError(code: r.code ?? "parse_error", message: r.msg ?? "试卷解析失败")
        }
        return draft
    }

    /// COS 直传（原卷页面图 / 手写图共用）：
    /// signUpload 签发凭证（服务端白名单路径）→ PUT 文件字节直传云存储。
    /// 请求体不走网关，体积不受 ~100KB 请求体上限约束；返回云存储 fileID。
    func uploadFile(_ data: Data, kind: String, ext: String, contentType: String) async throws -> String {
        let r: SignUploadResponse = try await client.call(
            "signUpload", ["kind": kind, "ext": ext], as: SignUploadResponse.self)
        guard let m = r.upload, let url = URL(string: m.url), !m.url.isEmpty else {
            throw APIError(code: r.code ?? "sign_error", message: r.msg ?? "上传凭证签发失败")
        }
        guard !m.fileId.isEmpty else {
            throw APIError(code: "sign_error", message: "上传凭证缺少 fileId")
        }
        try await client.put(url, headers: [
            "authorization": m.authorization,
            "x-cos-meta-fileid": m.cosFileId.isEmpty ? m.fileId : m.cosFileId,
            "x-cos-security-token": m.token,
            "content-type": contentType
        ], body: data)
        return m.fileId
    }

    /// fileID 批量转临时访问 URL（原卷页面展示用）
    func fileURLs(_ fileIds: [String]) async throws -> [String] {
        guard !fileIds.isEmpty else { return [] }
        let r: FileUrlsResponse = try await client.call("fileUrls", ["fileIds": fileIds], as: FileUrlsResponse.self)
        return r.urls
    }

    /// 保存上传解析后的试卷（origin=upload，含原卷页面图）
    func saveUploadedExam(clientId: String, name: String, subject: String, subjectName: String,
                          grade: String, draft: ExamDraft, pageRefs: [String],
                          origin: String = "upload") async throws -> ExamDetail {
        let payload: [String: Any] = [
            "exam": [
                "clientId": clientId,
                "name": name,
                "subject": subject,
                "subjectName": subjectName,
                "grade": grade,
                "examType": draft.examType,
                "knowledgePoints": draft.knowledgePoints,
                "suggestedDuration": draft.suggestedDuration,
                "questions": draft.questions.map { q -> [String: Any] in
                    ["id": q.id, "type": q.type.rawValue, "stem": q.stem, "options": q.options,
                     "answer": q.answer, "points": q.points, "kp": q.kp, "difficulty": q.difficulty]
                },
                "answers": draft.answersMarkdown,
                "origin": origin,
                "createdBy": "ipad",
                "pageRefs": pageRefs
            ]
        ]
        let r: GetExamResponse = try await client.call("saveExam", payload, as: GetExamResponse.self)
        guard let exam = r.exam else { throw APIError(code: "save_error", message: "试卷保存失败") }
        return exam
    }

    // MARK: 批改结果复核

    struct ReviewItem {
        let qid: String
        let verdict: String   // confirm / override_correct / override_wrong
        var errorType: String = ""
        var errorDesc: String = ""
        var suggestion: String = ""
    }

    /// 逐题复核（服务端同步修正错题库，reviews[] 只追加）
    func reviewSubmission(submissionClientId: String, reviews: [ReviewItem]) async throws -> Submission {
        let payload: [String: Any] = [
            "submissionClientId": submissionClientId,
            "reviews": reviews.map { rv -> [String: Any] in
                var m: [String: Any] = ["qid": rv.qid, "verdict": rv.verdict]
                if !rv.errorType.isEmpty || !rv.errorDesc.isEmpty || !rv.suggestion.isEmpty {
                    m["diagnosis"] = ["errorType": rv.errorType, "errorDesc": rv.errorDesc, "suggestion": rv.suggestion]
                }
                return m
            }
        ]
        let r: ReviewResponse = try await client.call("reviewSubmission", payload, as: ReviewResponse.self)
        guard let sub = r.submission else {
            throw APIError(code: r.code ?? "review_error", message: r.msg ?? "复核保存失败")
        }
        return sub
    }

    // MARK: 学习闭环（iPad 新增：读 hw_farm_user 切片）

    func listCards() async throws -> [CardItem] {
        let r: ListCardsResponse = try await client.call("listCards", as: ListCardsResponse.self)
        return r.cards ?? []
    }

    func listUnits() async throws -> [UnitKp] {
        let r: ListUnitsResponse = try await client.call("listUnits", as: ListUnitsResponse.self)
        return r.units ?? []
    }

    func getUnitKps(unitId: String) async throws -> UnitKpDetail {
        let r: GetUnitKpsResponse = try await client.call(
            "getUnitKps", ["unitId": unitId], as: GetUnitKpsResponse.self)
        guard let u = r.unit else { throw APIError(code: "not_found", message: "未找到该单元必会库") }
        return u
    }

    func listPlans() async throws -> [StudyPlanSummary] {
        let r: ListPlansResponse = try await client.call("listPlans", as: ListPlansResponse.self)
        return r.plans ?? []
    }

    /// 题型库（云端 QUESTION_TYPES，学科×年级真实学校题型）；该组合暂无题型时返回空数组
    func listQuestionTypes(subject: String, grade: String) async throws -> [QuestionTypeItem] {
        let r: ListQuestionTypesResponse = try await client.call(
            "listQuestionTypes", ["subject": subject, "grade": grade],
            as: ListQuestionTypesResponse.self)
        return (r.types ?? []).filter { !$0.name.isEmpty }
    }

    /// 单元复习：按单元必会点出同类题（复用服务端的出卷+批改+错题入 tutor_mistakes 链路）
    /// questionTypes：手动题型配比（空=云端按年级题型库自动混排）
    func genUnitReview(subject: String, grade: String, unitId: String,
                       count: Int = 8, questionTypes: [QuestionTypeMix] = [],
                       allowedTypeNames: Set<String> = []) async throws -> ExamDetail {
        var payload: [String: Any] = [
            "subject": subject,
            "grade": grade,
            "unitId": unitId,
            "count": count,
            "clientId": "urev_ipad_" + String(Int(Date().timeIntervalSince1970 * 1000))
        ]
        let allowed: Set<String>? = allowedTypeNames.isEmpty ? nil : allowedTypeNames
        let mix = QuestionTypeMixHelper.payload(questionTypes, allowed: allowed)
        if !mix.isEmpty {
            payload["questionTypes"] = mix
            // 配比合计即实际题量，避免与 prompt 里的题量自相矛盾
            payload["count"] = QuestionTypeMixHelper.total(questionTypes, allowed: allowed)
        }
        let r: GetExamResponse = try await client.call("genUnitReview", payload, as: GetExamResponse.self)
        guard let exam = r.exam else { throw APIError(code: "parse_error", message: "复习卷生成失败") }
        return exam
    }

    /// 单元复习错题回顾：读 tutor_mistakes，按学科 + 单元必会点过滤
    func listMistakes(subject: String = "", topics: [String] = [], activeOnly: Bool = true) async throws -> [MistakeItem] {
        var payload: [String: Any] = ["activeOnly": activeOnly]
        if !subject.isEmpty { payload["subject"] = subject }
        if !topics.isEmpty { payload["topics"] = topics }
        let r: ListMistakesResponse = try await client.call("listMistakes", payload, as: ListMistakesResponse.self)
        return r.mistakes ?? []
    }

    // MARK: PDF 直写卷（导入 PDF → 页面手写作答 → 整页视觉阅卷）

    /// 提交 PDF 直写卷：answers 每页一条 {qid:"p1", imageRefs:[合成页图 fileID]}
    func gradePaper(examClientId: String, answers: [PaperAnswer]) async throws -> (Submission, Int) {
        let payload: [String: Any] = [
            "examClientId": examClientId,
            "answers": answers.map { ["qid": $0.qid, "imageRefs": $0.imageRefs] },
            "submissionClientId": "sub_paper_ipad_" + String(Int(Date().timeIntervalSince1970 * 1000))
        ]
        let r: GradeResponse = try await client.call("gradePaper", payload, as: GradeResponse.self)
        guard let sub = r.submission else { throw APIError(code: "grade_error", message: "阅卷未返回结果") }
        return (sub, r.mistakesAdded)
    }

    // MARK: 学习闭环响应壳

    struct ListCardsResponse: Decodable { let cards: [CardItem]? }
    struct ListUnitsResponse: Decodable { let units: [UnitKp]? }
    struct GetUnitKpsResponse: Decodable { let unit: UnitKpDetail? }
    struct ListPlansResponse: Decodable { let plans: [StudyPlanSummary]? }
    struct ListMistakesResponse: Decodable { let mistakes: [MistakeItem]? }
    struct ListQuestionTypesResponse: Decodable { let types: [QuestionTypeItem]? }
}