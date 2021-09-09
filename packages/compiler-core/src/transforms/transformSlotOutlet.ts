import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  CallExpression,
  createCallExpression,
  ExpressionNode,
  SlotOutletNode,
  createFunctionExpression
} from '../ast'
import { isSlotOutlet, isBindKey, isStaticExp } from '../utils'
import { buildProps, PropsExpression } from './transformElement'
import { createCompilerError, ErrorCodes } from '../errors'
import { RENDER_SLOT } from '../runtimeHelpers'
import { camelize } from '@vue/shared/'

export const transformSlotOutlet: NodeTransform = (node, context) => {
  // 首先确认其为slot元素
  if (isSlotOutlet(node)) {
    const { children, loc } = node

    // 解析slot上的名称与属性
    const { slotName, slotProps } = processSlotOutlet(node, context)

    const slotArgs: CallExpression['arguments'] = [
      context.prefixIdentifiers ? `_ctx.$slots` : `$slots`,
      slotName
    ]

    if (slotProps) {
      slotArgs.push(slotProps)
    }

    // 具有fallback内容
    if (children.length) {
      // 但不具有属性
      if (!slotProps) {
        slotArgs.push(`{}`)
      }

      slotArgs.push(createFunctionExpression([], children, false, false, loc))
    }

    if (context.scopeId && !context.slotted) {
      if (!slotProps) {
        slotArgs.push(`{}`)
      }
      if (!children.length) {
        slotArgs.push(`undefined`)
      }
      slotArgs.push(`true`)
    }

    // 生成调用表达式
    node.codegenNode = createCallExpression(
      context.helper(RENDER_SLOT),
      slotArgs,
      loc
    )
  }
}

interface SlotOutletProcessResult {
  slotName: string | ExpressionNode
  slotProps: PropsExpression | undefined
}

export function processSlotOutlet(
  node: SlotOutletNode,
  context: TransformContext
): SlotOutletProcessResult {
  let slotName: string | ExpressionNode = `"default"`
  let slotProps: PropsExpression | undefined = undefined

  const nonNameProps = []
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]

    // 属性
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.value) {
        // 插槽名称
        if (p.name === 'name') {
          slotName = JSON.stringify(p.value.content)

          // 其余属性，收集起来
        } else {
          p.name = camelize(p.name)
          nonNameProps.push(p)
        }
      }

      // 指令
    } else {
      // 存在name
      if (p.name === 'bind' && isBindKey(p.arg, 'name')) {
        if (p.exp) slotName = p.exp

        // 其余指令
      } else {
        if (p.name === 'bind' && p.arg && isStaticExp(p.arg)) {
          p.arg.content = camelize(p.arg.content)
        }
        nonNameProps.push(p)
      }
    }
  }

  if (nonNameProps.length > 0) {
    // 整理属性和指令
    const { props, directives } = buildProps(node, context, nonNameProps)
    slotProps = props

    // 有指令时报错，逆天
    if (directives.length) {
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET,
          directives[0].loc
        )
      )
    }
  }

  return {
    slotName,
    slotProps
  }
}
