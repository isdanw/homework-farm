//
//  QuestionTypeMixEditor.swift
//  题型配比编辑器（出卷入口与单元复习共用）
//
//  题型清单来自云端 examService QUESTION_TYPES（唯一真相源），客户端不硬编码；
//  关闭「手动指定」→ 不回传配比，云端按年级题型库自动混排（旧行为，零回归）。
//

import SwiftUI

struct QuestionTypeMixEditor: View {
    let types: [QuestionTypeItem]
    @Binding var enabled: Bool
    @Binding var mix: [QuestionTypeMix]
    /// 目标题量（仅用于「按 N 题均分」与合计校验）
    let target: Int

    private var total: Int { QuestionTypeMixHelper.total(mix) }
    private var hints: [String: String] {
        Dictionary(uniqueKeysWithValues: types.map { ($0.name, $0.hint) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("手动指定题型配比", isOn: $enabled)

            if enabled {
                HStack(spacing: 12) {
                    Text("合计 \(total) 题")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(total == target ? Color.primary : Color.orange)
                    Spacer()
                    Button("按 \(target) 题均分") {
                        mix = QuestionTypeMixHelper.distribute(types, total: target)
                    }
                    .font(.caption)
                    Button("全清零") {
                        mix = mix.map { QuestionTypeMix(name: $0.name, count: 0) }
                    }
                    .font(.caption)
                }

                ForEach($mix) { $m in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 10) {
                            Text(m.name).font(.subheadline)
                            Spacer()
                            Stepper(value: $m.count, in: 0...20) {
                                Text("\(m.count) 题").font(.subheadline).monospacedDigit()
                            }
                        }
                        if let h = hints[m.name], !h.isEmpty {
                            Text(h).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }

                if total != target {
                    Text("实际题量以配比合计 \(total) 题为准")
                        .font(.caption2).foregroundStyle(.orange)
                }
            } else {
                // 自动模式：把本年级真实题型展示出来，家长知道会出哪些题型
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 78), spacing: 6)],
                          alignment: .leading, spacing: 6) {
                    ForEach(types) { t in
                        Text(t.name)
                            .font(.caption)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Color.secondary.opacity(0.14), in: Capsule())
                    }
                }
                Text("按本年级真实题型自动混排（题型库来自服务端，与学校试卷题型对齐）")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .onChange(of: enabled) { _, on in
            // 首次打开手动配比时给一份可预期的默认配比
            if on && QuestionTypeMixHelper.total(mix) == 0 {
                mix = QuestionTypeMixHelper.distribute(types, total: target)
            }
        }
    }
}
