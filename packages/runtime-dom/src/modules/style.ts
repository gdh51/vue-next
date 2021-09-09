import { isString, hyphenate, capitalize, isArray } from '@vue/shared'
import { camelize } from '@vue/runtime-core'

type Style = string | Record<string, string | string[]> | null

export function patchStyle(el: Element, prev: Style, next: Style) {
  const style = (el as HTMLElement).style

  // 无样式时，直接移除style
  if (!next) {
    el.removeAttribute('style')

    // 字符串形式的style先进行格式化
  } else if (isString(next)) {
    // 前后样式的值不一样
    if (prev !== next) {
      // 获取当前原始的display样式
      const current = style.display

      // 应用新的样式
      style.cssText = next
      // indicates that the `display` of the element is controlled by `v-show`,
      // so we always keep the current `display` value regardless of the `style` value,
      // thus handing over control to `v-show`.
      // 如果存在_vod则说明当前元素由v-show控制，则无视用户规则定义的display
      if ('_vod' in el) {
        style.display = current
      }
    }

    // 对象形式时
  } else {
    // 遍历全部样式设置
    for (const key in next) {
      setStyle(style, key, next[key])
    }

    // 如果之前的样式不是字符串形式，那么需要对比现在的和之前的，
    // 移除之前的变动
    if (prev && !isString(prev)) {
      for (const key in prev) {
        if (next[key] == null) {
          setStyle(style, key, '')
        }
      }
    }
  }
}

const importantRE = /\s*!important$/

function setStyle(
  style: CSSStyleDeclaration,
  name: string,
  val: string | string[]
) {
  // 设置的值为数组时，递归调用
  if (isArray(val)) {
    val.forEach(v => setStyle(style, name, v))
  } else {
    // 自定义的名称设置
    if (name.startsWith('--')) {
      // custom property definition
      // 直接设置
      style.setProperty(name, val)
    } else {
      // 为样式自动设置前缀
      const prefixed = autoPrefix(style, name)

      // 是否设置权重
      if (importantRE.test(val)) {
        // !important
        style.setProperty(
          // 连字符化样式名称
          hyphenate(prefixed),

          // 清空原样式中的important字符
          val.replace(importantRE, ''),
          'important'
        )

        // 无权重时直接设置
      } else {
        style[prefixed as any] = val
      }
    }
  }
}

const prefixes = ['Webkit', 'Moz', 'ms']
const prefixCache: Record<string, string> = {}

function autoPrefix(style: CSSStyleDeclaration, rawName: string): string {
  // 如果缓存中有则直接取值
  const cached = prefixCache[rawName]
  if (cached) {
    return cached
  }

  // 驼峰化用户设置的style名称
  let name = camelize(rawName)

  // 出filter外，如果在stylesheet中有该名称，则缓存后并返回
  // 不存在的则说明可能是浏览器独有的特性，比如webkit-xxx
  if (name !== 'filter' && name in style) {
    return (prefixCache[rawName] = name)
  }

  // 大写名称首字母
  name = capitalize(name)

  // 查找适配浏览器的样式名称，找到时缓存并返回
  for (let i = 0; i < prefixes.length; i++) {
    const prefixed = prefixes[i] + name
    if (prefixed in style) {
      return (prefixCache[rawName] = prefixed)
    }
  }

  // 未找到时直接返回
  return rawName
}
