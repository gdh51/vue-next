import {
  createStructuralDirectiveTransform,
  TransformContext
} from '../transform'
import {
  NodeTypes,
  ExpressionNode,
  createSimpleExpression,
  SourceLocation,
  SimpleExpressionNode,
  createCallExpression,
  createFunctionExpression,
  createObjectExpression,
  createObjectProperty,
  ForCodegenNode,
  RenderSlotCall,
  SlotOutletNode,
  ElementNode,
  DirectiveNode,
  ForNode,
  PlainElementNode,
  createVNodeCall,
  VNodeCall,
  ForRenderListExpression,
  BlockCodegenNode,
  ForIteratorExpression,
  ConstantTypes,
  createBlockStatement,
  createCompoundExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  getInnerRange,
  findProp,
  isTemplateNode,
  isSlotOutlet,
  injectProp,
  getVNodeBlockHelper,
  getVNodeHelper,
  findDir
} from '../utils'
import {
  RENDER_LIST,
  OPEN_BLOCK,
  FRAGMENT,
  IS_MEMO_SAME
} from '../runtimeHelpers'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

// 处理v-for
export const transformFor = createStructuralDirectiveTransform(
  'for',
  (node, dir, context) => {
    const { helper, removeHelper } = context
    return processFor(node, dir, context, forNode => {
      // create the loop render function expression now, and add the
      // iterator on exit after all children have been traversed
      const renderExp = createCallExpression(helper(RENDER_LIST), [
        forNode.source
      ]) as ForRenderListExpression
      const memo = findDir(node, 'memo')
      const keyProp = findProp(node, `key`)
      const keyExp =
        keyProp &&
        (keyProp.type === NodeTypes.ATTRIBUTE
          ? createSimpleExpression(keyProp.value!.content, true)
          : keyProp.exp!)
      const keyProperty = keyProp ? createObjectProperty(`key`, keyExp!) : null

      if (
        !__BROWSER__ &&
        context.prefixIdentifiers &&
        keyProperty &&
        keyProp!.type !== NodeTypes.ATTRIBUTE
      ) {
        // #2085 process :key expression needs to be processed in order for it
        // to behave consistently for <template v-for> and <div v-for>.
        // In the case of `<template v-for>`, the node is discarded and never
        // traversed so its key expression won't be processed by the normal
        // transforms.
        keyProperty.value = processExpression(
          keyProperty.value as SimpleExpressionNode,
          context
        )
      }

        // 非浏览器
        if (!__BROWSER__ && context.prefixIdentifiers && keyProperty) {
          // #2085 process :key expression needs to be processed in order for it
          // to behave consistently for <template v-for> and <div v-for>.
          // In the case of `<template v-for>`, the node is discarded and never
          // traversed so its key expression won't be processed by the normal
          // transforms.
          keyProperty.value = processExpression(
            keyProperty.value as SimpleExpressionNode,
            context
          )
        }

        // 是否为稳定的片段
        const isStableFragment =
          // 简单表达式
          forNode.source.type === NodeTypes.SIMPLE_EXPRESSION &&
          // 非常量值
          forNode.source.constType > ConstantTypes.NOT_CONSTANT

        // 给定判定更新的patchFlag
        const fragmentFlag = isStableFragment
          ? PatchFlags.STABLE_FRAGMENT
          : keyProp
          ? PatchFlags.KEYED_FRAGMENT
          : PatchFlags.UNKEYED_FRAGMENT

        //  为for容器节点生成codegenNode
        forNode.codegenNode = createVNodeCall(
          context,
          helper(FRAGMENT),
          undefined,
          renderExp,
          fragmentFlag +
            (__DEV__ ? ` /* ${PatchFlagNames[fragmentFlag]} */` : ``),
          undefined,
          undefined,
          true /* isBlock */,
          !isStableFragment /* disableTracking */,
          false /* isComponent */,
          node.loc
        ) as ForCodegenNode

        // onExit
        return () => {
          // finish the codegen now that all children have been traversed
          // 完成codegen因为所有子节点已遍历
          let childBlock: BlockCodegenNode

          // 是否以模板为基础遍历
          const isTemplate = isTemplateNode(node)

          // 获取其子节点
          const { children } = forNode

          // check <template v-for> key placement
          // dev或非浏览器环境
          if ((__DEV__ || !__BROWSER__) && isTemplate) {
            node.children.some(c => {
              if (c.type === NodeTypes.ELEMENT) {
                const key = findProp(c, 'key')
                if (key) {
                  context.onError(
                    createCompilerError(
                      ErrorCodes.X_V_FOR_TEMPLATE_KEY_PLACEMENT,
                      key.loc
                    )
                  )
                  return true
                }
              }
            })
          }

          // 确认是否需要片段包裹，情况两种，
          // 第一种即模板包裹，有多个子节点；
          // 第二种即模板上的v-if子节点第一个不为元素，可为插值表达式、文本
          const needFragmentWrapper =
            children.length !== 1 || children[0].type !== NodeTypes.ELEMENT

          // 当前v-for节点为slot或为<template v-for><slot /></template>
          // 提取slot元素
          const slotOutlet = isSlotOutlet(node)
            ? // 当前元素是否为slot
              node
            : // 不是slot时，是否为模板且模板中存在唯一的slot元素(即下面注释情况)
            isTemplate &&
              node.children.length === 1 &&
              isSlotOutlet(node.children[0])
            ? (node.children[0] as SlotOutletNode) // api-extractor somehow fails to infer this
            : null

          // v-for的元素实际为slot元素时
          if (slotOutlet) {
            // <slot v-for="..."> or <template v-for="..."><slot/></template>

            // 获取slot元素的codegenNode
            childBlock = slotOutlet.codegenNode as RenderSlotCall

            // 当其为模板且具有key值时，将key注入到slot元素的渲染函数中
            if (isTemplate && keyProperty) {
              // <template v-for="..." :key="..."><slot/></template>
              // we need to inject the key to the renderSlot() call.
              // the props for renderSlot is passed as the 3rd argument.
              // 将key注入到slot函数的属性中
              injectProp(childBlock, keyProperty, context)
            }

            // 需要为每个迭代创建一个片段
          } else if (needFragmentWrapper) {
            // <template v-for="..."> with text or multi-elements
            // should generate a fragment block for each loop
            // 当<template v-for="...">内容为文本或多元素时，
            // 需要创建一个片段包裹
            childBlock = createVNodeCall(
              context,
              helper(FRAGMENT),
              keyProperty ? createObjectExpression([keyProperty]) : undefined,
              node.children,
              PatchFlags.STABLE_FRAGMENT +
                (__DEV__
                  ? ` /* ${PatchFlagNames[PatchFlags.STABLE_FRAGMENT]} */`
                  : ``),
              undefined,
              undefined,
              true,
              undefined,
              false /* isComponent */
            )

            // 普通元素的v-for，直接使用子节点的codegenNode
          } else {
            // Normal elemen v-for. Directly use the child's codegenNode
            // but mark it as a block.
            childBlock = (children[0] as PlainElementNode)
              .codegenNode as VNodeCall

            // 当在模板上标记key时，向子元素注入key
            if (isTemplate && keyProperty) {
              injectProp(childBlock, keyProperty, context)
            }

            // 当前子元素为block时，且创建的Fragment为稳定片段时；或都不为
            if (childBlock.isBlock !== !isStableFragment) {
              // 情况1，Block转化为Vnode
              if (childBlock.isBlock) {
                // switch from block to vnode
                removeHelper(OPEN_BLOCK)
                removeHelper(
                  getVNodeBlockHelper(context.inSSR, childBlock.isComponent)
                )

                // 反之将VNode转化为Block
              } else {
                // switch from vnode to block
                removeHelper(
                  getVNodeHelper(context.inSSR, childBlock.isComponent)
                )
              }
            }

            // 重新确定子Block是否仍为block
            childBlock.isBlock = !isStableFragment

            // 为block时引入block
            if (childBlock.isBlock) {
              helper(OPEN_BLOCK)
              helper(getVNodeBlockHelper(context.inSSR, childBlock.isComponent))

              // 反之引入VNode
            } else {
              helper(getVNodeHelper(context.inSSR, childBlock.isComponent))
            }
          }

          // 是否具有v-memo
          if (memo) {
            // 创建loop函数表达式，参数为for循环的具体值，额外加入一个_cached
            const loop = createFunctionExpression(
              createForLoopParams(forNode.parseResult, [
                createSimpleExpression(`_cached`)
              ])
            )

            // 写入函数体，具体函数体为，如果block命中缓存则返回缓存
            // 判定函数为isMemoSame
            loop.body = createBlockStatement([
              createCompoundExpression([`const _memo = (`, memo.exp!, `)`]),
              createCompoundExpression([
                `if (_cached`,
                ...(keyExp ? [` && _cached.key === `, keyExp] : []),
                ` && ${context.helperString(
                  IS_MEMO_SAME
                )}(_cached, _memo)) return _cached`
              ]),
              createCompoundExpression([`const _item = `, childBlock as any]),
              createSimpleExpression(`_item.memo = _memo`),
              createSimpleExpression(`return _item`)
            ])

            // 在list渲染函数中加入_cache
            renderExp.arguments.push(
              loop as ForIteratorExpression,
              createSimpleExpression(`_cache`),
              createSimpleExpression(String(context.cached++))
            )
          } else {
            // 否则直接创建个渲染函数即可
            renderExp.arguments.push(
              createFunctionExpression(
                createForLoopParams(forNode.parseResult),
                childBlock,
                true /* force newline */
              ) as ForIteratorExpression
            )
          }
        }
      }
    )
  }
)

