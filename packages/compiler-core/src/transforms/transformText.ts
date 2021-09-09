import { NodeTransform } from '../transform'
import {
  NodeTypes,
  CompoundExpressionNode,
  createCallExpression,
  CallExpression,
  ElementTypes,
  ConstantTypes
} from '../ast'
import { isText } from '../utils'
import { CREATE_TEXT } from '../runtimeHelpers'
import { PatchFlags, PatchFlagNames } from '@vue/shared'
import { getConstantType } from './hoistStatic'

// Merge adjacent text nodes and expressions into a single expression
// e.g. <div>abc {{ d }} {{ e }}</div> should have a single expression node as child.
export const transformText: NodeTransform = (node, context) => {
  // 仅在当前节点为根节点、元素节点、v-for、v-if(else)节点时处理
  if (
    node.type === NodeTypes.ROOT ||
    node.type === NodeTypes.ELEMENT ||
    node.type === NodeTypes.FOR ||
    node.type === NodeTypes.IF_BRANCH
  ) {
    // perform the transform on node exit so that all expressions have already
    // been processed.
    return () => {
      // 获取子节点
      const children = node.children
      let currentContainer: CompoundExpressionNode | undefined = undefined
      let hasText = false

      // 遍历其子节点
      for (let i = 0; i < children.length; i++) {
        const child = children[i]

        // 如果当前子节点为文本节点
        if (isText(child)) {
          hasText = true

          // 遍历之后节点，找到下一个文本节点
          for (let j = i + 1; j < children.length; j++) {
            const next = children[j]

            // 找到 相邻的 第二个文本节点
            if (isText(next)) {
              // 初始化容器
              if (!currentContainer) {
                // 将当前文本节点转化为复合节表达式
                currentContainer = children[i] = {
                  type: NodeTypes.COMPOUND_EXPRESSION,
                  loc: child.loc,
                  children: [child]
                }
              }

              // merge adjacent text node into current
              // 将相邻节点添加进去
              currentContainer.children.push(` + `, next)

              // 移除原节点
              children.splice(j, 1)
              j--

              // 遇到非文本时结束
            } else {
              currentContainer = undefined
              break
            }
          }
        }
      }

      // 子节点无文本节点时或作为根节点仅有一个子节点或当前元素无自定义指令时
      // 退出
      if (
        !hasText ||
        // if this is a plain element with a single text child, leave it
        // as-is since the runtime has dedicated fast path for this by directly
        // setting textContent of the element.
        // for component root it's always normalized anyway.
        (children.length === 1 &&
          (node.type === NodeTypes.ROOT ||
            (node.type === NodeTypes.ELEMENT &&
              node.tagType === ElementTypes.ELEMENT &&
              // #3756
              // custom directives can potentially add DOM elements arbitrarily,
              // we need to avoid setting textContent of the element at runtime
              // to avoid accidentally overwriting the DOM elements added
              // by the user through custom directives.
              !node.props.find(
                p =>
                  p.type === NodeTypes.DIRECTIVE &&
                  !context.directiveTransforms[p.name]
              ) &&
              // in compat mode, <template> tags with no special directives
              // will be rendered as a fragment so its children must be
              // converted into vnodes.
              !(__COMPAT__ && node.tag === 'template'))))
      ) {
        return
      }

      // pre-convert text nodes into createTextVNode(text) calls to avoid
      // runtime normalization.
      // 提前将文本节点转化为 createTextVnode 调用AST，避免在运行时标准化
      for (let i = 0; i < children.length; i++) {
        const child = children[i]

        // 当前节点为纯文本、插值表达式或复合表达式
        if (isText(child) || child.type === NodeTypes.COMPOUND_EXPRESSION) {
          const callArgs: CallExpression['arguments'] = []

          // createTextVNode defaults to single whitespace, so if it is a
          // single space the code could be an empty call to save bytes.
          // 如果当前节点不为纯文本或其文本内容不为单个空格才进行处理
          if (child.type !== NodeTypes.TEXT || child.content !== ' ') {
            callArgs.push(child)
          }

          // mark dynamic text with flag so it gets patched inside a block
          // 浏览器渲染下，标记动态文本的patchFlag
          if (
            !context.ssr &&
            getConstantType(child, context) === ConstantTypes.NOT_CONSTANT
          ) {
            callArgs.push(
              PatchFlags.TEXT +
                (__DEV__ ? ` /* ${PatchFlagNames[PatchFlags.TEXT]} */` : ``)
            )
          }

          // 重写当前节点AST
          children[i] = {
            type: NodeTypes.TEXT_CALL,
            content: child,
            loc: child.loc,
            codegenNode: createCallExpression(
              context.helper(CREATE_TEXT),
              callArgs
            )
          }
        }
      }
    }
  }
}
