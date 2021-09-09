import { NodeTransform } from '../transform'
import { findDir, makeBlock } from '../utils'
import {
  createCallExpression,
  createFunctionExpression,
  ElementTypes,
  MemoExpression,
  NodeTypes,
  PlainElementNode
} from '../ast'
import { WITH_MEMO } from '../runtimeHelpers'

const seen = new WeakSet()

// 处理v-memo指令
export const transformMemo: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT) {
    const dir = findDir(node, 'memo')
    if (!dir || seen.has(node)) {
      return
    }

    // 将当前节点加入已处理
    seen.add(node)

    // onExit函数，生成当前使用指令节点的codegen
    return () => {
      // 获取当前指令节点的codegenNode
      const codegenNode =
        node.codegenNode ||
        (context.currentNode as PlainElementNode).codegenNode

      // 如果当前codegen的生成节点类型为Vnode节点生成调用函数
      if (codegenNode && codegenNode.type === NodeTypes.VNODE_CALL) {
        // non-component sub tree should be turned into a block
        // 没有组件的子树应该被转化为一个block
        if (node.tagType !== ElementTypes.COMPONENT) {
          makeBlock(codegenNode, context)
        }

        // 重新codegenNode，用函数调用表达式代替
        node.codegenNode = createCallExpression(context.helper(WITH_MEMO), [
          dir.exp!,
          createFunctionExpression(undefined, codegenNode),
          `_cache`,
          String(context.cached++)
        ]) as MemoExpression
      }
    }
  }
}
