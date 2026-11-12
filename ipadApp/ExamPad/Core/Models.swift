//
//  Models.swift
//  自助导学 · 试卷（iPad）—— 与云函数 examService 的 JSON 契约
//
//  设计约束（与小程序端严格同构）：
//  - 字段只增不改不删；缺失一律给默认值，绝不 crash
//  - choices 的 options 已在云端清洗过（无 "A. " 前缀），客户端只补一次标签
//

import Foundation

// MARK: - 题目

enum QuestionType: String, Codable, Hashable {
    case choice, fill, calc, essay, draw

    var label: String {
        switch self {
        case .choice: return "选择"
        case .fill: return "填空"
        case .calc: return "计算"
        case .essay: return "简答"
        case .draw: return "书写"
        }
    }

    /// 该题型是否需要键盘输入文本（draw 题同时支持手写与文字）
    var usesKeyboard: Bool {
        switch self {
        case .choice, .draw: return false
        case .fill, .calc, .essay: return true
        }
    }
}

// MARK: - 题图（结构化 figure）

/// 题图坐标点（原点左上、y 轴向下，单位与 FigureSpec.w/h 同尺度）
struct FigurePoint: Codable, Hashable {
    let x: Double
    let y: Double
}

/// 单个图元。云端只发 k + 该图元用得上的字段，其余保持默认值。
/// 端点：line（x1,y1,x2,y2）/ poly（pts）/ circle（cx,cy,r）/ text（x,y,t）
struct FigureItem: Codable, Hashable {
    let k: String
    let x1: Double, y1: Double, x2: Double, y2: Double
    let pts: [FigurePoint]
    let cx: Double, cy: Double, r: Double
    let x: Double, y: Double
    let t: String
    let closed: Bool, fill: Bool, dash: Bool

    private enum CodingKeys: String, CodingKey {
        case k, x1, y1, x2, y2, pts, cx, cy, r, x, y, t, closed, fill, dash
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        k = (try? c.decode(String.self, forKey: .k)) ?? ""
        x1 = (try? c.decode(Double.self, forKey: .x1)) ?? 0
        y1 = (try? c.decode(Double.self, forKey: .y1)) ?? 0
        x2 = (try? c.decode(Double.self, forKey: .x2)) ?? 0
        y2 = (try? c.decode(Double.self, forKey: .y2)) ?? 0
        // pts 兼容 [[x,y],…] 与 [{x,y},…] 两种写法
        if let raw = try? c.decode([[Double]].self, forKey: .pts) {
            pts = raw.filter { $0.count >= 2 }.map { FigurePoint(x: $0[0], y: $0[1]) }
        } else {
            pts = (try? c.decode([FigurePoint].self, forKey: .pts)) ?? []
        }
        cx = (try? c.decode(Double.self, forKey: .cx)) ?? 0
        cy = (try? c.decode(Double.self, forKey: .cy)) ?? 0
        r = (try? c.decode(Double.self, forKey: .r)) ?? 0
        x = (try? c.decode(Double.self, forKey: .x)) ?? 0
        y = (try? c.decode(Double.self, forKey: .y)) ?? 0
        t = (try? c.decode(String.self, forKey: .t)) ?? ""
        closed = (try? c.decode(Bool.self, forKey: .closed)) ?? true
        fill = (try? c.decode(Bool.self, forKey: .fill)) ?? false
        dash = (try? c.decode(Bool.self, forKey: .dash)) ?? false
    }
}

/// 一道题的题图（画布尺寸 + 图元列表）。缺失/洗空时为 nil，客户端退化为「只有题干」。
struct FigureSpec: Codable, Hashable {
    let w: Double
    let h: Double
    let items: [FigureItem]

    private enum CodingKeys: String, CodingKey { case w, h, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let dw = (try? c.decode(Double.self, forKey: .w)) ?? 160
        let dh = (try? c.decode(Double.self, forKey: .h)) ?? 120
        w = dw > 20 ? dw : 160
        h = dh > 20 ? dh : 120
        items = (try? c.decode([FigureItem].self, forKey: .items)) ?? []
    }
}

struct ExamQuestion: Codable, Identifiable, Hashable {
    let id: String
    let type: QuestionType
    let stem: String
    let options: [String]
    let answer: String
    let points: Int
    let kp: String
    let difficulty: Int
    /// 图形题的题图（结构化图元，端上原生绘制）；非图形题为 nil
    let figure: FigureSpec?

