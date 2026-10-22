import Konva from 'konva'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../db'
import { buildDrawingGroup } from './drawing'
import { textAttrs, type StudioDoc } from './elements'

/**
 * 只导出纸张范围 (0, 0)–(CANVAS_WIDTH, CANVAS_HEIGHT)。
 * 在独立的离屏 Stage 中重新绘制：没有选中框、手柄、辅助线，也不受编辑器视图缩放影响；
 * Stage 尺寸即纸张尺寸，越界部分（含纸外笔迹）自然被裁掉。
 */
export async function exportPaperPng(
  doc: StudioDoc,
  loadImage: (assetId: string) => Promise<HTMLImageElement | null>,
  pixelRatio = 2,
): Promise<{ blob: Blob; missing: number }> {
  const container = document.createElement('div')
  const stage = new Konva.Stage({ container, width: CANVAS_WIDTH, height: CANVAS_HEIGHT })
  const layer = new Konva.Layer()
  stage.add(layer)
  layer.add(new Konva.Rect({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, fill: doc.background }))

  let missing = 0
  for (const el of doc.elements) {
    const base = { x: el.x, y: el.y, rotation: el.rotation }
    if (el.type === 'image') {
      const img = await loadImage(el.assetId)
      if (!img) {
        missing++
        continue
      }
      layer.add(new Konva.Image({ ...base, image: img, width: el.width, height: el.height, opacity: el.style.opacity }))
    } else if (el.type === 'text') {
      layer.add(new Konva.Text({ ...base, ...textAttrs(el) }))
    } else {
      layer.add(buildDrawingGroup(el, pixelRatio))
    }
  }

  try {
    const blob = (await stage.toBlob({ pixelRatio, mimeType: 'image/png' })) as Blob
    return { blob, missing }
  } finally {
    stage.destroy()
  }
}
