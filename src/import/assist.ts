import { normalizeIsbn } from './isbn'

/**
 * 从用户粘贴的分享文字中找出候选信息（标题、作者、ISBN）。
 * 这些都来自用户自己粘贴的内容，只作为候选，由用户确认后才填入。
 */
export interface Candidates {
  title: string | null
  author: string | null
  isbn: string | null
}

export function candidatesFromText(text: string): Candidates {
  const t = text.replace(/\r/g, '')
  const title = /《([^《》\n]{1,80})》/.exec(t)?.[1]?.trim() || null
  const author =
    /(?:作者|作\s*者|著者)\s*[:：]\s*([^\s,，。;；|/《》【】()（）]{1,30})/.exec(t)?.[1] ??
    /》\s*([^\s,，。;；|/《》【】()（）]{1,20})\s*(?:著|编著|\/著)(?:[\s,，。]|$)/.exec(t)?.[1] ??
    /(?:^|[\s,，。])([^\s,，。;；|/《》【】()（）:：]{1,20})\s*(?:著|编著)(?:[\s,，。]|$)/m.exec(t)?.[1] ??
    /\bby\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})/.exec(t)?.[1] ??
    null
  let isbn: string | null = null
  for (const m of t.matchAll(/(?:ISBN(?:-1[03])?\s*[:：]?\s*)?((?:97[89][\s-]?)?\d[\d\s-]{8,15}[\dXx])/g)) {
    const n = normalizeIsbn(m[1])
    if (n) {
      isbn = n
      break
    }
  }
  return { title, author: author?.trim() || null, isbn }
}
