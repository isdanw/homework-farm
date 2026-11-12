//
//  ExamPadTests.swift
//  纯逻辑单测：模型解码 / 选项标签 / 作答草稿 / API 契约 / 令牌闸
//  网络层用 URLProtocol 打桩，不依赖真实网络
//

import XCTest
import PencilKit
import SwiftUI
@testable import ExamPad

// MARK: - 打桩 URLProtocol

final class StubURLProtocol: URLProtocol {
    struct Stub {
        var statusCode: Int = 200
        var json: String
        var capturedRequest: URLRequest?
        var capturedBody: Data?
    }
    nonisolated(unsafe) static var stub: Stub?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let s = StubURLProtocol.stub else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: "stub", code: -1))
            return
        }
        StubURLProtocol.stub?.capturedRequest = request
        StubURLProtocol.stub?.capturedBody = Self.bodyData(of: request)
        let response = HTTPURLResponse(url: request.url!,
                                       statusCode: s.statusCode,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(s.json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// URLSession 会把 httpBody 搬进 httpBodyStream，直接读 httpBody 常为 nil
    private static func bodyData(of request: URLRequest) -> Data? {
        if let b = request.httpBody { return b }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            out.append(buf, count: n)
        }
        return out
    }

    static func makeClient(token: String = "TK") -> APIClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://example.test/examapi")!,
                         token: token, uid: "ipad_test", session: URLSession(configuration: cfg))
    }
}

// MARK: - 模型解码

final class ModelDecodeTests: XCTestCase {

    func testExamSummaryDecodesAndFallsBackToId() throws {
        // resourceId 缺失 → 回退 id（兼容旧数据）
        let json = """
        {"id":"exam_x","name":"数学单元测","subject":"math","subjectName":"数学",
         "examType":"unit_test","examTypeLabel":"单元测","suggestedDuration":30,
         "origin":"ai","status":"published","qCount":3,"updatedAt":1700000000000}
        """
        let e = try JSONDecoder().decode(ExamSummary.self, from: Data(json.utf8))
        XCTAssertEqual(e.resourceId, "exam_x")
        XCTAssertEqual(e.originLabel, "AI 生成")
        XCTAssertTrue(e.canAnswer)
    }

    func testMissingFieldsNeverCrash() throws {
        // 几乎全空：必须解出默认值而不是抛错
        let json = #"{"resourceId":"e1"}"#
        let e = try JSONDecoder().decode(ExamSummary.self, from: Data(json.utf8))
        XCTAssertEqual(e.resourceId, "e1")
        XCTAssertEqual(e.name, "未命名考卷")
        XCTAssertEqual(e.qCount, 0)
        XCTAssertFalse(e.canAnswer)
    }

    func testUnknownQuestionTypeFallsBackToFill() throws {
        let json = #"{"id":"q1","type":"weird","stem":"题","answer":"x"}"#
        let q = try JSONDecoder().decode(ExamQuestion.self, from: Data(json.utf8))
        XCTAssertEqual(q.type, .fill)
    }

    func testGradeSummaryPartialDecode() throws {
        let json = #"{"total":3,"correctCount":2,"rate":67}"#
        let s = try JSONDecoder().decode(GradeSummary.self, from: Data(json.utf8))
        XCTAssertEqual(s.total, 3)
        XCTAssertEqual(s.gotPoints, 0)
        XCTAssertEqual(s.weaknesses, [])
    }
}

// MARK: - 选项标签（双 A 回归）

final class OptionLabelTests: XCTestCase {

    private func question(options: [String], answer: String) -> ExamQuestion {
        ExamQuestion(id: "q1", type: .choice, stem: "题", options: options, answer: answer, points: 5)
    }

    func testLabelPrependedOnlyOnce() {
        // 云端已清洗：options 不带 "A. " 前缀
        let q = question(options: ["苹果", "香蕉", "梨子"], answer: "B")
        XCTAssertEqual(q.optionText(at: 0), "A. 苹果")
        XCTAssertEqual(q.optionText(at: 1), "B. 香蕉")
        // 关键回归：绝不能出现 "A. A. "
        XCTAssertFalse(q.optionText(at: 0).hasPrefix("A. A."))
        XCTAssertFalse(q.optionText(at: 1).contains("B. B."))
    }

    func testCorrectOptionIndex() {
        let q = question(options: ["甲", "乙", "丙"], answer: "C")
        XCTAssertEqual(q.correctOptionIndex, 2)
        XCTAssertEqual(q.answerTextForDisplay, "C. 丙")
    }

