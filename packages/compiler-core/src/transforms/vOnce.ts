import { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { ElementNode, ForNode, IfNode, NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

const seen = new WeakSet()

export const transformOnce: NodeTransform = (node, context) => {
  // 当前节点为元素且具有v-once属性
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    if (seen.has(node) || context.inVOnce) {
      return
    }

    // 记录当前节点
    seen.add(node)
    context.inVOnce = true
    context.helper(SET_BLOCK_TRACKING)

    // 返回一个函数，用于为当前节点创建一个缓存表达式
    return () => {
      context.inVOnce = false
      const cur = context.currentNode as ElementNode | IfNode | ForNode
      if (cur.codegenNode) {
        cur.codegenNode = context.cache(cur.codegenNode, true /* isVNode */)
      }
    }
  }
}
