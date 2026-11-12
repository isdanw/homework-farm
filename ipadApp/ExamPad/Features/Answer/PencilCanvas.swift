//
//  PencilCanvas.swift
//  PencilKit 桥接：Apple Pencil 手写（压感 + 防 palm rejection）
//
//  导出：PKDrawing.image(from:scale:) → PNG/JPEG Data
//  说明：手写图经 ExamAPI.uploadFile（signUpload 凭证 + COS PUT 直传）上云存储
//
//  设计：白纸作答区（真实试卷风格）。**不使用系统 PKToolPicker**——一份试卷
//        有很多个画布，共享的 PKToolPicker 会导致第一个题之后的画布抢不到
//        first responder / 工具条错乱（已实测）。改为每题自带 钢笔/橡皮/撤销/清空
//        小工具条，经 CanvasHandle 直接控制画布，多画布互不干扰、100% 可靠。
//

import SwiftUI
import PencilKit

/// 供 SwiftUI 侧按钮调用画布内部能力（切换工具 / 撤销 / 重做 / 清空）
/// 仅持有 UIKit 对象的弱引用，且所有调用都在主线程，故不标注 @MainActor。
final class CanvasHandle: ObservableObject {
    weak var canvas: PKCanvasView?

    /// 钢笔（黑色）
    func setPen(color: UIColor = .black) {
        canvas?.tool = PKInkingTool(.pen, color: color, width: 4)
    }

    /// 橡皮（按笔画整体擦除）
    func setEraser() {
        canvas?.tool = PKEraserTool(.vector)
    }

    func undo() { canvas?.undoManager?.undo() }
    func redo() { canvas?.undoManager?.redo() }

    func clear() {
        guard let cv = canvas else { return }
        cv.drawing = PKDrawing()
    }
}

/// UIViewRepresentable 包装 PKCanvasView（白纸作答区）
struct PencilCanvas: UIViewRepresentable {
    @Binding var drawing: PKDrawing
    /// 默认钢笔颜色（纸张上用黑色）
    var inkColor: UIColor = .black
    /// 外部按钮控制句柄（切换工具/撤销/清空）
    var handle: CanvasHandle?
    /// 透明背景：叠加在原卷页图上书写用（PDF 直写）。默认 false = 白纸。
    var clearBackground: Bool = false

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView()
        canvas.drawingPolicy = .pencilOnly          // 只认 Apple Pencil，手指不会误画
        canvas.backgroundColor = clearBackground ? .clear : .white  // 白纸 / 透叠原卷
        // 已知 PencilKit 问题：系统暗色模式下画布进入书写态（first responder）时
        // 内部渲染层会变黑。画布强制亮色模式，保证任何时候都是白底。
        canvas.overrideUserInterfaceStyle = .light
        canvas.isOpaque = !clearBackground
        canvas.tool = PKInkingTool(.pen, color: inkColor, width: 4)
        canvas.drawing = drawing
        canvas.delegate = context.coordinator
        canvas.alwaysBounceVertical = false
        // 暴露画布给外部句柄（工具切换/撤销/清空）
        handle?.canvas = canvas
        return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
        if canvas.drawing != drawing {
            // 避免回写死循环：仅在外部确实变了时才覆盖
            let oldDelegate = canvas.delegate
            canvas.delegate = nil
            canvas.drawing = drawing
            canvas.delegate = oldDelegate
        }
        // ⚠️ 不在此处强制设置 tool：工具切换由 CanvasHandle 的按钮控制，
        //    在 updateUIView 里重设会把用户切到橡皮的工具覆盖回钢笔。
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PKCanvasViewDelegate {
        var parent: PencilCanvas

        init(_ parent: PencilCanvas) { self.parent = parent }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            parent.drawing = canvasView.drawing
        }
    }
}

/// 导出工具（纯函数，便于单测 image 尺寸/非空判定）
enum PencilExporter {
    /// 直传路径：JPEG 压缩后经 COS PUT 直传云存储，不受网关请求体上限约束。
    /// base64Payload 仅保留作离线/降级用途（当前 App 主链路已不使用）。
    static let maxDimension: CGFloat = 1400
    static let jpegQuality: CGFloat = 0.6
    /// base64 后的字节上限（降级路径保留）
    static let maxBase64Bytes = 800 * 1024

    /// 导出为 PNG（本地留档用）。垫白底：透明底在某些查看器/链路里会显示为纯黑。
    static func pngData(from drawing: PKDrawing, scale: CGFloat = 2.0) -> Data? {
        let bounds = drawing.bounds
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        return flattenWhite(drawing.image(from: bounds, scale: scale)).pngData()
    }

    /// 是否「有内容」——空画布不参与提交
    static func hasContent(_ drawing: PKDrawing) -> Bool {
        !drawing.strokes.isEmpty
    }

    /// 缩放到长边不超过 maxDimension
    static func resize(_ image: UIImage, maxDimension: CGFloat = PencilExporter.maxDimension) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxDimension, longest > 0 else { return image }
        let ratio = maxDimension / longest
        let newSize = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: newSize)) }
    }

    /// 关键：透明底垫白。PKDrawing.image() 渲染在透明背景上，而 JPEG 无 alpha 通道，
    /// 透明像素会被压缩成纯黑 —— 黑色笔迹 + 黑底 = 全黑图，视觉模型什么都识别不到
    /// （2026-10-24 真机实测：上传的笔迹图全是纯黑，批改全靠模型照参考答案编）。
    static func flattenWhite(_ image: UIImage) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: image.size)
        return renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: image.size))
            image.draw(at: .zero)
        }
    }

    /// 导出为压缩后的 JPEG（上传用）。JPEG 无透明通道，必须先垫白底。
    static func jpegData(from drawing: PKDrawing, maxDimension: CGFloat = PencilExporter.maxDimension) -> Data? {
        let bounds = drawing.bounds
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        let image = flattenWhite(resize(drawing.image(from: bounds, scale: 2.0), maxDimension: maxDimension))
        return image.jpegData(compressionQuality: jpegQuality)
    }

    /// 转 base64（上传载荷）。超过上限返回 nil —— 调用方必须如实告知用户，不能静默截断。
    static func base64Payload(from drawing: PKDrawing) -> String? {
        guard let data = jpegData(from: drawing) else { return nil }
        guard data.count <= maxBase64Bytes else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }
}