    func testOutOfRangeLabelIsSafe() {
        let q = question(options: ["甲"], answer: "A")
        XCTAssertEqual(q.optionText(at: 9), "")
        XCTAssertEqual(q.label(at: 99), "?")
    }

    func testNonChoiceHasNoCorrectIndex() {
        let q = ExamQuestion(id: "q", type: .fill, stem: "s", options: [], answer: "5", points: 1)
        XCTAssertNil(q.correctOptionIndex)
    }
}

// MARK: - 作答草稿

final class AnswerDraftTests: XCTestCase {

    private func makeDraft() -> AnswerDraft {
        let exam = ExamDetail(
            resourceId: "exam_1", name: "卷", subject: "math", subjectName: "数学", answers: "",
            questions: [
                ExamQuestion(id: "q1", type: .choice, stem: "1+1", options: ["1", "2"], answer: "B", points: 5),
                ExamQuestion(id: "q2", type: .fill, stem: "2+3=", options: [], answer: "5", points: 5),
                ExamQuestion(id: "q3", type: .draw, stem: "写一写", options: [], answer: "", points: 5)
            ])
        return AnswerDraft(exam: exam)
    }

    func testProgressAndAnsweredCount() {
        let d = makeDraft()
        XCTAssertEqual(d.total, 3)
        XCTAssertEqual(d.answeredCount, 0)
        XCTAssertFalse(d.isComplete)

        d.setChoice("B", for: "q1")
        XCTAssertEqual(d.answeredCount, 1)

        d.setText("5", for: "q2")
        XCTAssertEqual(d.answeredCount, 2)

        d.setImages(["local_draw_q3.png"], for: "q3")
        XCTAssertEqual(d.answeredCount, 3)
        XCTAssertTrue(d.isComplete)
    }

    func testWhitespaceOnlyTextIsNotAnswered() {
        let d = makeDraft()
        d.setText("   ", for: "q2")
        XCTAssertEqual(d.answeredCount, 0)
    }

    func testMakeAnswerRecordsMatchesCloudContract() throws {
        let d = makeDraft()
        d.setChoice("B", for: "q1")
        d.setText("5", for: "q2")
        let records = d.makeAnswerRecords()

        XCTAssertEqual(records.count, 3)
        XCTAssertEqual(records[0].qid, "q1")
        XCTAssertEqual(records[0].text, "B")           // choice 存字母
        XCTAssertEqual(records[1].text, "5")           // 文本题存文字
        XCTAssertTrue(records[2].imageRefs.isEmpty)   // 未上传时不得凭空有 fileID
        d.setImageBase64("data:image/jpeg;base64,QUJD", for: "q3")
        XCTAssertEqual(d.makeAnswerRecords()[2].imageBase64, "data:image/jpeg;base64,QUJD")
        // 必须能被 JSON 序列化（云函数 grade 直接吃这个结构）
        let data = try JSONEncoder().encode(records)
        XCTAssertTrue(String(data: data, encoding: .utf8)?.contains("q1") == true)
    }

    func testSubmitCheckListsUnanswered() {
        let d = makeDraft()
        d.setChoice("A", for: "q1")
        let check = d.submitCheck()
        XCTAssertTrue(check.hasUnanswered)
        XCTAssertEqual(check.unansweredTitles.count, 2)
        XCTAssertEqual(check.answered, 1)
    }
}

// MARK: - API 契约

final class APIClientTests: XCTestCase {

    func testRequestCarriesTokenAndUidAndAction() async throws {
        StubURLProtocol.stub = .init(json: #"{"ok":true,"exams":[]}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient(token: "SECRET"))
        _ = try await api.listExams()

        let req = try XCTUnwrap(StubURLProtocol.stub?.capturedRequest)
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-exam-token"), "SECRET")
        XCTAssertEqual(req.httpMethod, "POST")

        // 注意：自定义 URLProtocol 下 request.httpBody 常为 nil（URLSession 已搬进 stream），
        // 故读 stub 里从 httpBodyStream 回读出来的 capturedBody。
        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["action"] as? String, "listExams")
        XCTAssertEqual(obj["uid"] as? String, "ipad_test")   // 身份每次都带
    }

    func testUnauthorizedThrowsAPIErrorWithServerMessage() async {
        StubURLProtocol.stub = .init(json: #"{"ok":false,"code":"unauthorized","msg":"未授权请求：缺少或错误的访问令牌"}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        do {
            _ = try await api.listExams()
            XCTFail("应当抛错")
        } catch let err as APIError {
            XCTAssertEqual(err.code, "unauthorized")
            XCTAssertTrue(err.message.contains("令牌"))
            XCTAssertTrue(err.userHint.contains("设置"))
        } catch {
            XCTFail("错误类型不对：\(error)")
        }
    }

