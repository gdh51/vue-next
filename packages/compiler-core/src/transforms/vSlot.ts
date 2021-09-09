import {
  ElementNode,
  ObjectExpression,
  createObjectExpression,
  NodeTypes,
  createObjectProperty,
  createSimpleExpression,
  createFunctionExpression,
  DirectiveNode,
  ElementTypes,
  ExpressionNode,
  Property,
  TemplateChildNode,
  SourceLocation,
  createConditionalExpression,
  ConditionalExpression,
  SimpleExpressionNode,
  FunctionExpression,
  CallExpression,
  createCallExpression,
  createArrayExpression,
  SlotsExpression
} from '../ast'
import { TransformContext, NodeTransform } from '../transform'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  findDir,
  isTemplateNode,
  assert,
  isVSlot,
  hasScopeRef,
  isStaticExp
} from '../utils'
import { CREATE_SLOTS, RENDER_LIST, WITH_CTX } from '../runtimeHelpers'
import { parseForExpression, createForLoopParams } from './vFor'
import { SlotFlags, slotFlagsText } from '@vue/shared'

const defaultFallback = createSimpleExpression(`undefined`, false)

// A NodeTransform that:
// 1. Tracks scope identifiers for scoped slots so that they don't get prefixed
//    by transformExpression. This is only applied in non-browser builds with
//    { prefixIdentifiers: true }.
// 2. Track v-slot depths so that we know a slot is inside another slot.
//    Note the exit callback is executed before buildSlots() on the same node,
//    so only nested slots see positive numbers.
export const trackSlotScopes: NodeTransform = (node, context) => {
  // 组件或模板
  if (
    node.type === NodeTypes.ELEMENT &&
    (node.tagType === ElementTypes.COMPONENT ||
      node.tagType === ElementTypes.TEMPLATE)
  ) {
    // We are only checking non-empty v-slot here
    // since we only care about slots that introduce scope variables.
    // 确认元素具有v-slot属性
    const vSlot = findDir(node, 'slot')
    if (vSlot) {
      const slotProps = vSlot.exp

      // 非浏览器
      if (!__BROWSER__ && context.prefixIdentifiers) {
        slotProps && context.addIdentifiers(slotProps)
      }

      // 添加depth
      context.scopes.vSlot++
      return () => {
        if (!__BROWSER__ && context.prefixIdentifiers) {
          slotProps && context.removeIdentifiers(slotProps)
        }
        context.scopes.vSlot--
      }
    }
  }
}

// A NodeTransform that tracks scope identifiers for scoped slots with v-for.
// This transform is only applied in non-browser builds with { prefixIdentifiers: true }
export const trackVForSlotScopes: NodeTransform = (node, context) => {
  let vFor
  if (
    isTemplateNode(node) &&
    node.props.some(isVSlot) &&
    (vFor = findDir(node, 'for'))
  ) {
    const result = (vFor.parseResult = parseForExpression(
      vFor.exp as SimpleExpressionNode,
      context
    ))
    if (result) {
      const { value, key, index } = result
      const { addIdentifiers, removeIdentifiers } = context
      value && addIdentifiers(value)
      key && addIdentifiers(key)
      index && addIdentifiers(index)

      return () => {
        value && removeIdentifiers(value)
        key && removeIdentifiers(key)
        index && removeIdentifiers(index)
      }
    }
  }
}

export type SlotFnBuilder = (
  slotProps: ExpressionNode | undefined,
  slotChildren: TemplateChildNode[],
  loc: SourceLocation
) => FunctionExpression

// 创建一个函数表达式，props作为参数，children作为返回值
const buildClientSlotFn: SlotFnBuilder = (props, children, loc) =>
  createFunctionExpression(
    props,
    children,
    false /* newline */,
    true /* isSlot */,
    children.length ? children[0].loc : loc
  )

