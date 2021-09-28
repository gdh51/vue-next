import {
  createStructuralDirectiveTransform,
  TransformContext,
  traverseNode
} from '../transform'
import {
  NodeTypes,
  ElementTypes,
  ElementNode,
  DirectiveNode,
  IfBranchNode,
  SimpleExpressionNode,
  createCallExpression,
  createConditionalExpression,
  createSimpleExpression,
  createObjectProperty,
  createObjectExpression,
  IfConditionalExpression,
  BlockCodegenNode,
  IfNode,
  createVNodeCall,
  AttributeNode,
  locStub,
  CacheExpression,
  ConstantTypes,
  MemoExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { FRAGMENT, CREATE_COMMENT } from '../runtimeHelpers'
import {
  injectProp,
  findDir,
  findProp,
  isBuiltInType,
  makeBlock
} from '../utils'
import { PatchFlags, PatchFlagNames } from '@vue/shared'
import { getMemoedVNodeCall } from '..'

export const transformIf =
  // 创建结构指令函数，仅满足正则表达式时，调用后面的函数
  createStructuralDirectiveTransform(
    /^(if|else|else-if)$/,
    (node, dir, context) => {
      return processIf(node, dir, context, (ifNode, branch, isRoot) => {
        // #1587: We need to dynamically increment the key based on the current
        // node's sibling nodes, since chained v-if/else branches are
        // rendered at the same depth
        // 当v-if/else在同一深度时，内部维护一个key值
        const siblings = context.parent!.children

        // 找到条件容器节点的下标
        let i = siblings.indexOf(ifNode)
        let key = 0

        // 继续向前，查找其他条件容器
        while (i-- >= 0) {
          const sibling = siblings[i]

          // 在找到时更新key值(key值总长度即全部branch的长度)
          if (sibling && sibling.type === NodeTypes.IF) {
            key += sibling.branches.length
          }
        }

        // Exit callback. Complete the codegenNode when all children have been
        // transformed.
        return () => {
          // if分支时，创建codegenNode
          if (isRoot) {
            ifNode.codegenNode = createCodegenNodeForBranch(
              branch,
              key,
              context
            ) as IfConditionalExpression

            // 其余分支
          } else {
            // attach this branch's codegen node to the v-if root.
            const parentCondition = getParentCondition(ifNode.codegenNode!)
            parentCondition.alternate = createCodegenNodeForBranch(
              branch,
              key + ifNode.branches.length - 1,
              context
            )
          }
        }
      })
    }
  )

// target-agnostic transform used for both Client and SSR
export function processIf(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (
    node: IfNode,
    branch: IfBranchNode,
    isRoot: boolean
  ) => (() => void) | undefined
) {
  // if类型指令，无表达式(空白表达式)则报错
  if (
    dir.name !== 'else' &&
    (!dir.exp || !(dir.exp as SimpleExpressionNode).content.trim())
  ) {
    const loc = dir.exp ? dir.exp.loc : node.loc
    context.onError(
      createCompilerError(ErrorCodes.X_V_IF_NO_EXPRESSION, dir.loc)
    )
    dir.exp = createSimpleExpression(`true`, false, loc)
  }

  // 非浏览器无视
  if (!__BROWSER__ && context.prefixIdentifiers && dir.exp) {
    // dir.exp can only be simple expression because vIf transform is applied
    // before expression transform.
    dir.exp = processExpression(dir.exp as SimpleExpressionNode, context)
  }

  // dev模式无视
  if (__DEV__ && __BROWSER__ && dir.exp) {
    validateBrowserExpression(dir.exp as SimpleExpressionNode, context)
  }

  // v-if创建分支
  if (dir.name === 'if') {
    // 创建v-if分支ast对象(单条分支容器)
    const branch = createIfBranch(node, dir)

    // 创建整个v-if条件容器(包容所有v-if/v-else分支)
    const ifNode: IfNode = {
      type: NodeTypes.IF,
      loc: node.loc,
      branches: [branch]
    }

    // 替换当前关注节点与原节点(并重置节点父子关系)
    context.replaceNode(ifNode)

    // 调用处理codegen函数生成codegenNode
    if (processCodegen) {
      return processCodegen(ifNode, branch, true)
    }

    // 其余else分支
  } else {
    // locate the adjacent v-if
    // 获取当前v-if的平级全部节点
    const siblings = context.parent!.children
    const comments = []

    // 找到当前具有else指令的节点
    let i = siblings.indexOf(node)

    // 向前寻找最近的v-if节点
    while (i-- >= -1) {
      const sibling = siblings[i]

      // dev模式无视
      if (__DEV__ && sibling && sibling.type === NodeTypes.COMMENT) {
        context.removeNode(sibling)
        comments.unshift(sibling)
        continue
      }

      // 如果当前遍历的节点为空文本节点，
      // 则随手移除了
      if (
        sibling &&
        sibling.type === NodeTypes.TEXT &&
        !sibling.content.trim().length
      ) {
        context.removeNode(sibling)
        continue
      }

      // 找到最近的条件容器节点
      if (sibling && sibling.type === NodeTypes.IF) {
        // Check if v-else was followed by v-else-if
        if (
          dir.name === 'else-if' &&
          sibling.branches[sibling.branches.length - 1].condition === undefined
        ) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
          )
        }

        // move the node to the if node's branches

        // 从上下文和父级中移除当前else节点，并创建分支容器
        context.removeNode()
        const branch = createIfBranch(node, dir)

        // dev模式无视
        if (
          __DEV__ &&
          comments.length &&
          // #3619 ignore comments if the v-if is direct child of <transition>
          !(
            context.parent &&
            context.parent.type === NodeTypes.ELEMENT &&
            isBuiltInType(context.parent.tag, 'transition')
          )
        ) {
          branch.children = [...comments, ...branch.children]
        }

        // check if user is forcing same key on different branches
        // dev无视
        if (__DEV__ || !__BROWSER__) {
          const key = branch.userKey
          if (key) {
            sibling.branches.forEach(({ userKey }) => {
              if (isSameKey(userKey, key)) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_IF_SAME_KEY,
                    branch.userKey!.loc
                  )
                )
              }
            })
          }
        }

        // 将当前分支加入条件容器
        sibling.branches.push(branch)

        // 为当前分支生成codegenNode
        const onExit = processCodegen && processCodegen(sibling, branch, false)
        // since the branch was removed, it will not be traversed.
        // make sure to traverse here.
        // 手动遍历节点，因为刚刚我们将其移除了，
        // 所以按外层逻辑不会在遍历其子节点
        traverseNode(branch, context)
        // call on exit
        if (onExit) onExit()
        // make sure to reset currentNode after traversal to indicate this
        // node has been removed.
        context.currentNode = null
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
        )
      }
      break
    }
  }
}