    var isChoice: Bool { type == .choice }

    /// 选项字母标签（A/B/C…），与小程序端 LABELS 一致
    func label(at index: Int) -> String {
        let letters = ["A", "B", "C", "D", "E", "F"]
        guard index >= 0 && index < letters.count else { return "?" }
        return letters[index]
    }

    /// 拼出 "A. 选项内容"（只拼一次；云端已保证 options 不带字母前缀）
    func optionText(at index: Int) -> String {
        guard index >= 0 && index < options.count else { return "" }
        return label(at: index) + ". " + options[index]
    }

    /// 正确答案落在第几个选项；非选择题返回 nil
    var correctOptionIndex: Int? {
        guard isChoice else { return nil }
        let letters = ["A", "B", "C", "D", "E", "F"]
        return letters.firstIndex(of: answer)
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, stem, options, answer, points, kp, difficulty, figure
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        let rawType = (try? c.decode(String.self, forKey: .type)) ?? "fill"
        type = QuestionType(rawValue: rawType) ?? .fill
        stem = (try? c.decode(String.self, forKey: .stem)) ?? ""
        options = (try? c.decode([String].self, forKey: .options)) ?? []
        answer = (try? c.decode(String.self, forKey: .answer)) ?? ""
        points = (try? c.decode(Int.self, forKey: .points)) ?? 0
        kp = (try? c.decode(String.self, forKey: .kp)) ?? ""
        difficulty = (try? c.decode(Int.self, forKey: .difficulty)) ?? 1
        figure = try? c.decode(FigureSpec.self, forKey: .figure)
    }

    init(id: String, type: QuestionType, stem: String, options: [String],
         answer: String, points: Int, kp: String = "", difficulty: Int = 1,
         figure: FigureSpec? = nil) {
        self.id = id; self.type = type; self.stem = stem; self.options = options
        self.answer = answer; self.points = points; self.kp = kp; self.difficulty = difficulty
        self.figure = figure
    }
}

// MARK: - 试卷

struct ExamSummary: Decodable, Identifiable, Hashable {
    var id: String { resourceId }
    let resourceId: String
    let name: String
    let subject: String
    let subjectName: String
    let examType: String
    let examTypeLabel: String
    let suggestedDuration: Int
    let origin: String
    let status: String
    let qCount: Int
    let pageCount: Int
    let updatedAt: Double

    var originLabel: String {
        switch origin {
        case "ai": return "AI 生成"
        case "manual": return "自建"
        case "upload": return "上传"
        case "workbench": return "工作台"
        case "pdf_write": return "PDF 导入"
        default: return origin
        }
    }

    var canAnswer: Bool { qCount > 0 && status != "draft" }

    private enum CodingKeys: String, CodingKey {
        case id, resourceId, name, subject, subjectName, examType, examTypeLabel
        case suggestedDuration, origin, status, qCount, pageCount, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // 兼容旧数据：resourceId 缺失时回退 id
        let rid = (try? c.decode(String.self, forKey: .resourceId)) ?? ""
        let fallback = (try? c.decode(String.self, forKey: .id)) ?? ""
        resourceId = rid.isEmpty ? fallback : rid
        name = (try? c.decode(String.self, forKey: .name)) ?? "未命名考卷"
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        examType = (try? c.decode(String.self, forKey: .examType)) ?? ""
        examTypeLabel = ((try? c.decode(String.self, forKey: .examTypeLabel)) ?? "").nonEmpty ?? examType
        suggestedDuration = (try? c.decode(Int.self, forKey: .suggestedDuration)) ?? 0
        origin = (try? c.decode(String.self, forKey: .origin)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? ""
        qCount = (try? c.decode(Int.self, forKey: .qCount)) ?? 0
        pageCount = (try? c.decode(Int.self, forKey: .pageCount)) ?? 0
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
    }
}

struct ExamDetail: Decodable, Hashable {
    var clientId: String { resourceId }
    let resourceId: String
    let name: String
    let subject: String
    let subjectName: String
    let answers: String
    let questions: [ExamQuestion]
    /// 上传试卷的原卷页面图（云存储 fileID；AI/手建卷为空）
    let pageRefs: [String]

    private enum CodingKeys: String, CodingKey {
        case id, resourceId, name, subject, subjectName, answers, questions, pageRefs
    }