    func testNoPackErrorSurfacesItsOwnHint() async {
        StubURLProtocol.stub = .init(json: #"{"ok":false,"code":"no_pack","msg":"AI 资源包未开通"}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        do {
            _ = try await api.listExams()
            XCTFail("应当抛错")
        } catch let err as APIError {
            XCTAssertTrue(err.userHint.contains("Token Credits"))
        } catch { XCTFail("错误类型不对") }
    }

    func testGetExamDecodesQuestions() async throws {
        StubURLProtocol.stub = .init(json: """
        {"ok":true,"exam":{"resourceId":"exam_1","name":"卷","subject":"math","subjectName":"数学",
         "questions":[{"id":"q1","type":"choice","stem":"1+1","options":["1","2"],"answer":"B","points":5}]}}
        """)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        let exam = try await api.getExam(resourceId: "exam_1")
        XCTAssertEqual(exam.questions.count, 1)
        XCTAssertEqual(exam.questions[0].options, ["1", "2"])
    }

    func testGradeReturnsSubmissionAndMistakeCount() async throws {
        StubURLProtocol.stub = .init(json: """
        {"ok":true,"mistakesAdded":2,"submission":{"clientId":"sub_1","examClientId":"exam_1",
         "examName":"卷","route":"text","answers":[{"qid":"q1","text":"B","imageRefs":[]}],
         "results":[{"qid":"q1","correct":true,"score":5,"ocrText":"","diagnosis":{"errorType":"","errorDesc":"","suggestion":""}}],
         "summary":{"total":1,"correctCount":1,"totalPoints":5,"gotPoints":5,"rate":100,"weaknesses":[],"advice":"继续"}}}
        """)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        let (sub, added) = try await api.grade(
            examClientId: "exam_1",
            answers: [AnswerRecord(qid: "q1", text: "B", imageRefs: [])])
        XCTAssertEqual(added, 2)
        XCTAssertEqual(sub.summary.rate, 100)
        XCTAssertTrue(sub.results[0].correct)
    }

