//
//  FigureView.swift
//  考卷 · 题图（结构化 figure 的原生绘制）
//
//  契约（与云函数 examService.normFigure / 小程序 utils/figureDraw.js 同构）：
//  - figure.w / figure.h 是逻辑画布尺寸，原点左上、y 轴向下
//  - items[] 只有四种图元：line / poly / circle / text
//  - 端上按等比缩放居中绘制，画的永远只有线、多边形、圆和短文字，不加载任何外部图片
//

import SwiftUI

struct FigureView: View {
    let spec: FigureSpec
    /// 单张题图的最大高度（两列并排的紧凑格里会传更小的值）
    var maxHeight: CGFloat = 220

    private var aspect: CGFloat {
        guard spec.w > 0, spec.h > 0 else { return 4.0 / 3.0 }
        return CGFloat(spec.w / spec.h)
    }

    var body: some View {
        Canvas { ctx, size in
            FigureRenderer.draw(spec, in: &ctx, size: size)
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(aspect, contentMode: .fit)
        .frame(maxHeight: maxHeight)
        .accessibilityLabel("题图")
    }
}

enum FigureRenderer {
    static func draw(_ spec: FigureSpec, in ctx: inout GraphicsContext, size: CGSize) {
        guard spec.w > 0, spec.h > 0, !spec.items.isEmpty else { return }
        let scale = min(size.width / spec.w, size.height / spec.h)
        guard scale > 0, scale.isFinite else { return }
        let ox = (size.width - spec.w * scale) / 2
        let oy = (size.height - spec.h * scale) / 2

        func p(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: ox + x * scale, y: oy + y * scale)
        }

        let ink = Color.primary.opacity(0.85)
        let shade = Color.accentColor.opacity(0.14)
        let lineWidth: CGFloat = 1.4

        for item in spec.items {
            switch item.k {
            case "line":
                var path = Path()
                path.move(to: p(item.x1, item.y1))
                path.addLine(to: p(item.x2, item.y2))
                ctx.stroke(path, with: .color(ink),
                           style: StrokeStyle(lineWidth: lineWidth, lineCap: .round,
                                              dash: item.dash ? [4, 3] : []))

            case "poly":
                guard item.pts.count >= 2 else { continue }
                var path = Path()
                path.move(to: p(item.pts[0].x, item.pts[0].y))
                for pt in item.pts.dropFirst() { path.addLine(to: p(pt.x, pt.y)) }
                if item.closed { path.closeSubpath() }
                if item.fill { ctx.fill(path, with: .color(shade)) }
                ctx.stroke(path, with: .color(ink),
                           style: StrokeStyle(lineWidth: lineWidth, lineJoin: .round,
                                              dash: item.dash ? [4, 3] : []))

            case "circle":
                let c = p(item.cx, item.cy)
                let r = item.r * scale
                guard r > 0 else { continue }
                let rect = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
                let path = Path(ellipseIn: rect)
                if item.fill { ctx.fill(path, with: .color(shade)) }
                ctx.stroke(path, with: .color(ink), lineWidth: lineWidth)

            case "text":
                // 标注垫白底：AI 常把标注压在边框上，不垫底会读不清
                let label = Text(item.t).font(.system(size: 13, weight: .medium)).foregroundColor(ink)
                let at = p(item.x, item.y)
                let resolved = ctx.resolve(label)
                let box = resolved.measure(in: size)
                let pad: CGFloat = 1.5
                let bg = CGRect(x: at.x - box.width / 2 - pad, y: at.y - box.height / 2 - pad,
                                width: box.width + pad * 2, height: box.height + pad * 2)
                ctx.fill(Path(roundedRect: bg, cornerRadius: 2), with: .color(.white))
                ctx.draw(resolved, at: at, anchor: .center)

            default:
                continue
            }
        }
    }
}