// target-agnostic transform used for both Client and SSR
export function processFor(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (forNode: ForNode) => (() => void) | undefined
) {
  // 无v-for表达式报错
  if (!dir.exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_NO_EXPRESSION, dir.loc)
    )
    return
  }

  // 解析v-for的表达式内容中的各个部分内容
  const parseResult = parseForExpression(
    // can only be simple expression because vFor transform is applied
    // before expression transform.
    dir.exp as SimpleExpressionNode,
    context
  )

  // 不存在则报错
  if (!parseResult) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, dir.loc)
    )
    return
  }

  // 两个非浏览器的标识符
  const { addIdentifiers, removeIdentifiers, scopes } = context

  // 分别提取遍历数据源、遍历item、遍历的下标、遍历数据源为对象时，遍历时的下标(数组为未定义)
  const { source, value, key, index } = parseResult

  // 创建ForNode
  const forNode: ForNode = {
    type: NodeTypes.FOR,
    loc: dir.loc,
    source,
    valueAlias: value,
    keyAlias: key,

    // 遍历对象时，对象的顺序下标
    objectIndexAlias: index,
    parseResult,

    // 依然是根据当前v-for的节点取内容，过滤掉模板节点
    children: isTemplateNode(node) ? node.children : [node]
  }

  // 替换当前ast树中的当前节点
  context.replaceNode(forNode)

  // bookkeeping
  // 标记在v-for中
  scopes.vFor++

  // 非浏览器
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // scope management
    // inject identifiers to context
    value && addIdentifiers(value)
    key && addIdentifiers(key)
    index && addIdentifiers(index)
  }

  // 调用codegenNode函数
  const onExit = processCodegen && processCodegen(forNode)

  return () => {
    scopes.vFor--

    // 非浏览器
    if (!__BROWSER__ && context.prefixIdentifiers) {
      value && removeIdentifiers(value)
      key && removeIdentifiers(key)
      index && removeIdentifiers(index)
    }
    if (onExit) onExit()
  }
}