    func testBindPayloadCarriesTokenAndUid() async throws {
        StubURLProtocol.stub = .init(json: #"{"ok":true,"openid":"wx_openid_123"}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        let openid = try await api.bind(token: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
        XCTAssertEqual(openid, "wx_openid_123")

        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["action"] as? String, "bind")
        XCTAssertEqual(obj["token"] as? String, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
        XCTAssertEqual(obj["uid"] as? String, "ipad_test")   // 绑定必须带本机 uid
    }

    func testBindFailureSurfacesServerMessage() async {
        // 集合缺失等后端异常：必须把后端 msg 原样带出，不能吞掉
        StubURLProtocol.stub = .init(json: #"{"ok":false,"code":"bind_error","msg":"绑定失败：集合不存在"}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        do {
            _ = try await api.bind(token: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
            XCTFail("应当抛错")
        } catch let err as APIError {
            XCTAssertEqual(err.code, "bind_error")
            XCTAssertTrue(err.message.contains("集合不存在"))
        } catch { XCTFail("错误类型不对") }
    }

    // 用户可能误粘贴整条直达链接（含 ?tok=）而非裸口令；绑定前应能自动提取出裸令牌。
    func testNormalizeBindTokenExtractsFromPastedLink() {
        let bare = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        let link = "https://workbuddy-d2gsgtfvmde5c9adf-1305268412.tcloudbaseapp.com/?tok=" + bare
        XCTAssertEqual(SettingsView.normalizeBindToken(link), bare)
        // 裸口令 + 首尾空格/换行
        XCTAssertEqual(SettingsView.normalizeBindToken("  " + bare + "\n"), bare)
        // 被引号夹带
        XCTAssertEqual(SettingsView.normalizeBindToken("\"" + bare + "\""), bare)
        // 空输入仍为空
        XCTAssertEqual(SettingsView.normalizeBindToken("   "), "")
    }

    func testMalformedSuccessBodyStillThrowsRatherThanSilentlyPassing() async {
        // ok=true 但结构坏掉：必须报错，不能给出空数组冒充成功
        StubURLProtocol.stub = .init(json: #"{"ok":true,"exams":"not-an-array"}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        do {
            _ = try await api.listExams()
            XCTFail("应当抛错而不是返回空列表")
        } catch let err as APIError {
            XCTAssertEqual(err.code, "decode_error")
        } catch { XCTFail("错误类型不对") }
    }

    // gen 返回的 exam 真实结构（与云函数 genExam 实际输出同构），验证客户端解码链路不炸
    func testGenResponseDecodesExamDetail() async throws {
        let json = #"""
        {"ok":true,"exam":{
          "openid":"ipad_test","clientId":"exam_ipad_x","name":"数学·一年级上·20以内加减法 单元测",
          "subject":"math","subjectName":"数学","grade":"","examType":"unit_test",
          "knowledgePoints":["20以内不退位减法","20以内进位加法"],"suggestedDuration":20,
          "questions":[
            {"id":"q1","type":"calc","stem":"15 - 3 = ?","options":[],"answer":"12","points":20,"kp":"20以内不退位减法","difficulty":1},
            {"id":"q2","type":"choice","stem":"树上有12只鸟，飞走4只，还剩几只？","options":["8","16","9","7"],"answer":"A","points":20,"kp":"加减法应用题","difficulty":2}
          ],
          "markdown":"","rawText":"","answers":"**参考答案与解析**\n\n1. 15-3=12。\n2. 12-4=8，选 A。",
          "origin":"ai","status":"published","createdBy":"ipad","createdAt":1792591915545,"updatedAt":1792591915545,
          "resourceId":"exam_ipad_x"
        }}
        """#
        StubURLProtocol.stub = .init(json: json)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        let exam = try await api.gen(ExamAPI.GenParams(subject: "math", count: 10, difficulty: 2, examType: "unit_test"))
        XCTAssertEqual(exam.resourceId, "exam_ipad_x")
        XCTAssertEqual(exam.questions.count, 2)
        XCTAssertEqual(exam.answers, "**参考答案与解析**\n\n1. 15-3=12。\n2. 12-4=8，选 A。")
        // 选择题答案 "A" 应正确映射到正确选项索引
        let q2 = exam.questions.first(where: { $0.id == "q2" })
        XCTAssertEqual(q2?.correctOptionIndex, 0)
    }
}

// MARK: - 手写图上传链路

final class HandwritingUploadTests: XCTestCase {

    func testBase64PayloadPrefixAndSize() {
        let drawing = makeStroke()
        XCTAssertTrue(PencilExporter.hasContent(drawing))
        guard let payload = PencilExporter.base64Payload(from: drawing) else {
            return XCTFail("应能导出 base64 载荷")
        }
        XCTAssertTrue(payload.hasPrefix("data:image/jpeg;base64,"))
        XCTAssertLessThanOrEqual(payload.utf8.count, PencilExporter.maxBase64Bytes)
    }

    func testEmptyDrawingProducesNoPayload() {
        XCTAssertFalse(PencilExporter.hasContent(PKDrawing()))
        XCTAssertNil(PencilExporter.base64Payload(from: PKDrawing()))
    }

    func testDraftCarriesBase64IntoAnswerRecord() {
        let exam = ExamDetail(
            resourceId: "e", name: "卷", subject: "math", subjectName: "数学", answers: "",
            questions: [ExamQuestion(id: "q1", type: .draw, stem: "写", options: [], answer: "", points: 5)])
        let d = AnswerDraft(exam: exam)
        XCTAssertEqual(d.pendingImageCount, 0)
        XCTAssertFalse(d.isAnswered(exam.questions[0]))

        d.setImageBase64("data:image/jpeg;base64,QUJD", for: "q1")
        XCTAssertEqual(d.pendingImageCount, 1)
        XCTAssertTrue(d.isAnswered(exam.questions[0]))   // 有图即算已作答

        let rec = d.makeAnswerRecords().first
        XCTAssertEqual(rec?.imageBase64, "data:image/jpeg;base64,QUJD")
    }

    func testGradePayloadIncludesImageBase64() async throws {
        StubURLProtocol.stub = .init(json: """
        {"ok":true,"mistakesAdded":0,"imagesUploaded":1,"imagesSkipped":0,
         "submission":{"clientId":"sub_1","examClientId":"e","examName":"卷","route":"vision",
         "answers":[],"results":[],"summary":{"total":1,"correctCount":1,"totalPoints":5,"gotPoints":5,"rate":100,"weaknesses":[],"advice":""}}}
        """)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        _ = try await api.grade(examClientId: "e", answers: [
            AnswerRecord(qid: "q1", text: "", imageBase64: "data:image/jpeg;base64,QUJD")
        ])

        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let answers = try XCTUnwrap(obj["answers"] as? [[String: Any]])
        XCTAssertEqual(answers.first?["imageBase64"] as? String, "data:image/jpeg;base64,QUJD")
    }

    /// 回归（2026-10-24 真机事故）：PKDrawing.image() 是透明底，JPEG 无 alpha 会被压成
    /// 纯黑 → 上传的笔迹图全黑、视觉模型什么都识别不到。导出必须垫白底。
    func testJpegExportHasWhiteBackgroundNotBlack() throws {
        // 笔迹避开角落，让 (2,2) 像素落在背景上
        func point(_ x: CGFloat, _ y: CGFloat) -> PKStrokePoint {
            PKStrokePoint(location: CGPoint(x: x, y: y),
                          timeOffset: 0,
                          size: CGSize(width: 4, height: 4),
                          opacity: 1, force: 1,
                          azimuth: 0, altitude: .pi / 2)
        }
        var d = PKDrawing()
        d.strokes = [PKStroke(ink: PKInk(.pen, color: .black),
                              path: PKStrokePath(controlPoints: [point(60, 60), point(240, 150)],
                                                 creationDate: Date()))]
        let data = try XCTUnwrap(PencilExporter.jpegData(from: d))
        let img = try XCTUnwrap(UIImage(data: data))
        let cg = try XCTUnwrap(img.cgImage)

        var pixel = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8,
                            bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: -2, y: -CGFloat(cg.height) + 2, width: CGFloat(cg.width), height: CGFloat(cg.height)))
        // 修复前此处为 (0,0,0) 纯黑；修复后应为白底
        XCTAssertGreaterThan(pixel[0], 240, "R 应接近 255（白底），实际 \(pixel)")
        XCTAssertGreaterThan(pixel[1], 240, "G 应接近 255（白底），实际 \(pixel)")
        XCTAssertGreaterThan(pixel[2], 240, "B 应接近 255（白底），实际 \(pixel)")
    }

    private func makeStroke() -> PKDrawing {
        func point(_ x: CGFloat, _ y: CGFloat, _ t: TimeInterval) -> PKStrokePoint {
            PKStrokePoint(location: CGPoint(x: x, y: y),
                          timeOffset: t,
                          size: CGSize(width: 4, height: 4),
                          opacity: 1, force: 1,
                          azimuth: 0, altitude: .pi / 2)
        }
        var d = PKDrawing()
        d.strokes = [PKStroke(ink: PKInk(.pen, color: .black),
                              path: PKStrokePath(controlPoints: [
                                point(0, 0, 0),
                                point(400, 300, 0.1)
                              ], creationDate: Date()))]
        return d
    }
}

// MARK: - 错因标签

final class DiagnosisTests: XCTestCase {

    func testErrorTypeNamesMatchMiniProgramTaxonomy() {
        // 与 mistakeRules.ERROR_TYPES 同口径（E7 = 信息处理，不是「运算」）
        XCTAssertEqual(Diagnosis(errorType: "E1").errorTypeName, "审题")
        XCTAssertEqual(Diagnosis(errorType: "E7").errorTypeName, "信息处理")
        XCTAssertEqual(Diagnosis(errorType: "E9").errorTypeName, "检查迁移")
        XCTAssertEqual(Diagnosis(errorType: "E1").display, "E1 审题")
        XCTAssertEqual(Diagnosis().display, "")
    }
}

// MARK: - 题型库配比（云端 QUESTION_TYPES 接入）

final class QuestionTypeMixTests: XCTestCase {

    private func sampleTypes() -> [QuestionTypeItem] {
        [QuestionTypeItem(name: "口算", hint: "直接写算式", type: "calc"),
         QuestionTypeItem(name: "解决问题", hint: "生活情境", type: "essay"),
         QuestionTypeItem(name: "比大小", hint: "填 >< =", type: "fill")]
    }

    func testDistributeIsDeterministicAndSumsToTarget() {
        let mix = QuestionTypeMixHelper.distribute(sampleTypes(), total: 8)
        XCTAssertEqual(QuestionTypeMixHelper.total(mix), 8)
        XCTAssertEqual(mix.map(\.count), [3, 3, 2])   // 轮转分配：前两个题型各多 1 题
    }

    func testDistributeEdgeCases() {
        XCTAssertTrue(QuestionTypeMixHelper.distribute([], total: 8).isEmpty)
        XCTAssertTrue(QuestionTypeMixHelper.distribute(sampleTypes(), total: 0).isEmpty)
        let one = QuestionTypeMixHelper.distribute(sampleTypes(), total: 2)
        XCTAssertEqual(one.map(\.count), [1, 1])      // 题量少于题型数时不留 0 题项
    }

    func testPayloadDropsInvalidEntries() {
        let payload = QuestionTypeMixHelper.payload([
            QuestionTypeMix(name: "口算", count: 4),
            QuestionTypeMix(name: "零题", count: 0),
            QuestionTypeMix(name: "", count: 3)
        ])
        XCTAssertEqual(payload.count, 1)
        XCTAssertEqual(payload.first?["name"] as? String, "口算")
        XCTAssertEqual(payload.first?["count"] as? Int, 4)
    }

    func testTypeItemDecodesWithFallbacks() throws {
        let json = #"{"ok":true,"subject":"math","grade":"一年级","types":[{"name":"口算","hint":"h","type":"calc"},{"name":"缺字段"}]}"#
        let data = Data(json.utf8)
        let r = try JSONDecoder().decode(ExamAPI.ListQuestionTypesResponse.self, from: data)
        let types = r.types ?? []
        XCTAssertEqual(types.count, 2)
        XCTAssertEqual(types[0].type, "calc")
        XCTAssertEqual(types[1].type, "fill")   // 缺 type 兜底 fill，不 crash
    }

    func testGenCarriesQuestionTypesAndCountFollowsMix() async throws {
        StubURLProtocol.stub = .init(json: #"{"ok":true,"exam":{"resourceId":"r1"}}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        var p = ExamAPI.GenParams(subject: "math", grade: "一年级", count: 10)
        p.typeMix = [QuestionTypeMix(name: "口算", count: 4),
                     QuestionTypeMix(name: "解决问题", count: 2),
                     QuestionTypeMix(name: "库外题型", count: 3)]
        // 白名单=题型库（客户端口径与云端 normTypeMix 对齐：库外题型不算进题量）
        p.allowedTypeNames = ["口算", "解决问题", "比大小"]
        _ = try await api.gen(p)

        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let scope = try XCTUnwrap(obj["scope"] as? [String: Any])
        XCTAssertEqual(scope["count"] as? Int, 6)     // 配比合计（4+2）优先于题量 10
        let mix = try XCTUnwrap(scope["questionTypes"] as? [[String: Any]])
        XCTAssertEqual(mix.count, 2)                  // 库外题型被剔除
        XCTAssertEqual(mix.first?["name"] as? String, "口算")
        XCTAssertEqual(mix.first?["count"] as? Int, 4)
    }

    func testMixWithoutWhitelistWouldInflateCount() async throws {
        // 反向锁：不传白名单时库外题型会被算进题量（所以两个入口都必须传 allowedTypeNames）
        StubURLProtocol.stub = .init(json: #"{"ok":true,"exam":{"resourceId":"r1b"}}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        var p = ExamAPI.GenParams(subject: "math", count: 10)
        p.typeMix = [QuestionTypeMix(name: "口算", count: 4),
                     QuestionTypeMix(name: "库外题型", count: 3)]
        _ = try await api.gen(p)
        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let scope = try XCTUnwrap(obj["scope"] as? [String: Any])
        XCTAssertEqual(scope["count"] as? Int, 7)
    }

    func testGenWithoutMixKeepsOldPayloadShape() async throws {
        StubURLProtocol.stub = .init(json: #"{"ok":true,"exam":{"resourceId":"r2"}}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        _ = try await api.gen(ExamAPI.GenParams(subject: "math", count: 10))

        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let scope = try XCTUnwrap(obj["scope"] as? [String: Any])
        XCTAssertEqual(scope["count"] as? Int, 10)
        XCTAssertNil(scope["questionTypes"])          // 自动模式不回传配比（零回归）
    }

    func testUnitReviewCarriesQuestionTypes() async throws {
        StubURLProtocol.stub = .init(json: #"{"ok":true,"exam":{"resourceId":"r3"}}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        _ = try await api.genUnitReview(subject: "chinese", grade: "一年级", unitId: "u1",
                                        count: 8,
                                        questionTypes: [QuestionTypeMix(name: "看拼音写词语", count: 5)],
                                        allowedTypeNames: ["看拼音写词语", "比一比组词"])

        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["action"] as? String, "genUnitReview")
        XCTAssertEqual(obj["count"] as? Int, 5)      // 配比合计即实际题量（与云端口径一致）
        let mix = try XCTUnwrap(obj["questionTypes"] as? [[String: Any]])
        XCTAssertEqual(mix.first?["name"] as? String, "看拼音写词语")
    }

    func testUnitReviewWithoutMixKeepsRequestedCount() async throws {
        StubURLProtocol.stub = .init(json: #"{"ok":true,"exam":{"resourceId":"r3b"}}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        _ = try await api.genUnitReview(subject: "chinese", grade: "一年级", unitId: "u1", count: 8)
        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["count"] as? Int, 8)
        XCTAssertNil(obj["questionTypes"])            // 自动模式不回传配比（零回归）
    }

    func testListQuestionTypesRequestShape() async throws {
        StubURLProtocol.stub = .init(json: #"{"ok":true,"subject":"math","grade":"一年级","types":[]}"#)
        let api = ExamAPI(client: StubURLProtocol.makeClient())
        let types = try await api.listQuestionTypes(subject: "math", grade: "一年级")
        XCTAssertTrue(types.isEmpty)                  // 无题型库 → 空，入口自动隐藏题型区

        let body = try XCTUnwrap(StubURLProtocol.stub?.capturedBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["action"] as? String, "listQuestionTypes")
        XCTAssertEqual(obj["subject"] as? String, "math")
        XCTAssertEqual(obj["grade"] as? String, "一年级")
    }
}

// MARK: - 题图（结构化 figure）

/// 题图解码 + 原生渲染。锁两件事：
///   ① 云端发来的 figure 能被容错解码（缺字段不崩、老卷无图为 nil）；
///   ② FigureView 真的把图画出来了（像素级：有墨迹、位置对、图心不被填黑），
///      未知图元只跳过不画乱东西。
final class FigureTests: XCTestCase {

    /// 真实线上出卷返回的题图（数学·五年级·图形专项，方格纸长方形）
    private let realSpec = #"{"w":120,"h":80,"items":[{"k":"poly","pts":[[20,20],[100,20],[100,60],[20,60]],"closed":true,"fill":false,"dash":false},{"k":"text","x":55,"y":15,"t":"长4格"},{"k":"text","x":105,"y":40,"t":"宽2格"}]}"#

    private func questionJSON(_ figure: String?) -> Data {
        let fig = figure.map { ",\"figure\":" + $0 } ?? ""
        let json = """
        {"id":"q2","type":"choice","stem":"如图，方格纸上有一个长方形，长占4格宽占2格，每格边长1厘米。它的周长是多少？",
         "options":["8厘米","12厘米","14厘米","16厘米"],"answer":"B","points":5,"kp":"周长","difficulty":2\(fig)}
        """
        return Data(json.utf8)
    }

    // MARK: 解码

    func testFigureDecodesRealPayload() throws {
        let q = try JSONDecoder().decode(ExamQuestion.self, from: questionJSON(realSpec))
        let fig = try XCTUnwrap(q.figure, "图形题必须解出 figure")
        XCTAssertEqual(fig.w, 120)
        XCTAssertEqual(fig.h, 80)
        XCTAssertEqual(fig.items.count, 3)
        XCTAssertEqual(fig.items[0].k, "poly")
        XCTAssertEqual(fig.items[0].pts.count, 4)
        XCTAssertEqual(fig.items[0].pts[1].x, 100)
        XCTAssertEqual(fig.items[0].closed, true)
        XCTAssertEqual(fig.items[1].t, "长4格")
        XCTAssertTrue(q.stem.contains("如图"), "题干引用了图，端上就必须能画出来")
    }

    func testQuestionWithoutFigureStaysNil() throws {
        // 老卷（figure 字段诞生前生成）与新卷的无图题都走这里
        let q = try JSONDecoder().decode(ExamQuestion.self, from: Data(#"{"id":"q1","type":"fill","stem":"2+3=","answer":"5"}"#.utf8))
        XCTAssertNil(q.figure)
    }

    func testDirtyFigureDecodesWithoutCrashing() throws {
        // 云端 normFigure 会先洗，但端上不能假设对方守约
        let dirty = #"{"items":[{"k":"img","src":"http://x/y.png"},{"k":"poly","pts":[[1]]},{"k":"line"},{"k":"text","t":""}]}"#
        let q = try JSONDecoder().decode(ExamQuestion.self, from: questionJSON(dirty))
        let fig = try XCTUnwrap(q.figure)
        XCTAssertEqual(fig.w, 160, "缺 w → 默认画布宽")
        XCTAssertEqual(fig.h, 120, "缺 h → 默认画布高")
        XCTAssertEqual(fig.items.count, 4, "图元条数保持（是否可画由渲染层判定）")
        XCTAssertEqual(fig.items[1].pts.count, 0, "单点 poly 解出空顶点")
    }

    // MARK: 渲染（像素级）

    @MainActor
    private func render(_ view: some View, size: CGSize, saveAs name: String? = nil) throws -> CGImage {
        let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height))
        renderer.scale = 1
        let img = try XCTUnwrap(renderer.cgImage, "ImageRenderer 未产出位图")
        if let name, let png = UIImage(cgImage: img).pngData() {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try? png.write(to: url)
            print("题图 PNG: \(url.path)")
        }
        return img
    }

    private struct InkStats {
        var dark = 0
        var minX = Int.max, maxX = -1, minY = Int.max, maxY = -1
        var centerIsDark = false
    }

    /// 垫白底后统计「墨迹」像素（深度 < 140）：ImageRenderer 输出透明底，
    /// 不垫白会把整张透明图误判成满屏墨迹。
    private func inkStats(_ img: CGImage) -> InkStats {
        let w = img.width, h = img.height
        var buf = [UInt8](repeating: 255, count: w * h * 4)
        guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return InkStats() }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))

        func lum(_ i: Int) -> Double {
            0.299 * Double(buf[i]) + 0.587 * Double(buf[i + 1]) + 0.114 * Double(buf[i + 2])
        }
        var s = InkStats()
        for y in 0..<h {
            for x in 0..<w {
                if lum((y * w + x) * 4) < 140 {
                    s.dark += 1
                    s.minX = min(s.minX, x); s.maxX = max(s.maxX, x)
                    s.minY = min(s.minY, y); s.maxY = max(s.maxY, y)
                }
            }
        }
        s.centerIsDark = lum(((h / 2) * w + (w / 2)) * 4) < 140
        return s
    }

    @MainActor
    func testFigureDrawsInkAtExpectedPlace() throws {
        // 只描边的矩形：160x120 画布 → 渲染在 200x150 里，缩放 1.25，
        // 边框应落在 x≈12..188、y≈12..137，图心必须留白。
        let spec = try JSONDecoder().decode(FigureSpec.self, from: Data(
            #"{"w":160,"h":120,"items":[{"k":"poly","pts":[[10,10],[150,10],[150,110],[10,110]],"closed":true}]}"#.utf8))
        let img = try render(FigureView(spec: spec).background(Color.white), size: CGSize(width: 200, height: 150))
        let s = inkStats(img)
        XCTAssertGreaterThan(s.dark, 300, "矩形描边必须画出墨迹（改图之前：整题无图，墨迹为 0）")
        XCTAssertEqual(Double(s.minX), 12.5, accuracy: 3, "左边框位置")
        XCTAssertEqual(Double(s.maxX), 187.5, accuracy: 3, "右边框位置")
        XCTAssertEqual(Double(s.minY), 12.5, accuracy: 3, "上/下边框位置之一")
        XCTAssertEqual(Double(s.maxY), 137.5, accuracy: 3, "上/下边框位置之一")
        XCTAssertFalse(s.centerIsDark, "只描边不填充：图心应留白")
    }

    @MainActor
    func testRealGeneratedFigureLooksLikeAFigure() throws {
        // 线上真实返回的题图（线框 + 两个文字标注），顺带落一张 PNG 供目视核对
        let spec = try JSONDecoder().decode(FigureSpec.self, from: Data(realSpec.utf8))
        let img = try render(FigureView(spec: spec).background(Color.white),
                             size: CGSize(width: 240, height: 160), saveAs: "figure-real.png")
        let s = inkStats(img)
        XCTAssertGreaterThan(s.dark, 300, "线框 + 标注都要有墨迹")
        XCTAssertLessThan(s.dark, 240 * 160 / 2, "不该是整块黑")
        XCTAssertFalse(s.centerIsDark, "矩形内部留白")
        // 框：spec(20,20)-(100,60) → 像素(40,40)-(200,120)；两个标注一个在框上方、一个在框右侧
        XCTAssertGreaterThan(s.maxX, 205, "右侧标注「宽2格」落在框外 → 文字确实画出来了")
        XCTAssertLessThan(s.minY, 40, "顶部标注「长4格」落在框上方")
    }

    @MainActor
    func testUnknownItemsDrawNothing() throws {
        // 反证：渲染层对未知图元只跳过。若把 switch 写成 default 乱画，
        // 或者把 items 当图片加载，这里会出现墨迹。
        let spec = try JSONDecoder().decode(FigureSpec.self, from: Data(
            #"{"w":100,"h":100,"items":[{"k":"img","src":"x"},{"k":"svg","d":"M0 0"}]}"#.utf8))
        let img = try render(FigureView(spec: spec).background(Color.white), size: CGSize(width: 200, height: 200))
        XCTAssertEqual(inkStats(img).dark, 0, "未知图元不落任何墨迹")
    }
}
