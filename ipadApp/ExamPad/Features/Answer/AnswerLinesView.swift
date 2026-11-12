//
//  AnswerLinesView.swift
//  答题线底图（方案 A）：横线 / 方格（竖式）/ 田字格（语文），手写层透明叠加其上
//
//  设计：还原纸质卷书写体验——题干下方直接是答题线，孩子写在线上。
//  底图只负责画线（无交互、不拦截触摸），PencilCanvas 以透明背景叠在其上，
//  橡皮擦只擦笔迹、不擦答题线。
//

import SwiftUI

/// 答题线样式
enum AnswerLineStyle: Equatable {
    case ruled(lines: Int)            // 横线（计算/填空/简答）
    case grid(rows: Int, cols: Int)   // 方格（竖式计算，按数位对齐）
    case tianzi(cells: Int)           // 田字格（语文写字/拼音）

    /// 书写区高度（一年级行高标准：横线 48 / 竖式方格 52 / 田字格 64）
    func height(compact: Bool = false) -> CGFloat {
        if compact { return 56 }
        switch self {
        case .ruled(let n): return CGFloat(n) * 48
        case .grid(let rows, _): return CGFloat(rows) * 52
        case .tianzi: return 64
        }
    }
}

/// 答题线底图（纯绘制）
struct AnswerLinesView: View {
    let style: AnswerLineStyle
    var lineColor: Color = Color.secondary.opacity(0.32)
    var dashColor: Color = Color.secondary.opacity(0.20)

    var body: some View {
        Canvas { context, size in
            guard size.height > 1, size.width > 1 else { return }
            switch style {
            case .ruled(let lines):
                let step = size.height / CGFloat(lines)
                for i in 0..<lines {
                    let y = CGFloat(i + 1) * step
                    drawLine(&context, from: CGPoint(x: 0, y: y), to: CGPoint(x: size.width, y: y), color: lineColor, dashed: false)
                }
            case .grid(let rows, let cols):
                for i in 1..<rows {
                    let y = CGFloat(i) * (size.height / CGFloat(rows))
                    drawLine(&context, from: CGPoint(x: 0, y: y), to: CGPoint(x: size.width, y: y), color: lineColor, dashed: false)
                }
                for j in 1..<cols {
                    let x = CGFloat(j) * (size.width / CGFloat(cols))
                    drawLine(&context, from: CGPoint(x: x, y: 0), to: CGPoint(x: x, y: size.height), color: lineColor, dashed: false)
                }
            case .tianzi(let cells):
                let gap: CGFloat = 6
                let cellW = min(size.height, (size.width - CGFloat(max(cells - 1, 0)) * gap) / CGFloat(max(cells, 1)))
                for i in 0..<cells {
                    let x = CGFloat(i) * (cellW + gap)
                    let rect = CGRect(x: x, y: (size.height - cellW) / 2, width: cellW, height: cellW)
                    context.stroke(Path(rect), with: .color(lineColor), lineWidth: 0.5)
                    drawLine(&context, from: CGPoint(x: rect.minX, y: rect.midY), to: CGPoint(x: rect.maxX, y: rect.midY), color: dashColor, dashed: true)
                    drawLine(&context, from: CGPoint(x: rect.midX, y: rect.minY), to: CGPoint(x: rect.midX, y: rect.maxY), color: dashColor, dashed: true)
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func drawLine(_ context: inout GraphicsContext, from a: CGPoint, to b: CGPoint, color: Color, dashed: Bool) {
        var path = Path()
        path.move(to: a)
        path.addLine(to: b)
        let st = dashed ? StrokeStyle(lineWidth: 0.5, dash: [4, 4]) : StrokeStyle(lineWidth: 0.5)
        context.stroke(path, with: .color(color), style: st)
    }
}