const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

export interface ForParseResult {
  source: ExpressionNode
  value: ExpressionNode | undefined
  key: ExpressionNode | undefined
  index: ExpressionNode | undefined
}

export function parseForExpression(
  input: SimpleExpressionNode,
  context: TransformContext
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content

  // 提取左值与右值
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return
  const [, LHS, RHS] = inMatch

  const result: ForParseResult = {
    // 创建ast对象
    source: createAliasExpression(
      loc,
      RHS.trim(),
      exp.indexOf(RHS, LHS.length)
    ),
    value: undefined,
    key: undefined,
    index: undefined
  }

  // 非浏览器环境
  if (!__BROWSER__ && context.prefixIdentifiers) {
    result.source = processExpression(
      result.source as SimpleExpressionNode,
      context
    )
  }

  // dev环境
  if (__DEV__ && __BROWSER__) {
    validateBrowserExpression(result.source as SimpleExpressionNode, context)
  }
  // 去掉左值空格以及括号
  let valueContent = LHS.trim().replace(stripParensRE, '').trim()
  const trimmedOffset = LHS.indexOf(valueContent)

  // 匹配key/index位，不支持该位的结构赋值
  const iteratorMatch = valueContent.match(forIteratorRE)

  if (iteratorMatch) {
    // 获取纯净的遍历item值
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    // 获取遍历的index值
    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined

    // 如果存在index值
    if (keyContent) {
      // 计算位移，创建ast对象
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      result.key = createAliasExpression(loc, keyContent, keyOffset)

      // 非浏览器
      if (!__BROWSER__ && context.prefixIdentifiers) {
        result.key = processExpression(result.key, context, true)
      }

      // dev模式
      if (__DEV__ && __BROWSER__) {
        validateBrowserExpression(
          result.key as SimpleExpressionNode,
          context,
          true
        )
      }
    }

    // 是否还存在遍历对象本身部分
    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        result.index = createAliasExpression(
          loc,
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length
          )
        )
        if (!__BROWSER__ && context.prefixIdentifiers) {
          result.index = processExpression(result.index, context, true)
        }
        if (__DEV__ && __BROWSER__) {
          validateBrowserExpression(
            result.index as SimpleExpressionNode,
            context,
            true
          )
        }
      }
    }
  }

  // 处理遍历的value值
  if (valueContent) {
    // 创建value的表达式
    result.value = createAliasExpression(loc, valueContent, trimmedOffset)

    // 非浏览器
    if (!__BROWSER__ && context.prefixIdentifiers) {
      result.value = processExpression(result.value, context, true)
    }

    // dev
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        result.value as SimpleExpressionNode,
        context,
        true
      )
    }
  }

  return result
}

function createAliasExpression(
  range: SourceLocation,
  content: string,
  offset: number
): SimpleExpressionNode {
  return createSimpleExpression(
    content,
    false,
    getInnerRange(range, offset, content.length)
  )
}

export function createForLoopParams(
  { value, key, index }: ForParseResult,
  memoArgs: ExpressionNode[] = []
): ExpressionNode[] {
  return createParamsList([value, key, index, ...memoArgs])
}

function createParamsList(
  args: (ExpressionNode | undefined)[]
): ExpressionNode[] {
  let i = args.length
  while (i--) {
    if (args[i]) break
  }

  // 创建参数，空参数用_代替
  return args
    .slice(0, i + 1)
    .map((arg, i) => arg || createSimpleExpression(`_`.repeat(i + 1), false))
}
