/* eslint-disable no-restricted-globals */

let decoder: HTMLDivElement

// 解码浏览器html
export function decodeHtmlBrowser(raw: string, asAttr = false): string {
  // 初始化解析工具元素
  if (!decoder) {
    decoder = document.createElement('div')
  }

  // 作为属性时
  if (asAttr) {
    decoder.innerHTML = `<div foo="${raw.replace(/"/g, '&quot;')}">`
    return decoder.children[0].getAttribute('foo') as string

    // 其余情况直接作为内容然后取出
  } else {
    decoder.innerHTML = raw
    return decoder.textContent as string
  }
}