function createIfBranch(node: ElementNode, dir: DirectiveNode): IfBranchNode {
  return {
    type: NodeTypes.IF_BRANCH,
    loc: node.loc,
    condition: dir.name === 'else' ? undefined : dir.exp,
    children:
      // 当当前节点为模板且无v-for属性时，直接取其子节点即可
      node.tagType === ElementTypes.TEMPLATE && !findDir(node, 'for')
        ? node.children
        : [node],

    // 找到当前节点的key
    userKey: findProp(node, `key`)
  }
}

function createCodegenNodeForBranch(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): IfConditionalExpression | BlockCodegenNode | MemoExpression {
  // v-if/v-else-if分支的条件
  if (branch.condition) {
    return createConditionalExpression(
      branch.condition,

      // 创建子节点的codegenNode
      createChildrenCodegenNode(branch, keyIndex, context),

      // make sure to pass in asBlock: true so that the comment node call
      // closes the current block.
      // 创建函数调用表达式
      createCallExpression(context.helper(CREATE_COMMENT), [
        __DEV__ ? '"v-if"' : '""',
        'true'
      ])
    ) as IfConditionalExpression

    // else类型
  } else {
    return createChildrenCodegenNode(branch, keyIndex, context)
  }
}

function createChildrenCodegenNode(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): BlockCodegenNode | MemoExpression {
  const { helper } = context
  const keyProperty = createObjectProperty(
    `key`,
    createSimpleExpression(
      `${keyIndex}`,
      false,
      locStub,
      ConstantTypes.CAN_HOIST
    )
  )
  const { children } = branch
  const firstChild = children[0]

  // 确认是否需要片段包裹，情况两种，
  // 第一种即模板包裹，有多个子节点；
  // 第二种即模板上的v-if子节点第一个不为元素，可为插值表达式、文本
  const needFragmentWrapper =
    children.length !== 1 || firstChild.type !== NodeTypes.ELEMENT

  // 需要片段包裹时
  if (needFragmentWrapper) {
    // 如果当前子节点仅为一个v-for渲染节点
    // 即<template v-if><div v-for /></template>
    if (children.length === 1 && firstChild.type === NodeTypes.FOR) {
      // optimize away nested fragments when child is a ForNode
      // 优化掉嵌套的片段，当其为ForNode时
      // 因为其节点已经生成片段的codegenNode
      const vnodeCall = firstChild.codegenNode!

      // 向当前节点写入key属性
      injectProp(vnodeCall, keyProperty, context)
      return vnodeCall

      // 其余情况用片段包裹
    } else {
      // 默认添加的片段flag为稳定
      let patchFlag = PatchFlags.STABLE_FRAGMENT

      // 片段的patch名称
      let patchFlagText = PatchFlagNames[PatchFlags.STABLE_FRAGMENT]

      // check if the fragment actually contains a single valid child with
      // the rest being comments
      // dev模式无视
      if (
        __DEV__ &&
        children.filter(c => c.type !== NodeTypes.COMMENT).length === 1
      ) {
        patchFlag |= PatchFlags.DEV_ROOT_FRAGMENT
        patchFlagText += `, ${PatchFlagNames[PatchFlags.DEV_ROOT_FRAGMENT]}`
      }

      // 返回节点
      return createVNodeCall(
        context,
        helper(FRAGMENT),
        createObjectExpression([keyProperty]),
        children,
        patchFlag + (__DEV__ ? ` /* ${patchFlagText} */` : ``),
        undefined,
        undefined,
        true,
        false,
        false /* isComponent */,
        branch.loc
      )
    }

    // 不需要包裹时
  } else {
    const ret = (firstChild as ElementNode).codegenNode as
      | BlockCodegenNode
      | MemoExpression
    const vnodeCall = getMemoedVNodeCall(ret)
    // Change createVNode to createBlock.
    if (vnodeCall.type === NodeTypes.VNODE_CALL) {
      makeBlock(vnodeCall, context)
    }

    // inject branch key
    injectProp(vnodeCall, keyProperty, context)
    return ret
  }
}

function isSameKey(
  a: AttributeNode | DirectiveNode | undefined,
  b: AttributeNode | DirectiveNode
): boolean {
  if (!a || a.type !== b.type) {
    return false
  }
  if (a.type === NodeTypes.ATTRIBUTE) {
    if (a.value!.content !== (b as AttributeNode).value!.content) {
      return false
    }
  } else {
    // directive
    const exp = a.exp!
    const branchExp = (b as DirectiveNode).exp!
    if (exp.type !== branchExp.type) {
      return false
    }
    if (
      exp.type !== NodeTypes.SIMPLE_EXPRESSION ||
      exp.isStatic !== (branchExp as SimpleExpressionNode).isStatic ||
      exp.content !== (branchExp as SimpleExpressionNode).content
    ) {
      return false
    }
  }
  return true
}

function getParentCondition(
  node: IfConditionalExpression | CacheExpression
): IfConditionalExpression {
  while (true) {
    if (node.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
      if (node.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
        node = node.alternate
      } else {
        return node
      }
    } else if (node.type === NodeTypes.JS_CACHE_EXPRESSION) {
      node = node.value as IfConditionalExpression
    }
  }
}