    /// 显式成员初始化（自定义 init(from:) 会抑制成员初始化器的合成）
    init(resourceId: String, name: String, subject: String, subjectName: String,
         answers: String, questions: [ExamQuestion], pageRefs: [String] = []) {
        self.resourceId = resourceId
        self.name = name
        self.subject = subject
        self.subjectName = subjectName
        self.answers = answers
        self.questions = questions
        self.pageRefs = pageRefs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rid = (try? c.decode(String.self, forKey: .resourceId)) ?? ""
        let fallback = (try? c.decode(String.self, forKey: .id)) ?? ""
        resourceId = rid.isEmpty ? fallback : rid
        name = (try? c.decode(String.self, forKey: .name)) ?? "未命名考卷"
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        answers = (try? c.decode(String.self, forKey: .answers)) ?? ""
        questions = (try? c.decode([ExamQuestion].self, forKey: .questions)) ?? []
        pageRefs = (try? c.decode([String].self, forKey: .pageRefs)) ?? []
    }
}

// MARK: - 批改

struct Diagnosis: Codable, Hashable {
    let errorType: String
    let errorDesc: String
    let suggestion: String

    private enum CodingKeys: String, CodingKey {
        case errorType, errorDesc, suggestion
    }

    init(errorType: String = "", errorDesc: String = "", suggestion: String = "") {
        self.errorType = errorType; self.errorDesc = errorDesc; self.suggestion = suggestion
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        errorType = (try? c.decode(String.self, forKey: .errorType)) ?? ""
        errorDesc = (try? c.decode(String.self, forKey: .errorDesc)) ?? ""
        suggestion = (try? c.decode(String.self, forKey: .suggestion)) ?? ""
    }

    /// E1–E9 错因中文名（与小程序 mistakeRules.ERROR_TYPES 同口径）
    var errorTypeName: String {
        let map = [
            "E1": "审题", "E2": "概念", "E3": "表征", "E4": "关系", "E5": "证据",
            "E6": "推理", "E7": "信息处理", "E8": "表达", "E9": "检查迁移"
        ]
        return errorType.isEmpty ? "" : (map[errorType] ?? errorType)
    }

    var display: String {
        if errorType.isEmpty { return errorType }
        return errorTypeName.isEmpty ? errorType : "\(errorType) \(errorTypeName)"
    }
}

/// 人工复核标记（reviewSubmission 写回；旧数据缺失为 nil）
struct ReviewMark: Codable, Hashable {
    let verdict: String
    let reviewedAt: Double?

    var label: String {
        switch verdict {
        case "confirm": return "已确认"
        case "override_correct": return "改判正确"
        case "override_wrong": return "改判错误"
        default: return verdict
        }
    }
}

struct GradeResultItem: Codable, Hashable {
    let qid: String
    let correct: Bool
    let score: Double
    let ocrText: String
    let diagnosis: Diagnosis
    let review: ReviewMark?
}

struct AnswerRecord: Codable, Hashable {
    let qid: String
    let text: String
    let imageRefs: [String]
    /// iPad 手写图 base64 直传（云函数代传云存储后转成 imageRefs）；提交后不落库
    let imageBase64: String?

    init(qid: String, text: String, imageRefs: [String] = [], imageBase64: String? = nil) {
        self.qid = qid
        self.text = text
        self.imageRefs = imageRefs
        self.imageBase64 = imageBase64
    }
}

/// 提交记录总评（字段与云端 summary 严格一致）
struct GradeSummary: Decodable, Hashable {
    let total: Int
    let correctCount: Int
    let totalPoints: Int
    let gotPoints: Double
    let rate: Int
    let weaknesses: [String]
    let advice: String

    /// 显式成员初始化（自定义 init(from:) 会抑制成员初始化器的合成）
    init(total: Int, correctCount: Int, totalPoints: Int, gotPoints: Double,
         rate: Int, weaknesses: [String], advice: String) {
        self.total = total
        self.correctCount = correctCount
        self.totalPoints = totalPoints
        self.gotPoints = gotPoints
        self.rate = rate
        self.weaknesses = weaknesses
        self.advice = advice
    }

