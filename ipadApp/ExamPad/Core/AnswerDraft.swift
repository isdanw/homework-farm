//
//  AnswerDraft.swift
//  作答草稿 —— 纯逻辑，无 UI 依赖，可单测
//
//  职责：
//  - 记录每题作答（choice 存字母；文本题存文字；draw 题存文字 + 手写图片标识）
//  - 统计进度 / 已答数
//  - 组装成云函数 grade 需要的 answers[]（结构与小程序端逐字对齐）
//

import Foundation
import Observation

@Observable
final class AnswerDraft {
    let exam: ExamDetail
    private(set) var texts: [String: String] = [:]      // qid -> 文本
    private(set) var choices: [String: String] = [:]    // qid -> "A"/"B"...
    private(set) var imageRefs: [String: [String]] = [:] // qid -> [fileID]
    private(set) var imageBase64: [String: String] = [:] // qid -> data URL（待上传）

    init(exam: ExamDetail) {
        self.exam = exam
    }

    // MARK: 读写

    func text(for qid: String) -> String { texts[qid] ?? "" }

    func setText(_ value: String, for qid: String) {
        texts[qid] = value
    }

    func choice(for qid: String) -> String? { choices[qid] }

    func setChoice(_ label: String, for qid: String) {
        choices[qid] = label
    }

    func images(for qid: String) -> [String] { imageRefs[qid] ?? [] }

    func setImages(_ refs: [String], for qid: String) {
        imageRefs[qid] = refs
    }

    /// 待上传的手写图（base64 data URL）
    func setImageBase64(_ payload: String?, for qid: String) {
        if let payload, !payload.isEmpty { imageBase64[qid] = payload }
        else { imageBase64.removeValue(forKey: qid) }
    }

    func imageBase64(for qid: String) -> String? { imageBase64[qid] }

    var pendingImageCount: Int { imageBase64.count }

    // MARK: 统计

    var total: Int { exam.questions.count }

    /// 某题是否已作答（choice 有点选；其余有非空文本，或任意题型有手写图）
    func isAnswered(_ q: ExamQuestion) -> Bool {
        if q.isChoice {
            return !(choices[q.id] ?? "").isEmpty
        }
        let hasText = !text(for: q.id).trimmingCharacters(in: .whitespaces).isEmpty
        let hasImage = !images(for: q.id).isEmpty || imageBase64[q.id] != nil
        return hasText || hasImage
    }

    var answeredCount: Int { exam.questions.filter { isAnswered($0) }.count }

    var unansweredQuestions: [ExamQuestion] { exam.questions.filter { !isAnswered($0) } }

    var isComplete: Bool { unansweredQuestions.isEmpty }

    // MARK: 组装提交

    /// 转成云函数 grade 的 answers[]（qid / text / imageRefs / imageBase64）
    /// 客户端不自行上传：base64 由云函数代传云存储后转成 fileID。
    func makeAnswerRecords() -> [AnswerRecord] {
        exam.questions.map { q in
            AnswerRecord(qid: q.id,
                         text: q.isChoice ? (choices[q.id] ?? "") : text(for: q.id),
                         imageRefs: images(for: q.id),
                         imageBase64: imageBase64[q.id])
        }
    }
}

/// 提交前的一次校验结果（交给 UI 决定是否二次确认）
struct SubmitCheck {
    let total: Int
    let answered: Int
    let unansweredTitles: [String]

    var hasUnanswered: Bool { !unansweredTitles.isEmpty }
}

extension AnswerDraft {
    func submitCheck() -> SubmitCheck {
        let un = unansweredQuestions
        return SubmitCheck(total: total,
                           answered: answeredCount,
                           unansweredTitles: un.map { q in
                               let stem = q.stem.trimmingCharacters(in: .whitespacesAndNewlines)
                               return String(stem.prefix(30)) + (stem.count > 30 ? "…" : "")
                           })
    }
}