// Instead of being a DirectiveTransform, v-slot processing is called during
// transformElement to build the slots object for a component.
export function buildSlots(
  node: ElementNode,
  context: TransformContext,
  buildSlotFn: SlotFnBuilder = buildClientSlotFn
): {
  slots: SlotsExpression
  hasDynamicSlots: boolean
} {
  // 记录withCtx函数
  context.helper(WITH_CTX)

  // 获取组件节点的内容
  const { children, loc } = node

  // 所有的命名插槽都将以对象的形式被收集到此处
  const slotsProperties: Property[] = []
  const dynamicSlots: (ConditionalExpression | CallExpression)[] = []

  // If the slot is inside a v-for or another v-slot, force it to be dynamic
  // since it likely uses a scope variable.
  // 当当前插槽内容已经处于v-for或另一个插槽中，
  // 强制其为动态插槽
  let hasDynamicSlots = context.scopes.vSlot > 0 || context.scopes.vFor > 0

  // with `prefixIdentifiers: true`, this can be further optimized to make
  // it dynamic only when the slot actually uses the scope variables.
  // 非浏览器环境
  if (!__BROWSER__ && !context.ssr && context.prefixIdentifiers) {
    hasDynamicSlots = hasScopeRef(node, context.identifiers)
  }

  // 1. Check for slot with slotProps on component itself.
  //    <Comp v-slot="{ prop }"/>就是这种情况
  // 确认是否在组件上使用插槽
  const onComponentSlot = findDir(node, 'slot', true)
  if (onComponentSlot) {
    const { arg, exp } = onComponentSlot

    // 动态插槽名称
    if (arg && !isStaticExp(arg)) {
      hasDynamicSlots = true
    }

    // 创建一个对象表达式{ default: fn }
    slotsProperties.push(
      createObjectProperty(
        arg || createSimpleExpression('default', true),

        // 为插槽内容创建函数表达式
        buildSlotFn(exp, children, loc)
      )
    )
  }

  // 2. Iterate through children and check for template slots
  //    <template v-slot:foo="{ prop }">
  let hasTemplateSlots = false
  let hasNamedDefaultSlot = false

  // 默认插槽节点合集
  const implicitDefaultChildren: TemplateChildNode[] = []
  const seenSlotNames = new Set<string>()

  // 遍历组件节点，找到作为插槽的节点
  for (let i = 0; i < children.length; i++) {
    const slotElement = children[i]
    let slotDir

    // 非模板元素或不具有插槽属性的节点
    // 则视为默认插槽内容
    if (
      !isTemplateNode(slotElement) ||
      !(slotDir = findDir(slotElement, 'slot', true))
    ) {
      // not a <template v-slot>, skip.
      // 非注释节点
      if (slotElement.type !== NodeTypes.COMMENT) {
        implicitDefaultChildren.push(slotElement)
      }
      continue
    }

    // 同时在组件上使用插槽属性时，报错
    if (onComponentSlot) {
      // already has on-component slot - this is incorrect usage.
      context.onError(
        createCompilerError(ErrorCodes.X_V_SLOT_MIXED_SLOT_USAGE, slotDir.loc)
      )
      break
    }

    hasTemplateSlots = true

    // slotElement就为template
    const { children: slotChildren, loc: slotLoc } = slotElement

    const {
      arg: slotName = createSimpleExpression(`default`, true),
      exp: slotProps,
      loc: dirLoc
    } = slotDir

    // check if name is dynamic.
    // 动态插槽名称
    let staticSlotName: string | undefined
    if (isStaticExp(slotName)) {
      staticSlotName = slotName ? slotName.content : `default`
    } else {
      hasDynamicSlots = true
    }

    // 为当前命名插槽创建插槽函数
    const slotFunction = buildSlotFn(slotProps, slotChildren, slotLoc)

    // check if this slot is conditional (v-if/v-for)
    let vIf: DirectiveNode | undefined
    let vElse: DirectiveNode | undefined
    let vFor: DirectiveNode | undefined

    // 条件显示，包裹添加ast语句
    if ((vIf = findDir(slotElement, 'if'))) {
      hasDynamicSlots = true
      dynamicSlots.push(
        createConditionalExpression(
          vIf.exp!,
          buildDynamicSlot(slotName, slotFunction),
          defaultFallback
        )
      )

      // v-else(-if)
    } else if (
      (vElse = findDir(slotElement, /^else(-if)?$/, true /* allowEmpty */))
    ) {
      // find adjacent v-if
      // 找到最近的v-if
      let j = i
      let prev
      while (j--) {
        prev = children[j]
        if (prev.type !== NodeTypes.COMMENT) {
          break
        }
      }

      // 必须为模板
      if (prev && isTemplateNode(prev) && findDir(prev, 'if')) {
        // remove node
        children.splice(i, 1)
        i--
        __TEST__ && assert(dynamicSlots.length > 0)
        // attach this slot to previous conditional
        let conditional = dynamicSlots[
          dynamicSlots.length - 1
        ] as ConditionalExpression
        while (
          conditional.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
        ) {
          conditional = conditional.alternate
        }
        conditional.alternate = vElse.exp
          ? createConditionalExpression(
              vElse.exp,
              buildDynamicSlot(slotName, slotFunction),
              defaultFallback
            )
          : buildDynamicSlot(slotName, slotFunction)

        // 找不到报错
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, vElse.loc)
        )
      }
    } else if ((vFor = findDir(slotElement, 'for'))) {
      hasDynamicSlots = true
      const parseResult =
        vFor.parseResult ||
        parseForExpression(vFor.exp as SimpleExpressionNode, context)
      if (parseResult) {
        // Render the dynamic slots as an array and add it to the createSlot()
        // args. The runtime knows how to handle it appropriately.
        dynamicSlots.push(
          createCallExpression(context.helper(RENDER_LIST), [
            parseResult.source,
            createFunctionExpression(
              createForLoopParams(parseResult),
              buildDynamicSlot(slotName, slotFunction),
              true /* force newline */
            )
          ])
        )
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, vFor.loc)
        )
      }
    } else {
      // check duplicate static names
      if (staticSlotName) {
        if (seenSlotNames.has(staticSlotName)) {
          context.onError(
            createCompilerError(
              ErrorCodes.X_V_SLOT_DUPLICATE_SLOT_NAMES,
              dirLoc
            )
          )
          continue
        }
        seenSlotNames.add(staticSlotName)
        if (staticSlotName === 'default') {
          hasNamedDefaultSlot = true
        }
      }
      slotsProperties.push(createObjectProperty(slotName, slotFunction))
    }
  }

  if (!onComponentSlot) {
    const buildDefaultSlotProperty = (
      props: ExpressionNode | undefined,
      children: TemplateChildNode[]
    ) => {
      const fn = buildSlotFn(props, children, loc)
      if (__COMPAT__ && context.compatConfig) {
        fn.isNonScopedSlot = true
      }
      return createObjectProperty(`default`, fn)
    }

    if (!hasTemplateSlots) {
      // implicit default slot (on component)
      slotsProperties.push(buildDefaultSlotProperty(undefined, children))
    } else if (
      implicitDefaultChildren.length &&
      // #3766
      // with whitespace: 'preserve', whitespaces between slots will end up in
      // implicitDefaultChildren. Ignore if all implicit children are whitespaces.
      implicitDefaultChildren.some(node => isNonWhitespaceContent(node))
    ) {
      // implicit default slot (mixed with named slots)
      if (hasNamedDefaultSlot) {
        context.onError(
          createCompilerError(
            ErrorCodes.X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN,
            implicitDefaultChildren[0].loc
          )
        )
      } else {
        slotsProperties.push(
          buildDefaultSlotProperty(undefined, implicitDefaultChildren)
        )
      }
    }
  }

  // 计算slotFlag
  const slotFlag = hasDynamicSlots
    ? SlotFlags.DYNAMIC
    : // 在使用组件的插槽中，设置插槽
    hasForwardedSlots(node.children)
    ? SlotFlags.FORWARDED
    : SlotFlags.STABLE

  // 创建插槽表达式
  let slots = createObjectExpression(
    slotsProperties.concat(
      createObjectProperty(
        `_`,
        // 2 = compiled but dynamic = can skip normalization, but must run diff
        // 1 = compiled and static = can skip normalization AND diff as optimized
        createSimpleExpression(
          slotFlag + (__DEV__ ? ` /* ${slotFlagsText[slotFlag]} */` : ``),
          false
        )
      )
    ),
    loc
  ) as SlotsExpression

  // 具有动态插槽时，创建新的调用表达式
  if (dynamicSlots.length) {
    slots = createCallExpression(context.helper(CREATE_SLOTS), [
      slots,
      createArrayExpression(dynamicSlots)
    ]) as SlotsExpression
  }

  return {
    slots,
    hasDynamicSlots
  }
}

function buildDynamicSlot(
  name: ExpressionNode,
  fn: FunctionExpression
): ObjectExpression {
  return createObjectExpression([
    createObjectProperty(`name`, name),
    createObjectProperty(`fn`, fn)
  ])
}

// 子节点中是否还含有插槽
function hasForwardedSlots(children: TemplateChildNode[]): boolean {
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    switch (child.type) {
      case NodeTypes.ELEMENT:
        if (
          child.tagType === ElementTypes.SLOT ||
          hasForwardedSlots(child.children)
        ) {
          return true
        }
        break
      case NodeTypes.IF:
        if (hasForwardedSlots(child.branches)) return true
        break
      case NodeTypes.IF_BRANCH:
      case NodeTypes.FOR:
        if (hasForwardedSlots(child.children)) return true
        break
      default:
        break
    }
  }
  return false
}

function isNonWhitespaceContent(node: TemplateChildNode): boolean {
  if (node.type !== NodeTypes.TEXT && node.type !== NodeTypes.TEXT_CALL)
    return true
  return node.type === NodeTypes.TEXT
    ? !!node.content.trim()
    : isNonWhitespaceContent(node.content)
}