    private enum CodingKeys: String, CodingKey {
        case total, correctCount, totalPoints, gotPoints, rate, weaknesses, advice
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = (try? c.decode(Int.self, forKey: .total)) ?? 0
        correctCount = (try? c.decode(Int.self, forKey: .correctCount)) ?? 0
        totalPoints = (try? c.decode(Int.self, forKey: .totalPoints)) ?? 0
        gotPoints = (try? c.decode(Double.self, forKey: .gotPoints)) ?? 0
        rate = (try? c.decode(Int.self, forKey: .rate)) ?? 0
        weaknesses = (try? c.decode([String].self, forKey: .weaknesses)) ?? []
        advice = (try? c.decode(String.self, forKey: .advice)) ?? ""
    }
}

struct Submission: Decodable, Hashable, Identifiable {
    var id: String { clientId.isEmpty ? examClientId : clientId }
    let clientId: String
    let examClientId: String
    let examName: String
    let subject: String
    let subjectName: String
    let route: String
    let answers: [AnswerRecord]
    let results: [GradeResultItem]
    let summary: GradeSummary
    let createdAt: Double
    /// 人工复核时间（做过复核的提交才有）
    let reviewedAt: Double?

    private enum CodingKeys: String, CodingKey {
        case clientId, examClientId, examName, subject, subjectName, route
        case answers, results, summary, createdAt, reviewedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientId = (try? c.decode(String.self, forKey: .clientId)) ?? ""
        examClientId = (try? c.decode(String.self, forKey: .examClientId)) ?? ""
        examName = (try? c.decode(String.self, forKey: .examName)) ?? ""
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        route = (try? c.decode(String.self, forKey: .route)) ?? "text"
        answers = (try? c.decode([AnswerRecord].self, forKey: .answers)) ?? []
        results = (try? c.decode([GradeResultItem].self, forKey: .results)) ?? []
        summary = (try? c.decode(GradeSummary.self, forKey: .summary))
            ?? GradeSummary(total: 0, correctCount: 0, totalPoints: 0, gotPoints: 0,
                            rate: 0, weaknesses: [], advice: "")
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        reviewedAt = try? c.decode(Double.self, forKey: .reviewedAt)
    }
}

struct SubmissionSummaryItem: Decodable, Identifiable, Hashable {
    var id: String { clientId }
    let clientId: String
    let examClientId: String
    let examName: String
    let subjectName: String
    let summary: GradeSummary
    let createdAt: Double

    private enum CodingKeys: String, CodingKey {
        case clientId, examClientId, examName, subjectName, summary, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientId = (try? c.decode(String.self, forKey: .clientId)) ?? ""
        examClientId = (try? c.decode(String.self, forKey: .examClientId)) ?? ""
        examName = (try? c.decode(String.self, forKey: .examName)) ?? "（已回收考卷）"
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        summary = (try? c.decode(GradeSummary.self, forKey: .summary))
            ?? GradeSummary(total: 0, correctCount: 0, totalPoints: 0, gotPoints: 0,
                            rate: 0, weaknesses: [], advice: "")
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
    }
}

// MARK: - 身份

struct Identity: Codable, Hashable {
    let openid: String
    let bound: Bool
    let kind: String

    var display: String {
        switch kind {
        case "ipad_bound": return "已绑定微信账号（数据互通）"
        case "ipad_independent": return "独立账号（数据仅本机）"
        case "wx": return "微信账号"
        default: return "未识别"
        }
    }
}

// MARK: - 视觉模型配置（手写识别用）

struct VisionConfig: Codable, Hashable {
    var provider: String
    var apiKey: String
    var model: String
    var enabled: Bool

    static let empty = VisionConfig(provider: "", apiKey: "", model: "", enabled: true)
}

// MARK: - 学习闭环（iPad 新增：读 hw_farm_user 切片）

/// 复习卡（Leitner 盒子）—— 与小程序 tutorStore.cards 同构
struct CardItem: Decodable, Identifiable, Hashable {
    let id: String
    let subject: String
    let subjectName: String
    let topic: String
    let front: String
    let back: String
    let unitId: String
    let kpId: String?
    let box: Int
    let dueAt: Double
    let done: Bool

    /// 已到期（dueAt ≤ 当前）且未毕业
    var isDue: Bool { !done && dueAt > 0 && dueAt <= Date().timeIntervalSince1970 * 1000 }

    var boxLabel: String { done ? "已毕业" : "盒子 \(box)" }

    private enum CodingKeys: String, CodingKey {
        case id, subject, subjectName, topic, front, back, unitId, kpId, box, dueAt, done
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        topic = (try? c.decode(String.self, forKey: .topic)) ?? ""
        front = (try? c.decode(String.self, forKey: .front)) ?? ""
        back = (try? c.decode(String.self, forKey: .back)) ?? ""
        unitId = (try? c.decode(String.self, forKey: .unitId)) ?? ""
        kpId = try? c.decode(String.self, forKey: .kpId)
        box = (try? c.decode(Int.self, forKey: .box)) ?? 1
        dueAt = (try? c.decode(Double.self, forKey: .dueAt)) ?? 0
        done = (try? c.decode(Bool.self, forKey: .done)) ?? false
    }
}

/// 单元必会库摘要（即「单元」清单）
struct UnitKp: Decodable, Identifiable, Hashable {
    let id: String
    let subject: String
    let subjectName: String
    let grade: String
    let title: String
    let pointCount: Int
    let updatedAt: Double

    var displayName: String { title.isEmpty ? (subjectName + " · 单元") : title }

    private enum CodingKeys: String, CodingKey {
        case id, subject, subjectName, grade, title, pointCount, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        grade = (try? c.decode(String.self, forKey: .grade)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        pointCount = (try? c.decode(Int.self, forKey: .pointCount)) ?? 0
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
    }
}

/// 单元必会库的必会点（每单元具体学习内容）
struct UnitKpPoint: Decodable, Identifiable, Hashable {
    let id: String
    let topic: String
    let front: String
    let back: String
    let order: Int

    private enum CodingKeys: String, CodingKey {
        case id, topic, front, back, order
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        topic = (try? c.decode(String.self, forKey: .topic)) ?? ""
        front = (try? c.decode(String.self, forKey: .front)) ?? ""
        back = (try? c.decode(String.self, forKey: .back)) ?? ""
        order = (try? c.decode(Int.self, forKey: .order)) ?? 0
    }
}

struct UnitKpDetail: Decodable, Hashable {
    let id: String
    let subject: String
    let subjectName: String
    let grade: String
    let title: String
    let points: [UnitKpPoint]

    private enum CodingKeys: String, CodingKey {
        case id, subject, subjectName, grade, title, points
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        grade = (try? c.decode(String.self, forKey: .grade)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        points = (try? c.decode([UnitKpPoint].self, forKey: .points)) ?? []
    }
}

/// 学习计划摘要
struct StudyPlanSummary: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let subject: String
    let subjectName: String
    let grade: String
    let units: Int
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, name, subject, subjectName, grade, units, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        grade = (try? c.decode(String.self, forKey: .grade)) ?? ""
        units = (try? c.decode(Int.self, forKey: .units)) ?? 0
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
    }
}

/// 错题条目（来自 tutor_mistakes，单元复习「错题回顾」与「掌握度」的同源数据）
struct MistakeItem: Decodable, Identifiable, Hashable {
    let id: String
    let subject: String
    let subjectName: String
    let topic: String
    let errorType: String
    let errorDesc: String
    let suggestion: String
    let questionText: String
    let status: String
    let source: String
    let markSource: String
    let createdAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, subject, subjectName, topic, errorType, errorDesc, suggestion, questionText, status, source, markSource, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        subject = (try? c.decode(String.self, forKey: .subject)) ?? ""
        subjectName = (try? c.decode(String.self, forKey: .subjectName)) ?? ""
        topic = (try? c.decode(String.self, forKey: .topic)) ?? ""
        errorType = (try? c.decode(String.self, forKey: .errorType)) ?? ""
        errorDesc = (try? c.decode(String.self, forKey: .errorDesc)) ?? ""
        suggestion = (try? c.decode(String.self, forKey: .suggestion)) ?? ""
        questionText = (try? c.decode(String.self, forKey: .questionText)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? ""
        source = (try? c.decode(String.self, forKey: .source)) ?? ""
        markSource = (try? c.decode(String.self, forKey: .markSource)) ?? ""
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
    }

    /// 是否已掌握（已订正/已毕业的不算活跃错题）
    var isActive: Bool {
        let s = status.lowercased()
        return !["resolved", "graduated", "done"].contains(s)
    }
}

// MARK: - 小工具

extension String {
    /// 空串兜底：返回自身或 fallback（用于 server 可能返回 "" 的场景）
    var nonEmpty: String? { isEmpty ? nil : self }
}

enum DateFmt {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        f.locale = Locale(identifier: "zh_CN")
        return f
    }()

    static func string(_ epochMs: Double) -> String {
        guard epochMs > 0 else { return "" }
        return formatter.string(from: Date(timeIntervalSince1970: epochMs / 1000))
    }
}